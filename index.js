require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const storage = require('node-persist');
const path = require('path');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SECRET = process.env.BF_SECRET || 'bitfreeze_dev_secret';
const DOMAIN = process.env.DOMAIN || 'https://bitfreeze-production.up.railway.app';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin-pass';

// Telegram
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// MPESA
const MPESA_TILL = process.env.MPESA_TILL || '6992349';
const MPESA_NAME = process.env.MPESA_NAME || 'Bitfreeze';

// Fridges
const FRIDGES = [
  { id: '2ft', name: '2 ft Fridge', price: 500, dailyEarn: 25 },
  { id: '4ft', name: '4 ft Fridge', price: 1000, dailyEarn: 55 },
  { id: '6ft', name: '6 ft Fridge', price: 2000, dailyEarn: 100 },
  { id: '8ft', name: '8 ft Fridge', price: 4000, dailyEarn: 150 },
  { id: '10ft', name: '10 ft Fridge', price: 6000, dailyEarn: 250 },
  { id: '12ft', name: '12 ft Fridge', price: 8000, dailyEarn: 350 },
];

const REFERRAL_RULES = [
  { min: 8000, reward: 500 },
  { min: 6000, reward: 350 },
  { min: 4000, reward: 250 },
  { min: 2000, reward: 150 },
  { min: 1000, reward: 100 },
  { min: 500, reward: 50 },
];

app.use(bodyParser.json());
app.use(cors({ origin: DOMAIN }));
app.use(express.static(path.join(__dirname, 'public')));

// Storage
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist'), forgiveParseErrors: true });
  if (!await storage.getItem('users')) await storage.setItem('users', []);
  if (!await storage.getItem('deposits')) await storage.setItem('deposits', []);
  if (!await storage.getItem('withdrawals')) await storage.setItem('withdrawals', []);
})();

// Helpers
const kenyaDate = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

async function getUsers() { return (await storage.getItem('users')) || []; }
async function saveUsers(u) { await storage.setItem('users', u); }
async function findUser(email) { return (await getUsers()).find(x => x.email === email); }
async function saveUser(user) {
  const u = await getUsers();
  const i = u.findIndex(x => x.email === user.email);
  if (i > -1) u[i] = user;
  else u.push(user);
  await saveUsers(u);
}

// Auth
function auth(req, res, next) {
  const a = req.headers.authorization;
  if (!a || !a.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(a.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Telegram
async function tgSend(text, buttons) {
  if (!TG_BOT || !TG_CHAT) return;
  const body = { chat_id: TG_CHAT, text, parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// Register
app.post('/api/register', async (req, res) => {
  const { email, password, phone, ref } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email & password required' });
  if (await findUser(email)) return res.status(400).json({ error: 'User exists' });

  const hashed = await bcrypt.hash(password, 10);
  const user = {
    email,
    password: hashed,
    phone: phone || null,
    balance: 0,
    fridges: [],
    referrals: [],
    createdAt: Date.now(),
    withdrawPhone: null,
    referredBy: ref || null,
    lastPaid: kenyaDate(),
  };
  await saveUser(user);
  res.json({ message: 'Registered', email });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await findUser(email);
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(400).json({ error: 'Invalid' });

  const token = jwt.sign({ email: user.email }, SECRET, { expiresIn: '7d' });
  res.json({ token, email: user.email, phone: user.phone, balance: user.balance });
});

// Deposit
app.post('/api/deposit', auth, async (req, res) => {
  const { amount, mpesaCode, phone } = req.body || {};
  if (!amount || !mpesaCode || !phone) return res.status(400).json({ error: 'Missing fields' });

  const u = await findUser(req.user.email);
  if (!u) return res.status(404).json({ error: 'User not found' });

  if (!u.withdrawPhone) u.withdrawPhone = phone;

  const deposits = await storage.getItem('deposits') || [];
  const d = {
    id: crypto.randomUUID(),
    email: u.email,
    phone,
    amount: Number(amount),
    mpesaCode,
    status: 'PENDING',
    requestedAt: Date.now(),
  };
  deposits.push(d);
  await storage.setItem('deposits', deposits);
  await saveUser(u);

  const text =
    `🟢 <b>New Deposit Request</b>\n` +
    `Email: ${u.email}\nPhone: ${phone}\nAmount: KES ${amount}\n` +
    `MPESA Code: <b>${mpesaCode}</b>\nDeposit ID: ${d.id}\nStatus: PENDING`;

  const buttons = [[
    { text: '✅ Approve', url: `${DOMAIN}/api/admin/deposits/${d.id}/approve?token=${ADMIN_PASS}` },
    { text: '❌ Reject', url: `${DOMAIN}/api/admin/deposits/${d.id}/reject?token=${ADMIN_PASS}` },
  ]];

  await tgSend(text, buttons);
  res.json({ message: 'Deposit submitted' });
});

// Admin deposit approve/reject
app.get('/api/admin/deposits/:id/:action', async (req, res) => {
  if (req.query.token !== ADMIN_PASS) return res.status(401).send('Unauthorized');

  const deposits = await storage.getItem('deposits') || [];
  const d = deposits.find(x => x.id === req.params.id);
  if (!d || d.status !== 'PENDING') return res.send('Invalid');

  d.status = req.params.action.toUpperCase() === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  d.processedAt = Date.now();
  await storage.setItem('deposits', deposits);

  if (d.status === 'APPROVED') {
    const u = await findUser(d.email);
    if (u) {
      u.balance += d.amount;
      await saveUser(u);
    }
  }
  res.send(`Deposit ${d.status}`);
});

// Daily earnings
async function runDailyEarnings() {
  const users = await getUsers();
  const today = kenyaDate();

  for (const u of users) {
    if (u.lastPaid === today) continue;
    let earn = 0;
    for (const f of u.fridges) {
      const fr = FRIDGES.find(x => x.id === f.id);
      if (fr) earn += fr.dailyEarn;
    }
    if (earn > 0) {
      u.balance += earn;
      u.lastPaid = today;
    }
  }
  await saveUsers(users);
}

// Schedule midnight Kenya
(function schedule() {
  const now = new Date();
  const kenyaNow = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
  const next = new Date(kenyaNow);
  next.setHours(24, 0, 0, 0);
  setTimeout(async () => {
    await runDailyEarnings();
    schedule();
  }, next - kenyaNow);
})();

app.listen(PORT, () => console.log(`Bitfreeze running on ${PORT}`));
