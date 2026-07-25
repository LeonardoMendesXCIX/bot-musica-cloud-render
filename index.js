require("dotenv").config();
const { Client, RemoteAuth, MessageMedia } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const mongoose = require("mongoose");
const express = require("express");
const qrcode = require("qrcode"); // Biblioteca nova
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const port = process.env.PORT || 10000;
let lastQrCode = "";

// Rota web que mostra o QR Code ou Status
app.get("/", async (req, res) => {
  if (lastQrCode) {
    const qrImage = await qrcode.toDataURL(lastQrCode);
    res.send(`<h1>Bot de Música</h1><img src="${qrImage}" />`);
  } else {
    res.send("<h1>✅ Servidor Ativo e Conectado!</h1>");
  }
});
app.listen(port, () =>
  console.log(`[HEALTHCHECK] Servidor HTTP ativo na porta ${port}`),
);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("[MONGO] Conectado ao MongoDB!");
    const store = new MongoStore({ mongoose: mongoose });

    const client = new Client({
      authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000,
      }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });

    client.on("qr", (qr) => {
      lastQrCode = qr;
      console.log(
        "⚠️ NOVO QR CODE GERADO. ACESSE A URL DO RENDER PARA ESCANEAR.",
      );
    });

    client.on("ready", () => {
      lastQrCode = "";
      console.log("[WHATSAPP] Cliente pronto!");
    });

    // ... (Manter o restante da lógica de pesquisa e fila que já tinha) ...

    client.initialize();
  })
  .catch((err) => console.error("[MONGO] Erro:", err));
