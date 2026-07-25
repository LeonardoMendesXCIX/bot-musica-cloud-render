require("dotenv").config();
const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const mongoose = require("mongoose");

console.log("[DEBUG] Iniciando bot...");

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
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        // Removemos o executablePath para o Railway usar o dele automaticamente
      },
    });

    client.on("qr", (qr) =>
      console.log("QR_CODE_START:" + qr + ":QR_CODE_END"),
    );
    client.on("ready", () => console.log("[WHATSAPP] Cliente pronto!"));
    client.on("authenticated", () => console.log("[WHATSAPP] Autenticado!"));

    client.initialize().catch((err) => console.error("[FATAL] Erro:", err));
  })
  .catch((err) => console.error("[MONGO] Erro:", err));
