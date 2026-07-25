require('dotenv').config();
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const qrcode = require('qrcode');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. Servidor Web (Anti-Sleep e QR Code)
const app = express();
const port = process.env.PORT || 10000;
let lastQrCode = '';

app.get('/', async (req, res) => {
    if (lastQrCode) {
        try {
            const qrImage = await qrcode.toDataURL(lastQrCode);
            res.send(`<html><body style="text-align:center; padding-top:50px;"><h1>Escaneie o QR Code</h1><img src="${qrImage}" /><p>Se não carregar, atualize a página.</p></body></html>`);
        } catch (err) {
            res.status(500).send("Erro ao gerar QR Code");
        }
    } else {
        res.send('<h1>✅ Bot Ativo e Conectado!</h1>');
    }
});
app.listen(port, () => console.log(`[HTTP] Servidor ativo na porta ${port}`));

// 2. Conexão MongoDB e Inicialização do Bot
console.log('[DEBUG] Conectando ao MongoDB...');
mongoose.connect(process.env.MONGO_URI).then(() => {
    console.log('[MONGO] Conectado com sucesso!');
    const store = new MongoStore({ mongoose: mongoose });
    
    const client = new Client({
        authStrategy: new RemoteAuth({ 
            store: store, 
            backupSyncIntervalMs: 300000 
        }),
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
    });

    client.on('qr', (qr) => {
        lastQrCode = qr;
        console.log('[QR] QR Code gerado.');
    });

    client.on('authenticated', () => {
        lastQrCode = '';
        console.log('[WHATSAPP] Autenticado com sucesso!');
    });

    client.on('ready', () => {
        lastQrCode = '';
        console.log('[WHATSAPP] Cliente pronto!');
    });

    // ==========================================
    // LÓGICA DE FILA E MÚSICA
    // ==========================================
    const userSessions = new Map();
    const downloadQueue = [];
    let isProcessingQueue = false;
    const lastSignatureSent = new Map();
    const MAX_QUEUE_PER_USER = 3;
    const MAX_DURATION_SEC = 420;
    const SIGNATURE_COOLDOWN_MS = 4 * 60 * 60 * 1000;

    async function processQueue() {
        if (isProcessingQueue || downloadQueue.length === 0) return;
        isProcessingQueue = true;
        const task = downloadQueue.shift();
        const { chatId, videoId, videoTitle } = task;
        let tempFilePath = '';
        try {
            await client.sendMessage(chatId, `⏳ *A baixar:* ${videoTitle}...`);
            const tmpDir = path.resolve(__dirname, 'tmp-audio');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            tempFilePath = path.join(tmpDir, `audio_${Date.now()}.mp3`);
            
            const command = `yt-dlp -x --audio-format mp3 --audio-quality 128K --no-playlist --extractor-args "youtube:player_client=android" -o "${tempFilePath}" "https://www.youtube.com/watch?v=${videoId}"`;
            execSync(command, { stdio: 'ignore' });

            if (fs.existsSync(tempFilePath)) {
                const media = MessageMedia.fromFilePath(tempFilePath);
                await client.sendMessage(chatId, media);
                
                const now = Date.now();
                const lastSent = lastSignatureSent.get(chatId) || 0;
                if (now - lastSent >= SIGNATURE_COOLDOWN_MS) {
                    await client.sendMessage(chatId, 'Bot de automação desenvolvido por Leandro a.k.a DropHTTP');
                    lastSignatureSent.set(chatId, now);
                }
            }
        } catch (error) {
            console.error(`[ERRO] Falha no download: ${error.message}`);
            await client.sendMessage(chatId, `❌ Erro ao processar: ${videoTitle}`);
        } finally {
            if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            isProcessingQueue = false;
            processQueue();
        }
    }

    client.on('message_create', async (msg) => {
        const body = msg.body?.trim() || '';
        const chatId = msg.fromMe ? msg.to : msg.from;

        if (userSessions.has(chatId) && /^([1-9]|10)$/.test(body)) {
            const session = userSessions.get(chatId);
            const selectedIndex = parseInt(body) - 1;
            if (selectedIndex >= session.results.length) return;
            downloadQueue.push({ chatId, videoId: session.results[selectedIndex].id, videoTitle: session.results[selectedIndex].title });
            clearTimeout(session.timeout);
            userSessions.delete(chatId);
            await client.sendMessage(chatId, `✅ *Adicionado à fila!* Posição: ${downloadQueue.length}`);
            processQueue();
            return;
        }

        if (!body.toLowerCase().startsWith('!play')) return;
        const query = body.replace(/^!play\s*/i, '').trim();
        if (!query) return;

        try {
            const searchCmd = `yt-dlp --extractor-args "youtube:player_client=android" --print "%(id)s|%(duration)s|%(title)s" --flat-playlist "ytsearch15:${query}"`;
            const searchResult = execSync(searchCmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).toString().trim();
            if (!searchResult) return;
            const lines = searchResult.split('\n');
            const results = lines.map(line => {
                const p = line.split('|');
                return { id: p[0], title: p.slice(2).join('|'), durationSec: parseInt(p[1]) };
            }).filter(r => !isNaN(r.durationSec) && r.durationSec <= MAX_DURATION_SEC).slice(0, 10);

            if (results.length === 0) return await client.sendMessage(chatId, '❌ Nenhuma música encontrada.');

            let menu = `🔍 *Resultados:* \n` + results.map((r, i) => `${i + 1}. ${r.title}`).join('\n');
            const timeout = setTimeout(() => { userSessions.delete(chatId); }, 60000);
            userSessions.set(chatId, { results, timeout });
            await client.sendMessage(chatId, menu);
        } catch (error) {
            console.error('[ERRO PESQUISA]:', error.message);
        }
    });

    client.initialize().catch(err => console.error('[FATAL] Erro:', err));
}).catch(err => console.error('[MONGO] Erro crítico na conexão:', err));
```

### Comandos para atualizar:

No seu terminal, digite exatamente isto:

```bash
git add .
git commit -m "Fix: Index completo e limpo"
git push origin main
```

Assim que o Render terminar o deploy, verifique os logs. Se ele disser `[MONGO] Conectado com sucesso!` e depois `[WHATSAPP] Cliente pronto!`, o bot está finalmente estável. 🚀