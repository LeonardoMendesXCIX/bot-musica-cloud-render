require('dotenv').config();
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const qrcode = require('qrcode');

const app = express();
const port = process.env.PORT || 10000;
let lastQrCode = '';

app.get('/', async (req, res) => {
    if (lastQrCode) {
        try {
            const qrImage = await qrcode.toDataURL(lastQrCode);
            res.send(`<h1>Bot de Música</h1><img src="${qrImage}" />`);
        } catch (err) { res.status(500).send("Erro QR"); }
    } else {
        res.send('<h1>Bot Online e Autenticado</h1>');
    }
});
app.listen(port, () => console.log('[HTTP] Server OK'));

mongoose.connect(process.env.MONGO_URI).then(() => {
    console.log('[MONGO] Conectado!');
    const store = new MongoStore({ mongoose: mongoose });
    
    console.log('[CLIENT] Iniciando...');
    const client = new Client({
        authStrategy: new RemoteAuth({ store: store, backupSyncIntervalMs: 300000 }),
        puppeteer: {
            headless: true,
            executablePath: '/usr/bin/chromium',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        lastQrCode = qr;
        console.log('[QR] QR Gerado! Verifique a página web.');
    });

    client.on('authenticated', () => console.log('[WHATSAPP] Autenticação feita!'));
    client.on('ready', () => { 
        lastQrCode = ''; 
        console.log('[WHATSAPP] Cliente pronto!'); 
    });
    
    client.on('disconnected', (reason) => console.log('[WHATSAPP] Desconectado:', reason));
    client.on('message_create', (msg) => console.log('[MSG] Mensagem recebida:', msg.body));

    console.log('[CLIENT] initialize() vai ser chamado agora...');
    client.initialize().catch(e => console.error('[FATAL] Erro initialize:', e));

}).catch(err => console.error('[MONGO] Erro conexão:', err));