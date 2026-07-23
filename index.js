require("dotenv").config();
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ==========================================
// 1. Servidor Express (Anti-Sleep e QR Code Web)
// ==========================================
const app = express();
const port = process.env.PORT || 10000;
let lastQrCode = ""; // Variável para guardar o QR Code

app.get("/", (req, res) => {
  if (lastQrCode) {
    // Gera uma imagem limpa usando uma API pública e gratuita
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(lastQrCode)}`;
    res.send(`
            <html>
                <body style="display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #121212; margin: 0; font-family: Arial, sans-serif;">
                    <div style="text-align: center; color: white;">
                        <h2>📱 Escaneie o QR Code</h2>
                        <p>Aponte o WhatsApp do seu telemóvel para a imagem abaixo:</p>
                        <img src="${qrImageUrl}" alt="WhatsApp QR Code" style="border: 10px solid white; border-radius: 10px; margin: 20px;" />
                        <p style="color: #888;">A página não atualiza sozinha. Se o código no ecrã expirar, recarregue a página (F5).</p>
                    </div>
                </body>
            </html>
        `);
  } else {
    res.status(200).send(`
            <html>
                <body style="display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #121212; margin: 0; font-family: Arial, sans-serif;">
                    <div style="text-align: center; color: white;">
                        <h2 style="color: #4CAF50;">✅ Servidor Ativo e Conectado!</h2>
                        <p>O bot está pronto para receber comandos no WhatsApp.</p>
                    </div>
                </body>
            </html>
        `);
  }
});

app.listen(port, () =>
  console.log(`[HEALTHCHECK] Servidor HTTP ativo na porta ${port}`),
);

// ==========================================
// 2. Inicialização do Cliente do WhatsApp
// ==========================================
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./sessions" }),
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
  lastQrCode = qr; // Guarda o QR Code para mostrar no site
  console.log("==================================================");
  console.log("⚠️ NOVO QR CODE GERADO!");
  console.log(
    "👉 ACESSE O SEU SITE PARA ESCANEAR: https://bot-musica-cloud.onrender.com",
  );
  console.log("==================================================");
});

client.on("authenticated", () => {
  lastQrCode = ""; // Limpa o QR Code do site após conectar
  console.log("[WHATSAPP] Autenticado com sucesso!");
});

client.on("auth_failure", (msg) => {
  console.error("[WHATSAPP] Falha na autenticação:", msg);
});

client.on("ready", () => console.log("[WHATSAPP] Cliente pronto!"));

// ==========================================
// 3. ESTADO GLOBAL: MENU, FILA E LIMITES
// ==========================================
const userSessions = new Map(); // Guarda as pesquisas temporárias (TTL)
const downloadQueue = []; // Fila de downloads pendentes
let isProcessingQueue = false; // Lock exclusivo para o motor de download
const lastSignatureSent = new Map(); // Guarda o timestamp da última assinatura enviada por chat

const MAX_QUEUE_PER_USER = 3; // Máximo de músicas na fila por pessoa
const MAX_DURATION_SEC = 420; // 7 minutos
const SIGNATURE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 horas em milissegundos

// ==========================================
// 4. MOTOR DE FILA ASSÍNCRONA (PROCESSA EM BACKGROUND)
// ==========================================
async function processQueue() {
  if (isProcessingQueue || downloadQueue.length === 0) return;

  isProcessingQueue = true;
  const task = downloadQueue.shift(); // Tira o primeiro da fila
  const { chatId, videoId, videoTitle } = task;

  let tempFilePath = "";
  let statusMsg;

  try {
    statusMsg = await client.sendMessage(
      chatId,
      `⏳ *A baixar a tua música da fila:* ${videoTitle}...`,
    );

    const tmpDir = path.resolve(__dirname, "tmp-audio");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    tempFilePath = path.join(tmpDir, `audio_${Date.now()}.mp3`);

    // Executa o download real
    const command = `yt-dlp -x --audio-format mp3 --audio-quality 128K --no-playlist --extractor-args "youtube:player_client=android" -o "${tempFilePath}" "https://www.youtube.com/watch?v=${videoId}"`;
    console.log(`[DOWNLOAD] A processar: ${videoTitle}`);

    execSync(command, { stdio: "ignore" });

    if (fs.existsSync(tempFilePath)) {
      const media = MessageMedia.fromFilePath(tempFilePath);
      await client.sendMessage(chatId, media);

      // Controle de Cooldown da Assinatura (4 horas)
      const now = Date.now();
      const lastSent = lastSignatureSent.get(chatId) || 0;
      if (now - lastSent >= SIGNATURE_COOLDOWN_MS) {
        await client.sendMessage(
          chatId,
          "Bot de automação desenvolvido por Leandro a.k.a DropHTTP",
        );
        lastSignatureSent.set(chatId, now); // Atualiza a hora do último envio
      }

      if (statusMsg) await statusMsg.delete(true);
    }
  } catch (error) {
    console.error(`[ERRO DOWNLOAD] ${videoTitle}:`, error.message);
    await client.sendMessage(
      chatId,
      `❌ Ocorreu um erro ao baixar: ${videoTitle}`,
    );
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (err) {}
    }
    isProcessingQueue = false;
    processQueue(); // Chama o próximo da fila!
  }
}

// ==========================================
// 5. INTERCEÇÃO DE MENSAGENS (FRONTEND DO BOT)
// ==========================================
client.on("message_create", async (msg) => {
  const body = msg.body?.trim() || "";
  const chatId = msg.fromMe ? msg.to : msg.from;

  // Log de diagnóstico para o terminal
  if (body.toLowerCase().startsWith("!play")) {
    console.log(`[DEBUG] Comando recebido: ${body}`);
  }

  // A. Interceção de Resposta do Menu Numérico (1 a 10)
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

    // Verifica Limite de Abuso na Fila
    const userPendingTasks = downloadQueue.filter(
      (t) => t.chatId === chatId,
    ).length;
    if (userPendingTasks >= MAX_QUEUE_PER_USER) {
      await client.sendMessage(
        chatId,
        `⚠️ *Limite Atingido:* Já tens ${MAX_QUEUE_PER_USER} músicas na fila de espera. Aguarda que sejam entregues antes de pedir mais.`,
      );
      return;
    }

    const selectedVideo = session.results[selectedIndex];

    // Adiciona à fila de processamento
    downloadQueue.push({
      chatId: chatId,
      videoId: selectedVideo.id,
      videoTitle: selectedVideo.title,
    });

    // Limpa a sessão
    clearTimeout(session.timeout);
    userSessions.delete(chatId);

    // Dá feedback de fila
    const position = downloadQueue.length;
    await client.sendMessage(
      chatId,
      `✅ *Adicionado à fila!* Posição atual: ${position}\nO áudio será enviado assim que for processado.`,
    );

    // Acorda a fila (se estiver parada)
    processQueue();
    return;
  }

  // B. Interceção do Comando Base
  if (!body.toLowerCase().startsWith("!play")) return;

  const query = body.replace(/^!play\s*/i, "").trim();
  if (!query) {
    await client.sendMessage(
      chatId,
      "❌ Por favor, informe o nome da música ou artista. Exemplo: !play in the end linkin park",
    );
    return;
  }

  // Se fizer nova pesquisa, apaga a anterior
  if (userSessions.has(chatId)) {
    clearTimeout(userSessions.get(chatId).timeout);
    userSessions.delete(chatId);
  }

  let searchMsg;
  try {
    searchMsg = await client.sendMessage(
      chatId,
      "🔍 *A procurar no YouTube...*",
    );

    // Pede 15 resultados com timeout de 20s e bypass do YouTube (player_client=android)
    const searchCmd = `yt-dlp --extractor-args "youtube:player_client=android" --print "%(id)s|%(duration)s|%(title)s" --flat-playlist "ytsearch15:${query}"`;
    const searchResult = execSync(searchCmd, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
    })
      .toString()
      .trim();

    if (!searchResult) {
      await client.sendMessage(chatId, "❌ Nenhum resultado encontrado.");
      if (searchMsg) await searchMsg.delete(true);
      return;
    }

    const lines = searchResult.split("\n");
    const results = [];

    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length >= 3) {
        const id = parts[0];
        const duration = parts[1]; // Duração em segundos, pode vir 'NA' em lives
        const title = parts.slice(2).join("|");

        // Validações de Tempo
        if (duration === "NA" || !duration) continue; // Ignora transmissões ao vivo
        const durationSec = parseInt(duration, 10);
        if (isNaN(durationSec) || durationSec > MAX_DURATION_SEC) continue; // Ignora maiores que 7 minutos

        results.push({ id, title, durationSec });
        if (results.length === 10) break; // Trava no máximo em 10
      }
    }

    if (results.length === 0) {
      await client.sendMessage(
        chatId,
        "❌ Todas as versões encontradas excedem o limite de 7 minutos de duração.",
      );
      if (searchMsg) await searchMsg.delete(true);
      return;
    }

    let menuText = `🔍 *Encontrei ${results.length} resultados (Menos de 7 min):*\n\n`;
    results.forEach((res, index) => {
      // Converte segundos para mm:ss
      const min = Math.floor(res.durationSec / 60);
      const sec = (res.durationSec % 60).toString().padStart(2, "0");
      menuText += `*${index + 1}.* ${res.title} _(${min}:${sec})_\n`;
    });

    menuText += `\n👉 *Responda com um número de 1 a ${results.length} para baixar.*`;

    // Timeout de 60s
    const timeout = setTimeout(() => {
      userSessions.delete(chatId);
      client.sendMessage(
        chatId,
        "⏳ O menu de escolha expirou. Envie !play novamente.",
      );
    }, 60000);

    userSessions.set(chatId, { results, timeout });
    await client.sendMessage(chatId, menuText);
    if (searchMsg) await searchMsg.delete(true);
  } catch (error) {
    console.error("\n[ERRO NA PESQUISA]:", error.message);
    await client.sendMessage(
      chatId,
      "❌ Erro ao procurar a música. O YouTube pode estar a bloquear temporariamente (Timeout/403).",
    );
    if (searchMsg) await searchMsg.delete(true);
  }
});

// Prevenção de quebras globais
process.on("unhandledRejection", (reason) =>
  console.error("[SISTEMA] Rejeição não tratada:", reason),
);
process.on("uncaughtException", (err) =>
  console.error("[SISTEMA] Exceção não capturada:", err),
);

client
  .initialize()
  .catch((err) => console.error("Erro na inicialização:", err));
