require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');

const app = express();
app.get('/', (req, res) => res.send('Bot Online (Sem Mongo)'));
app.listen(process.env.PORT || 10000);

console.log('[DEBUG] Iniciando Client com LocalAuth...');
const client = new Client({
    authStrategy: new LocalAuth(), // Removemos o MongoDB temporariamente
    puppeteer: {
        headless: true,
        executablePath: '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('[QR] QR Code gerado! (Verifica os logs do Render para o ASCII)');
    qrcode.generate(qr, { small: true }); // Mostra no log do Render
});

client.on('authenticated', () => console.log('[WHATSAPP] Autenticado com sucesso!'));
client.on('ready', () => console.log('[WHATSAPP] Cliente pronto!'));
client.on('message_create', (msg) => console.log('[MSG] Mensagem:', msg.body));
client.on('auth_failure', (err) => console.error('[FATAL] Auth failure:', err));

client.initialize().catch(err => console.error('[FATAL] Erro init:', err));