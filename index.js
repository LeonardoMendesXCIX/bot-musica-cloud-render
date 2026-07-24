const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ==========================================
// CONFIGURAÇÃO DO CLIENTE WHATSAPP (OTIMIZADO PARA WINDOWS)
// ==========================================
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./sessions" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--disable-gpu",
    ],
  },
});

client.on("qr", (qr) => qrcode.generate(qr, { small: true }));
client.on("ready", () =>
  console.log("[WHATSAPP] Cliente pronto! Aguardando comandos..."),
);

// ==========================================
// ESTADO GLOBAL: MENU, FILA E LIMITES
// ==========================================
const userSessions = new Map(); // Guarda as pesquisas temporárias (TTL)
const downloadQueue = []; // Fila de downloads pendentes
let isProcessingQueue = false; // Lock exclusivo para o motor de download
const lastSignatureSent = new Map(); // Guarda o timestamp da última assinatura enviada

const MAX_QUEUE_PER_USER = 3;
const MAX_DURATION_SEC = 420; // 7 minutos
const SIGNATURE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 horas

// ==========================================
// MOTOR DE FILA ASSÍNCRONA
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
    console.log(
      `[PROCESSANDO] Fila restante: ${downloadQueue.length} | Alvo: ${videoTitle}`,
    );

    execSync(command, { stdio: "ignore" });

    if (fs.existsSync(tempFilePath)) {
      const media = MessageMedia.fromFilePath(tempFilePath);
      await client.sendMessage(chatId, media);

      const now = Date.now();
      const lastSent = lastSignatureSent.get(chatId) || 0;
      if (now - lastSent >= SIGNATURE_COOLDOWN_MS) {
        await client.sendMessage(
          chatId,
          "🤖 *Bot desenvolvido por Leandro A.K.A DropHTTP*",
        );
        lastSignatureSent.set(chatId, now);
      }

      if (statusMsg) await statusMsg.delete(true);
    }
  } catch (error) {
    console.error(`[ERRO DOWNLOAD] ${videoTitle}:`, error.message);
    await client.sendMessage(chatId, `❌ Falha ao processar: ${videoTitle}`);
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (err) {}
    }
    isProcessingQueue = false;
    processQueue(); // Aciona recursivamente a próxima tarefa
  }
}

// ==========================================
// INTERCEÇÃO DE MENSAGENS E FRONTEND
// ==========================================
client.on("message_create", async (msg) => {
  const body = msg.body?.trim() || "";
  const chatId = msg.fromMe ? msg.to : msg.from;

  // A. Interceção de Resposta do Menu Numérico
  if (userSessions.has(chatId) && /^([1-9]|10)$/.test(body)) {
    const session = userSessions.get(chatId);
    const selectedIndex = parseInt(body) - 1;

    if (selectedIndex >= session.results.length) {
      await client.sendMessage(
        chatId,
        "❌ Opção inválida. Escolha um número que esteja na lista.",
      );
      return;
    }

    const userPendingTasks = downloadQueue.filter(
      (t) => t.chatId === chatId,
    ).length;
    if (userPendingTasks >= MAX_QUEUE_PER_USER) {
      await client.sendMessage(
        chatId,
        `⚠️ *Limite Atingido:* Possui ${MAX_QUEUE_PER_USER} ficheiros pendentes na fila. Aguarde.`,
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

    const position = downloadQueue.length;
    await client.sendMessage(
      chatId,
      `✅ *Na fila de processamento.* Posição: ${position}`,
    );

    processQueue();
    return;
  }

  // B. Interceção do Comando Base (!play)
  if (!body.toLowerCase().startsWith("!play")) return;

  const query = body.replace(/^!play\s*/i, "").trim();
  if (!query) {
    await client.sendMessage(
      chatId,
      "❌ Sintaxe incorreta. Utilize: !play [nome da música]",
    );
    return;
  }

  if (userSessions.has(chatId)) {
    clearTimeout(userSessions.get(chatId).timeout);
    userSessions.delete(chatId);
  }

  let searchMsg;
  try {
    console.log(`[PESQUISA] Usuário: ${chatId} | Termo: ${query}`);
    searchMsg = await client.sendMessage(chatId, "🔍 *A pesquisar...*");

    // ytsearch15 garante margem para filtrar vídeos maiores que 7min
    const searchCmd = `yt-dlp --print "%(id)s|%(duration)s|%(title)s" --flat-playlist "ytsearch15:${query}"`;
    const searchResult = execSync(searchCmd, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();

    if (!searchResult) {
      throw new Error("Retorno vazio do yt-dlp");
    }

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
        "❌ Nenhuma versão encontrada com menos de 7 minutos.",
      );
      if (searchMsg) await searchMsg.delete(true);
      return;
    }

    let menuText = `🎵 *Selecione uma opção (1-${results.length}):*\n\n`;
    results.forEach((res, index) => {
      const min = Math.floor(res.durationSec / 60);
      const sec = (res.durationSec % 60).toString().padStart(2, "0");
      menuText += `*${index + 1}.* ${res.title} _(${min}:${sec})_\n`;
    });

    const timeout = setTimeout(() => {
      userSessions.delete(chatId);
      client.sendMessage(chatId, "⏳ Sessão expirada.");
    }, 60000);

    userSessions.set(chatId, { results, timeout });
    await client.sendMessage(chatId, menuText);
    if (searchMsg) await searchMsg.delete(true);
  } catch (error) {
    console.error("[ERRO PESQUISA]:", error.message);
    await client.sendMessage(
      chatId,
      "❌ Falha ao comunicar com os servidores de pesquisa.",
    );
    if (searchMsg) await searchMsg.delete(true);
  }
});

process.on("unhandledRejection", (reason) =>
  console.error("[ALERTA] Rejeição assíncrona:", reason),
);
process.on("uncaughtException", (err) =>
  console.error("[FATAL] Exceção crítica:", err),
);

client
  .initialize()
  .catch((err) => console.error("Falha crítica na inicialização:", err));
