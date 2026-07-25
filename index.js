require("dotenv").config();
const { Client, RemoteAuth, MessageMedia } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const mongoose = require("mongoose");
const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// 1. Servidor Express (Anti-Sleep)
const app = express();
const port = process.env.PORT || 10000;
app.get("/", (req, res) => res.status(200).send("Servidor Ativo"));
app.listen(port, () =>
  console.log(`[HEALTHCHECK] Servidor HTTP ativo na porta ${port}`),
);

// 2. Conexão MongoDB e RemoteAuth
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("[MONGO] Conectado ao MongoDB com sucesso!");
    const store = new MongoStore({ mongoose: mongoose });

    const client = new Client({
      authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000, // 5 minutos
      }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
        ],
      },
    });

    client.on("qr", (qr) => {
      console.log("==================================================");
      console.log("⚠️ NOVO QR CODE GERADO! ACESSE SEU URL DO RENDER.");
      console.log("==================================================");
    });

    client.on("ready", () => console.log("[WHATSAPP] Cliente pronto!"));
    client.on("remote_session_saved", () =>
      console.log("[MONGO] Sessão guardada na nuvem!"),
    );

    // ==========================================
    // ESTADO GLOBAL
    // ==========================================
    const userSessions = new Map();
    const downloadQueue = [];
    let isProcessingQueue = false;
    const lastSignatureSent = new Map();
    const MAX_QUEUE_PER_USER = 3;
    const MAX_DURATION_SEC = 420;
    const SIGNATURE_COOLDOWN_MS = 4 * 60 * 60 * 1000;

    // ==========================================
    // MOTOR DE FILA ASSÍNCRONA
    // ==========================================
    async function processQueue() {
      if (isProcessingQueue || downloadQueue.length === 0) return;
      isProcessingQueue = true;
      const task = downloadQueue.shift();
      const { chatId, videoId, videoTitle } = task;
      let tempFilePath = "";

      try {
        const tmpDir = path.resolve(__dirname, "tmp-audio");
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        tempFilePath = path.join(tmpDir, `audio_${Date.now()}.mp3`);

        const command = `yt-dlp -x --audio-format mp3 --audio-quality 128K --no-playlist --extractor-args "youtube:player_client=android" -o "${tempFilePath}" "https://www.youtube.com/watch?v=${videoId}"`;
        execSync(command, { stdio: "ignore" });

        if (fs.existsSync(tempFilePath)) {
          const media = MessageMedia.fromFilePath(tempFilePath);
          await client.sendMessage(chatId, media);
          const now = Date.now();
          const lastSent = lastSignatureSent.get(chatId) || 0;
          if (now - lastSent >= SIGNATURE_COOLDOWN_MS) {
            await client.sendMessage(
              chatId,
              "Bot de automação desenvolvido por Leandro a.k.a DropHTTP",
            );
            lastSignatureSent.set(chatId, now);
          }
        }
      } catch (error) {
        console.error(`[ERRO DOWNLOAD] ${videoTitle}:`, error.message);
      } finally {
        if (tempFilePath && fs.existsSync(tempFilePath))
          try {
            fs.unlinkSync(tempFilePath);
          } catch (err) {}
        isProcessingQueue = false;
        processQueue();
      }
    }

    // ==========================================
    // INTERCEÇÃO DE MENSAGENS
    // ==========================================
    client.on("message_create", async (msg) => {
      const body = msg.body?.trim() || "";
      const chatId = msg.fromMe ? msg.to : msg.from;

      if (userSessions.has(chatId) && /^([1-9]|10)$/.test(body)) {
        const session = userSessions.get(chatId);
        const selectedIndex = parseInt(body) - 1;
        if (selectedIndex < session.results.length) {
          downloadQueue.push({
            chatId,
            videoId: session.results[selectedIndex].id,
            videoTitle: session.results[selectedIndex].title,
          });
          clearTimeout(session.timeout);
          userSessions.delete(chatId);
          await client.sendMessage(chatId, `✅ Adicionado à fila!`);
          processQueue();
        }
        return;
      }

      if (!body.toLowerCase().startsWith("!play")) return;
      const query = body.replace(/^!play\s*/i, "").trim();
      if (!query) return;

      try {
        const searchCmd = `yt-dlp --extractor-args "youtube:player_client=android" --print "%(id)s|%(duration)s|%(title)s" --flat-playlist "ytsearch15:${query}"`;
        const searchResult = execSync(searchCmd, {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 20000,
        })
          .toString()
          .trim();
        if (!searchResult) return;

        const results = searchResult
          .split("\n")
          .map((line) => {
            const [id, duration, ...title] = line.split("|");
            return {
              id,
              title: title.join("|"),
              durationSec: parseInt(duration),
            };
          })
          .filter(
            (r) => !isNaN(r.durationSec) && r.durationSec <= MAX_DURATION_SEC,
          )
          .slice(0, 10);

        let menuText = `🔍 *Encontrei ${results.length} resultados:*\n\n`;
        results.forEach((res, i) => (menuText += `*${i + 1}.* ${res.title}\n`));

        const timeout = setTimeout(() => userSessions.delete(chatId), 60000);
        userSessions.set(chatId, { results, timeout });
        await client.sendMessage(chatId, menuText);
      } catch (e) {
        console.error(e);
      }
    });

    client.initialize();
  })
  .catch((err) => console.error("[MONGO] Erro na conexão:", err));
