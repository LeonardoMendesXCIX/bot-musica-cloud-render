require("dotenv").config();
const { Client, RemoteAuth, MessageMedia } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const mongoose = require("mongoose");
const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");

const app = express();
app.get("/", (req, res) => res.send("Bot Vivo"));
app.listen(process.env.PORT || 10000, () => console.log("Servidor Web Ativo"));

console.log("[DEBUG] O script iniciou.");

if (!process.env.MONGO_URI) {
  console.error(
    "[ERRO FATAL] MONGO_URI não encontrada nas variáveis de ambiente!",
  );
  process.exit(1);
} else {
  console.log("[DEBUG] MONGO_URI encontrada e carregada.");
}

// Heartbeat: Imprime a cada 10s para saber se o bot não "morreu"
setInterval(() => console.log("[HEARTBEAT] O bot está vivo..."), 10000);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("[MONGO] Conectado com sucesso!");
    const store = new MongoStore({ mongoose: mongoose });

    console.log("[DEBUG] Iniciando Client...");
    const client = new Client({
      authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000,
      }),
      puppeteer: {
        headless: true,
        executablePath: "/usr/bin/google-chrome-stable",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });

    client.on("qr", (qr) =>
      console.log(
        "[QR] QR Code gerado. (Verificar log para ver se chega aqui)",
      ),
    );
    client.on("authenticated", () => console.log("[WHATSAPP] Autenticado!"));
    client.on("ready", () => console.log("[WHATSAPP] Cliente pronto!"));
    client.on("auth_failure", (e) => console.error("[FATAL] Auth failure:", e));

    console.log("[DEBUG] Chamando initialize()...");
    client
      .initialize()
      .catch((err) => console.error("[FATAL] Erro no initialize:", err));
  })
  .catch((err) => console.error("[MONGO] Erro na conexão:", err));