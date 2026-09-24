const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

const BOT_NAME = 'Queen Diana';
const PREFIX = '.';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'sessions');
const sockets = new Map();
const connected = new Set();

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// ---------- start a bot for one number ----------
async function startBot(number, res) {
  const dir = path.join(SESSION_DIR, number);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false
  });

  sockets.set(number, sock);
  sock.ev.on('creds.update', saveCreds);

  // request pair code if not registered yet
  if (!sock.authState.creds.registered && res) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(number);
        res.json({ success: true, code: code.match(/.{1,4}/g).join('-') });
      } catch (e) {
        console.error(`[${number}] pair error:`, e.message);
        if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to get code' });
      }
    }, 3000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      connected.add(number);
      console.log(`[${number}] connected`);
    }
    if (connection === 'close') {
      connected.delete(number);
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(dir, { recursive: true, force: true });
        sockets.delete(number);
      } else {
        startBot(number); // reconnect
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    handleMessage(sock, messages[0]).catch(e => console.error('handler error:', e.message));
  });
}

// ---------- command handler ----------
async function handleMessage(sock, m) {
  if (!m?.message) return;
  const from = m.key.remoteJid;
  if (!from || from === 'status@broadcast') return;

  const isGroup = from.endsWith('@g.us');
  const sender = m.key.participant || from;
  const text =
    m.message.conversation ||
    m.message.extendedTextMessage?.text ||
    m.message.imageMessage?.caption || '';

  if (!text.startsWith(PREFIX)) return;
  const [cmd, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
  const command = cmd.toLowerCase();

  const reply = (t, mentions = []) =>
    sock.sendMessage(from, { text: t, mentions }, { quoted: m });

  if (command === 'menu' || command === 'help') {
    return reply(
`👑 *${BOT_NAME.toUpperCase()}* 👑

*General*
${PREFIX}ping
${PREFIX}menu

*Group (admins)*
${PREFIX}tagall
${PREFIX}kick @user
${PREFIX}promote @user
${PREFIX}demote @user
${PREFIX}link
${PREFIX}mute
${PREFIX}unmute`);
  }

  if (command === 'ping') return reply(`${BOT_NAME} is alive 👑`);

  // ----- group-only commands -----
  if (!isGroup) return;
  const meta = await sock.groupMetadata(from);
  const admins = meta.participants.filter(p => p.admin).map(p => p.id);
  const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  const isAdmin = admins.includes(sender) || m.key.fromMe;
  const botIsAdmin = admins.includes(botId);
  const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

  if (!isAdmin) return reply('Admins only.');

  if (command === 'tagall') {
    const ids = meta.participants.map(p => p.id);
    const msg = `👑 *${BOT_NAME} - Tag All*\n${args.join(' ')}\n\n` + ids.map(i => `@${i.split('@')[0]}`).join('\n');
    return reply(msg, ids);
  }

  if (!botIsAdmin) return reply('Make me admin first.');

  if (command === 'kick' && mentioned.length) {
    await sock.groupParticipantsUpdate(from, mentioned, 'remove');
    return reply('Removed.');
  }
  if (command === 'promote' && mentioned.length) {
    await sock.groupParticipantsUpdate(from, mentioned, 'promote');
    return reply('Promoted.');
  }
  if (command === 'demote' && mentioned.length) {
    await sock.groupParticipantsUpdate(from, mentioned, 'demote');
    return reply('Demoted.');
  }
  if (command === 'link') {
    const code = await sock.groupInviteCode(from);
    return reply(`https://chat.whatsapp.com/${code}`);
  }
  if (command === 'mute') {
    await sock.groupSettingUpdate(from, 'announcement');
    return reply('Group muted.');
  }
  if (command === 'unmute') {
    await sock.groupSettingUpdate(from, 'not_announcement');
    return reply('Group unmuted.');
  }
}

// ---------- API ----------
app.post('/pair', async (req, res) => {
  const number = (req.body.number || '').replace(/\D/g, '');
  if (number.length < 10) {
    return res.status(400).json({ success: false, error: 'Invalid number' });
  }
  if (connected.has(number)) {
    return res.json({ success: false, error: 'Already connected' });
  }
  try {
    await startBot(number, res);
  } catch (e) {
    console.error(`[${number}] start error:`, e.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to start bot' });
  }
});

app.get('/status/:number', (req, res) => {
  const number = req.params.number.replace(/\D/g, '');
  res.json({ connected: connected.has(number) });
});

app.post('/disconnect', async (req, res) => {
  const number = (req.body.number || '').replace(/\D/g, '');
  const sock = sockets.get(number);
  try {
    if (sock) await sock.logout();
  } catch (e) {}
  fs.rmSync(path.join(SESSION_DIR, number), { recursive: true, force: true });
  sockets.delete(number);
  connected.delete(number);
  res.json({ success: true });
});

app.get('/health', (req, res) => res.send('ok'));

// ---------- restore sessions on boot ----------
fs.readdirSync(SESSION_DIR).forEach(n => {
  if (fs.existsSync(path.join(SESSION_DIR, n, 'creds.json'))) {
    startBot(n).catch(e => console.error(`[${n}] restore error:`, e.message));
  }
});

app.listen(process.env.PORT || 3000, () => console.log(`${BOT_NAME} server running`));
      
