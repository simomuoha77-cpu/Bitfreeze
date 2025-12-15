require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const storage = require('node-persist');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SECRET = process.env.BF_SECRET || 'bitfreeze_dev_secret';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin-pass';
const DOMAIN = process.env.DOMAIN || 'https://bitfreeze-production.up.railway.app';

// Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// MPESA Manual
const MPESA_TILL = process.env.MPESA_TILL || '6992349';
const MPESA_NAME = process.env.MPESA_NAME || 'Bitfreeze';

// Fridges catalog
const FRIDGES = [
  { id: '2ft', name: '2 ft Fridge', price: 500, dailyEarn: 25, img: 'images/fridge2ft.jpg' },
  { id: '4ft', name: '4 ft Fridge', price: 1000, dailyEarn: 55, img: 'images/fridge4ft.jpg' },
  { id: '6ft', name: '6 ft Fridge', price: 2000, dailyEarn: 100, img: 'images/fridge6ft.jpg' },
  { id: '8ft', name: '8 ft Fridge', price: 4000, dailyEarn: 150, img: 'images/fridge8ft.jpg' },
  { id: '10ft', name: '10 ft Fridge', price: 6000, dailyEarn: 250, img: 'images/fridge10ft.jpg' },
  { id: '12ft', name: '12 ft Fridge', price: 8000, dailyEarn: 350, img: 'images/fridge12ft.jpg' },
];

app.use(bodyParser.json());
app.use(cors({ origin: DOMAIN }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize storage
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist') });

  if (!await storage.getItem('users')) await storage.setItem('users', []);
  if (!await storage.getItem('deposits')) await storage.setItem('deposits', []);
  if (!await storage.getItem('withdrawals')) await storage.setItem('withdrawals', []);

  console.log('Storage initialized.');
})();

// Helpers
async function findUser(emailOrPhone) {
  const users = await storage.getItem('users') || [];
  return users.find(u => u.email === emailOrPhone || u.phone === emailOrPhone);
}

async function getUserByEmail(email) {
  const users = await storage.getItem('users') || [];
  return users.find(u => u.email === email);
}

async function saveUser(user) {
  const users = await storage.getItem('users') || [];
  const idx = users.findIndex(u => u.email === user.email);
  if (idx > -1) users[idx] = user;
  else users.push(user);
  await storage.setItem('users', users);
}

// Auth middleware
function auth(req, res, next) {
  const a = req.headers.authorization;
  if (!a || !a.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = a.slice(7);
  try {
    const p = jwt.verify(token, SECRET);
    req.user = p;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Admin middleware
function adminAuth(req, res, next) {
  const tok = req.headers['x-admin-token'] || '';
  if (!tok || tok !== ADMIN_PASS) return res.status(401).json({ error: 'Admin auth required' });
  next();
}

// ========== API ==========

// Register
app.post('/api/register', async (req, res) => {
  const { email, password, phone, ref } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const users = await storage.getItem('users');
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'User already exists' });

  const hashed = await bcrypt.hash(password, 10);
  const newUser = { email, password: hashed, phone: phone || null, balance: 0, fridges: [], referrals: [], createdAt: Date.now() };
  await saveUser(newUser);

  if (ref) {
    const inviter = await getUserByEmail(String(ref));
    if (inviter) {
      inviter.referrals.push({ email, createdAt: Date.now() });
      await saveUser(inviter);
    }
  }

  res.json({ message: 'Registered', email });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = await findUser(email);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ email: user.email }, SECRET, { expiresIn: '7d' });
  res.json({ token, email: user.email, phone: user.phone, balance: user.balance });
});

// Fridges
app.get('/api/fridges', (req, res) => res.json({ fridges: FRIDGES }));

// Profile
app.get('/api/me', auth, async (req, res) => {
  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  res.json({ user: { email: user.email, phone: user.phone, balance: user.balance, fridges: user.fridges, referrals: user.referrals } });
});

