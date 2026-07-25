require("dotenv").config();
const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const mongoose = require("mongoose");
const express = require("express");
const qrcode = require("qrcode");

const app = express();
const port = process.env.PORT || 10000;
let lastQr = "";

app.get("/", async (req, res) => {
  if (lastQr) {
    const url = await qrcode.toDataURL(lastQr);
    res.send(`<h1>Escaneie o QR Code</h1><img src="${url}" />`);
  } else {
    res.send("<h1>Bot Conectado!</h1>");
  }
});
app.listen(port, () => console.log("Servidor web ativo na porta", port));

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    const store = new MongoStore({ mongoose: mongoose });
    const client = new Client({
      authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000,
      }),
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });

    client.on("qr", (qr) => {
      lastQr = qr;
      console.log("QR Gerado. Verifique o seu link do Railway!");
    });
    client.on("ready", () => {
      lastQr = "";
      console.log("Bot pronto!");
    });
    client.initialize().catch((e) => console.error(e));
  })
  .catch((e) => console.error(e));