require("dotenv").config();
const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const mongoose = require("mongoose");
const express = require("express");
const qrcode = require("qrcode");

const app = express();
app.get("/", (req, res) => res.send("Bot Online"));
app.listen(process.env.PORT || 10000);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("[MONGO] Conectado!");
    const store = new MongoStore({ mongoose: mongoose });

    const client = new Client({
      authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000,
      }),
      puppeteer: {
        headless: true,
        executablePath: "/usr/bin/chromium",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      },
    });

    client.on("qr", (qr) => console.log("[QR] Gerado (veja na página web)"));
    client.on("ready", () => console.log("[WHATSAPP] Cliente pronto!"));
    client.on("authenticated", () => console.log("[WHATSAPP] Autenticado!"));

    client.initialize().catch((err) => console.error("[FATAL] Erro:", err));
  })
  .catch((err) => console.error("[MONGO] Erro:", err));
