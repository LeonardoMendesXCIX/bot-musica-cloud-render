const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const util = require("util");

const execPromise = util.promisify(exec);

const sessionsPath = path.resolve(__dirname, "sessions");

// ==========================================
// 1. SERVIDOR WEB (QR CODE E HEALTHCHECK)
// ==========================================
const app = express();
const port = process.env.PORT || 10000;
let lastQrCode = "";
let isConnected = false;

app.get("/", async (req, res) => {
  if (isConnected) {
    return res.send(
      '<h1 style="color:green; text-align:center; font-family:sans-serif; margin-top:50px;">✅ Servidor Ativo e Bot Conectado</h1>',
    );
  }

  if (lastQrCode) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(lastQrCode)}`;
    return res.send(`
                <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
                    <h2>Escaneie o QR Code</h2>
                    <img src="${qrUrl}" style="width:300px; height:300px; border:1px solid #ccc; border-radius:10px;">
                    <p><small>A página atualizará automaticamente...</small></p>
                    <script>setTimeout(() => window.location.reload(), 5000);</script>
                </div>
            `);
  }

  res.send(
    '<h3 style="text-align:center; font-family:sans-serif; margin-top:50px;">⏳ Aguardando geração do QR Code...</h3><script>setTimeout(() => window.location.reload(), 3000);</script>',
  );
});

app.listen(port, () => console.log(`[REDE] Servidor HTTP na porta ${port}`));

// ==========================================
// 2. ESTADO E REGRAS DE NEGÓCIO
// ==========================================
const userSessions = new Map();
const downloadQueue = [];
let isProcessingQueue = false;
const lastSignatureSent = new Map();

const MAX_QUEUE_PER_USER = 3;
const MAX_DURATION_SEC = 420; // 7 minutos
const SIGNATURE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 horas

// ==========================================
// 3. CONFIGURAÇÃO DO CLIENTE WHATSAPP
// ==========================================
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./sessions" }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-extensions",
      "--single-process",
      "--memory-pressure-off",
      "--disable-accelerated-2d-canvas",
    ],
  },
});

client.on("qr", (qr) => {
  console.log("[SISTEMA] Novo QR Code gerado. Aceda ao endpoint web.");
  lastQrCode = qr;
});

client.on("authenticated", () =>
  console.log("[DEBUG-AUTH] Autenticado com sucesso!"),
);

client.on("auth_failure", (msg) => console.error("[DEBUG-AUTH] Falha:", msg));

client.on("loading_screen", (percent, message) =>
  console.log("[DEBUG-LOADING]", percent, message),
);

client.on("ready", () => {
  console.log("[SISTEMA] Cliente WhatsApp estabilizado e pronto.");
  isConnected = true;
  lastQrCode = "";
});

client.on("disconnected", () => {
  isConnected = false;
});

// ==========================================
// 4. MOTOR ASSÍNCRONO DE DOWNLOAD
// ==========================================
async function processQueue() {
  if (isProcessingQueue || downloadQueue.length === 0) return;

  isProcessingQueue = true;
  const task = downloadQueue.shift();
  const { chatId, videoId, videoTitle } = task;

  let tempFilePath = "";
  let statusMsg;

  try {
    statusMsg = await client.sendMessage(
      chatId,
      `⏳ *A processar:* ${videoTitle}...`,
    );

    const tmpDir = path.resolve(__dirname, "tmp-audio");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    tempFilePath = path.join(tmpDir, `audio_${Date.now()}.mp3`);

    const command = `yt-dlp -x --audio-format mp3 --audio-quality 5 --no-playlist -o "${tempFilePath}" "https://www.youtube.com/watch?v=${videoId}"`;

    // Uso de exec Promise evita bloqueio da Thread principal do Node
    await execPromise(command);

    if (fs.existsSync(tempFilePath)) {
      const media = MessageMedia.fromFilePath(tempFilePath);
      await client.sendMessage(chatId, media);

      const now = Date.now();
      const lastSent = lastSignatureSent.get(chatId) || 0;
      if (now - lastSent >= SIGNATURE_COOLDOWN_MS) {
        await client.sendMessage(
          chatId,
          "🤖 *Bot de automação | Leonardo Mendes*",
        );
        lastSignatureSent.set(chatId, now);
      }
      if (statusMsg) await statusMsg.delete(true);
    }
  } catch (error) {
    console.error(
      `[ERRO] Falha no processamento de ${videoTitle}:`,
      error.message,
    );
    await client.sendMessage(chatId, `❌ Falha ao processar: ${videoTitle}`);
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (err) {}
    }
    isProcessingQueue = false;
    processQueue(); // Aciona recursividade para o próximo da fila
  }
}

// ==========================================
// 5. MÁQUINA DE ESTADOS E COMANDOS
// ==========================================
client.on("message_create", async (msg) => {
  const body = msg.body?.trim() || "";
  const chatId = msg.fromMe ? msg.to : msg.from;

  if (userSessions.has(chatId) && /^([1-9]|10)$/.test(body)) {
    const session = userSessions.get(chatId);
    const selectedIndex = parseInt(body) - 1;

    if (selectedIndex >= session.results.length) {
      await client.sendMessage(chatId, "❌ Opção inválida.");
      return;
    }

    const userPendingTasks = downloadQueue.filter(
      (t) => t.chatId === chatId,
    ).length;
    if (userPendingTasks >= MAX_QUEUE_PER_USER) {
      await client.sendMessage(
        chatId,
        `⚠️ Limite atingido (${MAX_QUEUE_PER_USER} ficheiros pendentes).`,
      );
      return;
    }

    const selectedVideo = session.results[selectedIndex];
    downloadQueue.push({
      chatId: chatId,
      videoId: selectedVideo.id,
      videoTitle: selectedVideo.title,
    });

    clearTimeout(session.timeout);
    userSessions.delete(chatId);

    await client.sendMessage(
      chatId,
      `✅ *Na fila de processamento.* (Posição: ${downloadQueue.length})`,
    );
    processQueue();
    return;
  }

  if (!body.toLowerCase().startsWith("!play")) return;

  const query = body.replace(/^!play\s*/i, "").trim();
  if (!query) {
    await client.sendMessage(chatId, "❌ Sintaxe incorreta: !play [nome]");
    return;
  }

  if (userSessions.has(chatId)) {
    clearTimeout(userSessions.get(chatId).timeout);
    userSessions.delete(chatId);
  }

  let searchMsg;
  try {
    searchMsg = await client.sendMessage(chatId, "🔍 *A pesquisar...*");

    const searchCmd = `yt-dlp --print "%(id)s|%(duration)s|%(title)s" --flat-playlist "ytsearch15:${query}"`;
    const { stdout } = await execPromise(searchCmd, { timeout: 20000 });
    const searchResult = stdout.trim();

    if (!searchResult) throw new Error("Retorno vazio.");

    const lines = searchResult.split("\n");
    const results = [];

    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length >= 3) {
        const id = parts[0];
        const duration = parts[1];
        const title = parts.slice(2).join("|");

        if (duration === "NA" || !duration) continue;
        const durationSec = parseInt(duration, 10);
        if (isNaN(durationSec) || durationSec > MAX_DURATION_SEC) continue;

        results.push({ id, title, durationSec });
        if (results.length === 10) break;
      }
    }

    if (results.length === 0) {
      await client.sendMessage(
        chatId,
        "❌ Nenhuma versão encontrada dentro do limite (7 min).",
      );
      if (searchMsg) await searchMsg.delete(true);
      return;
    }

    let menuText = `🎵 *Resultados (1-${results.length}):*\n\n`;
    results.forEach((res, index) => {
      const min = Math.floor(res.durationSec / 60);
      const sec = (res.durationSec % 60).toString().padStart(2, "0");
      menuText += `*${index + 1}.* ${res.title} _(${min}:${sec})_\n`;
    });

    const timeout = setTimeout(() => {
      userSessions.delete(chatId);
      client.sendMessage(chatId, "⏳ Sessão de pesquisa expirada.");
    }, 60000);

    userSessions.set(chatId, { results, timeout });
    await client.sendMessage(chatId, menuText);
    if (searchMsg) await searchMsg.delete(true);
  } catch (error) {
    console.error("[ERRO PESQUISA]:", error.message);
    await client.sendMessage(chatId, "❌ Falha ao processar pesquisa.");
    if (searchMsg) await searchMsg.delete(true);
  }
});

process.on("unhandledRejection", (reason) =>
  console.error("[ALERTA] Rejeição assíncrona:", reason),
);
process.on("uncaughtException", (err) =>
  console.error("[FATAL] Exceção crítica:", err),
);

setTimeout(() => {
  try {
    if (!fs.existsSync(sessionsPath)) {
      fs.mkdirSync(sessionsPath, { recursive: true });
      console.log("[DEBUG-INIT] Pasta sessions criada:", sessionsPath);
    } else {
      console.log("[DEBUG-INIT] Pasta sessions encontrada:", sessionsPath);
    }

    fs.accessSync(sessionsPath, fs.constants.W_OK);
    console.log("[DEBUG-INIT] Permissão de escrita OK em sessions.");
  } catch (err) {
    console.error(
      "[DEBUG-INIT] Erro ao validar pasta sessions (escrita/existência):",
      err.message,
    );
  }

  client
    .initialize()
    .catch((err) => console.error("Falha na inicialização:", err));
}, 5000);
