const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'beautyboss2024';

// Middleware de autenticação
function auth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Estado das sessões
const sessions = {};

async function createSession(userId) {
  if (sessions[userId]?.socket) {
    return sessions[userId];
  }

  const authDir = path.join('./sessions', userId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
  });

  sessions[userId] = {
    socket: sock,
    status: 'connecting',
    qr: null,
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrBase64 = await QRCode.toDataURL(qr);
      sessions[userId].qr = qrBase64;
      sessions[userId].status = 'qr_ready';
    }

    if (connection === 'open') {
      sessions[userId].status = 'connected';
      sessions[userId].qr = null;
      console.log(`✅ Sessão conectada: ${userId}`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log(`🔄 Reconectando sessão: ${userId}`);
        delete sessions[userId];
        createSession(userId);
      } else {
        console.log(`🚪 Sessão encerrada (logout): ${userId}`);
        sessions[userId].status = 'disconnected';
      }
    }
  });

  return sessions[userId];
}

// ── ROTAS ──────────────────────────────────────────────

// Iniciar sessão e obter QR
app.post('/session/start', auth, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId obrigatório' });
  await createSession(userId);
  res.json({ success: true, message: 'Sessão iniciada. Aguarde o QR.' });
});

// Status da sessão
app.get('/session/status/:userId', auth, async (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];
  if (!session) return res.json({ status: 'not_started', qr: null });
  res.json({ status: session.status, qr: session.qr });
});

// Desconectar sessão
app.post('/session/disconnect', auth, async (req, res) => {
  const { userId } = req.body;
  const session = sessions[userId];
  if (session?.socket) {
    await session.socket.logout();
    delete sessions[userId];
  }
  res.json({ success: true });
});

// Enviar mensagem de texto
app.post('/message/send', auth, async (req, res) => {
  const { userId, phone, message } = req.body;
  if (!userId || !phone || !message) {
    return res.status(400).json({ error: 'userId, phone e message são obrigatórios' });
  }

  const session = sessions[userId];
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Sessão não conectada' });
  }

  // Formata número: remove tudo que não é dígito e adiciona @s.whatsapp.net
  const number = phone.replace(/\D/g, '') + '@s.whatsapp.net';

  await session.socket.sendMessage(number, { text: message });
  res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, sessions: Object.keys(sessions).length });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
