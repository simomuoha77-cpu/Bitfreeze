require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const storage = require('node-persist');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.BF_SECRET;
const DOMAIN = process.env.DOMAIN;
const ADMIN_PASS = process.env.ADMIN_PASS;

// Telegram – Deposit
const TG_DEPOSIT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_DEPOSIT_CHAT = process.env.TELEGRAM_CHAT_ID;

// Telegram – Withdraw
const TG_WITHDRAW_TOKEN = process.env.TELEGRAM_WITHDRAW_BOT_TOKEN;
const TG_WITHDRAW_CHAT = process.env.TELEGRAM_WITHDRAW_CHAT_ID;

// Fridges
const FRIDGES = [
  { id: '2ft', name: '2 ft Fridge', price: 500, daily: 25, img: '/images/fridge2ft.jpg' },
  { id: '4ft', name: '4 ft Fridge', price: 1000, daily: 55, img: '/images/fridge4ft.jpg' },
  { id: '6ft', name: '6 ft Fridge', price: 2000, daily: 100, img: '/images/fridge6ft.jpg' },
];

app.use(bodyParser.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ===== STORAGE =====
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist') });
  if (!await storage.getItem('users')) await storage.setItem('users', []);
  if (!await storage.getItem('deposits')) await storage.setItem('deposits', []);
  if (!await storage.getItem('withdrawals')) await storage.setItem('withdrawals', []);
  console.log('Storage ready');
})();

// ===== HELPERS =====
async function getUsers() {
  return await storage.getItem('users') || [];
}
async function saveUsers(u) {
  await storage.setItem('users', u);
}
async function getUser(email) {
  const u = await getUsers();
  return u.find(x => x.email === email);
}

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(h.split(' ')[1], SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ===== TELEGRAM SEND =====
async function sendTelegram(botToken, chatId, text, buttons = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// ===== AUTH =====
app.post('/api/register', async (req, res) => {
  const { email, password, phone } = req.body;
  const users = await getUsers();
  if (users.find(u => u.email === email)) return res.json({ error: 'Exists' });

  users.push({
    email,
    phone,
    password: await bcrypt.hash(password, 10),
    balance: 0,
    fridges: []
  });

  await saveUsers(users);
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await getUser(email);
  if (!user || !await bcrypt.compare(password, user.password))
    return res.json({ error: 'Invalid' });

  res.json({ token: jwt.sign({ email }, SECRET) });
});

// ===== DATA =====
app.get('/api/fridges', (_, res) => res.json(FRIDGES));
app.get('/api/me', auth, async (req, res) => res.json(await getUser(req.user.email)));

// ===== DEPOSIT =====
app.post('/api/deposit', auth, async (req, res) => {
  const { amount, phone, mpesaCode } = req.body;
  const id = crypto.randomUUID();

  const deposits = await storage.getItem('deposits');
  deposits.push({ id, email: req.user.email, phone, amount, mpesaCode, status: 'PENDING' });
  await storage.setItem('deposits', deposits);

  await sendTelegram(
    TG_DEPOSIT_TOKEN,
    TG_DEPOSIT_CHAT,
`🟢 <b>New Deposit</b>
Email: ${req.user.email}
Phone: ${phone}
Amount: KES ${amount}
MPESA Code: <b>${mpesaCode}</b>
ID: ${id}`,
    [[
      { text: '✅ Approve', callback_data: `dep_ok_${id}` },
      { text: '❌ Reject', callback_data: `dep_no_${id}` }
    ]]
  );

  res.json({ ok: true });
});

// ===== WITHDRAW =====
app.post('/api/withdraw', auth, async (req, res) => {
  const { amount, phone } = req.body;
  const id = crypto.randomUUID();

  const withdrawals = await storage.getItem('withdrawals');
  withdrawals.push({ id, email: req.user.email, phone, amount, status: 'PENDING' });
  await storage.setItem('withdrawals', withdrawals);

  await sendTelegram(
    TG_WITHDRAW_TOKEN,
    TG_WITHDRAW_CHAT,
`🔴 <b>Withdraw Request</b>
Email: ${req.user.email}
Phone: ${phone}
Amount: KES ${amount}
ID: ${id}`,
    [[
      { text: '✅ Approve', callback_data: `wd_ok_${id}` },
      { text: '❌ Reject', callback_data: `wd_no_${id}` }
    ]]
  );

  res.json({ ok: true });
});

// ===== TELEGRAM CALLBACK =====
app.post('/telegram', async (req, res) => {
  const q = req.body.callback_query;
  if (!q) return res.sendStatus(200);

  const [type, action, id] = q.data.split('_');

  if (type === 'dep') {
    const deposits = await storage.getItem('deposits');
    const d = deposits.find(x => x.id === id);
    if (!d || d.status !== 'PENDING') return res.sendStatus(200);

    d.status = action === 'ok' ? 'APPROVED' : 'REJECTED';
    await storage.setItem('deposits', deposits);

    if (action === 'ok') {
      const users = await getUsers();
      const u = users.find(x => x.email === d.email);
      u.balance += Number(d.amount);
      await saveUsers(users);
    }
  }

  if (type === 'wd') {
    const withdrawals = await storage.getItem('withdrawals');
    const w = withdrawals.find(x => x.id === id);
    if (!w || w.status !== 'PENDING') return res.sendStatus(200);

    w.status = action === 'ok' ? 'APPROVED' : 'REJECTED';
    await storage.setItem('withdrawals', withdrawals);

    if (action === 'ok') {
      const users = await getUsers();
      const u = users.find(x => x.email === w.email);
      u.balance -= Number(w.amount);
      await saveUsers(users);
    }
  }

  res.sendStatus(200);
});

// ===== START =====
app.listen(PORT, () => console.log('Bitfreeze running'));
