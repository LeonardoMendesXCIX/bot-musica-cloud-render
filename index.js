require("dotenv").config();
const { Client, RemoteAuth, MessageMedia } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const mongoose = require("mongoose");
const express = require("express");
const qrcode = require("qrcode");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- SERVIDOR WEB (Visualizar QR Code) ---
const app = express();
const port = process.env.PORT || 10000;
let lastQrCode = "";

app.get("/", async (req, res) => {
  if (lastQrCode) {
    try {
      const qrImage = await qrcode.toDataURL(lastQrCode);
      res.send(
        `<html><body style="text-align:center; padding-top:50px;"><h1>Escaneie o QR Code</h1><img src="${qrImage}" /></body></html>`,
      );
    } catch (err) {
      res.status(500).send("Erro ao gerar QR Code");
    }
  } else {
    res.send("<h1>✅ Bot Ativo e Conectado!</h1>");
  }
});
app.listen(port, () => console.log(`[HTTP] Servidor ativo na porta ${port}`));

// --- BOT WHATSAPP ---
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("[MONGO] Conectado com sucesso!");
    const store = new MongoStore({ mongoose: mongoose });

    const client = new Client({
      authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000,
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      },
    });

    client.on("qr", (qr) => {
      lastQrCode = qr;
      console.log("[QR] QR Code gerado.");
    });

    client.on("ready", () => {
      lastQrCode = "";
      console.log("[WHATSAPP] Cliente pronto!");
    });

    const downloadQueue = [];
    let isProcessingQueue = false;

    async function processQueue() {
      if (isProcessingQueue || downloadQueue.length === 0) return;
      isProcessingQueue = true;
      const task = downloadQueue.shift();
      const { chatId, videoId, videoTitle } = task;
      let tempFilePath = "";
      try {
        await client.sendMessage(chatId, `⏳ *A baixar:* ${videoTitle}...`);
        const tmpDir = path.resolve(__dirname, "tmp-audio");
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        tempFilePath = path.join(tmpDir, `audio_${Date.now()}.mp3`);

        // Comando com bypass do YouTube
        const command = `yt-dlp -x --audio-format mp3 --audio-quality 128K --no-playlist --extractor-args "youtube:player_client=android" -o "${tempFilePath}" "https://www.youtube.com/watch?v=${videoId}"`;
        execSync(command, { stdio: "ignore" });

        if (fs.existsSync(tempFilePath)) {
          const media = MessageMedia.fromFilePath(tempFilePath);
          await client.sendMessage(chatId, media);
          await client.sendMessage(
            chatId,
            "Bot de automação desenvolvido por Leandro a.k.a DropHTTP",
          );
        }
      } catch (error) {
        console.error(`[ERRO] Falha no download: ${error.message}`);
      } finally {
        if (tempFilePath && fs.existsSync(tempFilePath))
          fs.unlinkSync(tempFilePath);
        isProcessingQueue = false;
        processQueue();
      }
    }

    client.on("message_create", async (msg) => {
      const body = msg.body?.trim() || "";
      if (!body.toLowerCase().startsWith("!play")) return;

      const query = body.replace(/^!play\s*/i, "").trim();
      if (!query) return;

      const chatId = msg.fromMe ? msg.to : msg.from;

      try {
        const searchCmd = `yt-dlp --extractor-args "youtube:player_client=android" --print "%(id)s|%(title)s" --flat-playlist "ytsearch1:${query}"`;
        const result = execSync(searchCmd).toString().trim();
        if (!result) return client.sendMessage(chatId, "❌ Nada encontrado.");

        const [id, title] = result.split("|");
        downloadQueue.push({ chatId, videoId: id, videoTitle: title });
        await client.sendMessage(chatId, `✅ *Adicionado à fila:* ${title}`);
        processQueue();
      } catch (e) {
        console.error(e);
      }
    });

    client.initialize().catch((err) => console.error("[FATAL] Erro:", err));
  })
  .catch((err) => console.error("[MONGO] Erro na conexão:", err));