// Deposit
app.post('/api/deposit', auth, async (req, res) => {
  const { amount, mpesaCode, phone } = req.body;
  if (!amount || !mpesaCode || !phone) return res.status(400).json({ error: 'Phone, amount, and MPESA code required' });

  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  const deposits = await storage.getItem('deposits') || [];
  const depositRequest = { id: crypto.randomUUID(), email: user.email, phone, amount, mpesaCode, status: 'PENDING', requestedAt: Date.now() };
  deposits.push(depositRequest);
  await storage.setItem('deposits', deposits);

  res.json({ message: 'Deposit submitted. Await admin approval.' });

  // Telegram notification
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: `🟢 New Deposit Request\nEmail: ${user.email}\nPhone: ${phone}\nAmount: KES ${amount}\nDeposit ID: ${depositRequest.id}\nStatus: PENDING`
      });
    } catch (err) {
      console.error('Telegram deposit error:', err.message);
    }
  }
});

// Withdraw
app.post('/api/withdraw', auth, async (req, res) => {
  const { amount, phone } = req.body;
  if (!amount || !phone) return res.status(400).json({ error: 'Phone and amount required' });
  if (amount < 200) return res.status(400).json({ error: 'Minimum withdrawal is KES 200' });

  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  const deposits = await storage.getItem('deposits') || [];
  const approved = deposits.find(d => d.email === user.email && d.status === 'APPROVED');
  if (!approved) return res.status(400).json({ error: 'No approved deposit found' });
  if (approved.phone !== phone) return res.status(403).json({ error: 'Withdrawals allowed only from the deposit phone' });
  if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  const withdrawals = await storage.getItem('withdrawals') || [];
  const request = { id: crypto.randomUUID(), email: user.email, phone, amount, status: 'PENDING', requestedAt: Date.now() };
  withdrawals.push(request);
  await storage.setItem('withdrawals', withdrawals);

  res.json({ message: 'Withdrawal submitted. Await admin approval.' });

  // Telegram notification
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: `🟡 New Withdrawal Request\nEmail: ${user.email}\nPhone: ${phone}\nAmount: KES ${amount}\nWithdrawal ID: ${request.id}\nStatus: PENDING`
      });
    } catch (err) {
      console.error('Telegram withdrawal error:', err.message);
    }
  }
});

// Admin approve/reject deposit
app.get('/api/admin/deposits/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const token = req.query.token;
  if (token !== ADMIN_PASS) return res.status(401).send('Unauthorized');

  const deposits = await storage.getItem('deposits') || [];
  const d = deposits.find(x => x.id === id);
  if (!d) return res.status(404).send('Deposit not found');
  if (d.status !== 'PENDING') return res.status(400).send('Deposit already processed');

  d.status = action.toUpperCase() === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  d.processedAt = Date.now();
  await storage.setItem('deposits', deposits);

  if (d.status === 'APPROVED') {
    const user = await getUserByEmail(d.email);
    if (user) {
      user.balance += Number(d.amount);
      await saveUser(user);
    }
  }

  res.send(`Deposit ${d.status}`);
});

// Admin approve/reject withdrawal
app.get('/api/admin/withdrawals/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const token = req.query.token;
  if (token !== ADMIN_PASS) return res.status(401).send('Unauthorized');

  const withdrawals = await storage.getItem('withdrawals') || [];
  const w = withdrawals.find(x => x.id === id);
  if (!w) return res.status(404).send('Withdrawal not found');
  if (w.status !== 'PENDING') return res.status(400).send('Withdrawal already processed');

  w.status = action.toUpperCase() === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  w.processedAt = Date.now();
  await storage.setItem('withdrawals', withdrawals);

  if (w.status === 'APPROVED') {
    const user = await getUserByEmail(w.email);
    if (user) {
      user.balance -= Number(w.amount);
      await saveUser(user);
    }
  }

  res.send(`Withdrawal ${w.status}`);
});

// Buy fridge
app.post('/api/buy', auth, async (req, res) => {
  const { fridgeId } = req.body;
  if (!fridgeId) return res.status(400).json({ error: 'fridgeId required' });

  const item = FRIDGES.find(f => f.id === fridgeId);
  if (!item) return res.status(400).json({ error: 'Invalid fridge' });

  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  if (user.balance < item.price) return res.status(400).json({ error: 'Insufficient balance' });

  user.balance -= item.price;
  user.fridges.push({ id: item.id, name: item.name, price: item.price, boughtAt: Date.now() });
  await saveUser(user);

  res.json({ message: 'Bought ' + item.name, balance: user.balance });
});

// Status
app.get('/api/status', (req, res) => res.json({ status: 'ok', time: Date.now(), till: MPESA_TILL }));

// Start server
app.listen(PORT, () => console.log(`Bitfreeze server running on port ${PORT}`));
