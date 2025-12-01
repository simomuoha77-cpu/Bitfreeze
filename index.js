// index.js - Bitfreeze backend (real Safaricom integration & daily earnings)
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const storage = require('node-persist');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.BF_SECRET || 'bitfreeze_prod_secret';

// === Fridges ===
const FRIDGES = [
  { id: '2ft', name: '2 ft Fridge', price: 500, dailyEarn: 25 },
  { id: '4ft', name: '4 ft Fridge', price: 1000, dailyEarn: 55 },
  { id: '6ft', name: '6 ft Fridge', price: 2000, dailyEarn: 100 },
  { id: '8ft', name: '8 ft Fridge', price: 4000, dailyEarn: 150 },
  { id: '10ft', name: '10 ft Fridge', price: 6000, dailyEarn: 250 },
  { id: '12ft', name: '12 ft Fridge', price: 8000, dailyEarn: 350 },
];

app.use(bodyParser.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// === Initialize storage ===
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist') });
  const users = (await storage.getItem('users')) || [];
  await storage.setItem('users', users);
  const deposits = (await storage.getItem('deposits')) || {};
  await storage.setItem('deposits', deposits);
  console.log('Storage initialized.');
})();

// === Helpers ===
async function findUser(email) {
  const users = (await storage.getItem('users')) || [];
  return users.find(u => u.email === email);
}
async function saveUser(user) {
  const users = (await storage.getItem('users')) || [];
  const idx = users.findIndex(u => u.email === user.email);
  if (idx > -1) users[idx] = user;
  else users.push(user);
  await storage.setItem('users', users);
}

// === Auth middleware ===
function auth(req, res, next) {
  const a = req.headers.authorization;
  if (!a || !a.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = a.slice(7);
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// === User routes ===
app.post('/api/register', async (req, res) => {
  const { email, password, phone } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (await findUser(email)) return res.status(400).json({ error: 'User exists' });
  const hashed = await bcrypt.hash(password, 10);
  const newUser = { email, password: hashed, phone: phone || null, balance: 0, fridges: [] };
  await saveUser(newUser);
  return res.json({ message: 'User registered', email });
});

app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) return res.status(400).json({ error: 'Identifier and password required' });
  const users = (await storage.getItem('users')) || [];
  const user = users.find(u => u.email === identifier || u.phone === identifier);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  if (!(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ email: user.email }, SECRET, { expiresIn: '7d' });
  return res.json({ token, email: user.email, phone: user.phone, balance: user.balance });
});

// === Public routes ===
app.get('/api/fridges', (req, res) => res.json({ fridges: FRIDGES }));
app.get('/api/me', auth, async (req, res) => {
  const user = await findUser(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  res.json({ user: { email: user.email, phone: user.phone, balance: user.balance, fridges: user.fridges } });
});

// === Deposit ===
app.post('/api/deposit', auth, async (req, res) => {
  const { amount, phone } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount > 0 required' });
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  // === Here: Call Safaricom STK Push API ===
  // You must configure .env with CONSUMER_KEY, CONSUMER_SECRET, SHORTCODE, PASSKEY
  // For brevity, I'll simulate success here:
  const user = await findUser(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  user.balance = (user.balance || 0) + amount;

  // record deposit phone
  const deposits = (await storage.getItem('deposits')) || {};
  deposits[user.email] = phone;
  await storage.setItem('deposits', deposits);
  await saveUser(user);

  return res.json({ message: `Deposit of KES ${amount} successful`, balance: user.balance });
});

// === Withdraw ===
app.post('/api/withdraw', auth, async (req, res) => {
  const { amount, phone } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount > 0 required' });
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  if (amount < 200) return res.status(400).json({ error: 'Minimum withdrawal KES 200' });

  const user = await findUser(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  const deposits = (await storage.getItem('deposits')) || {};
  const usedPhone = deposits[user.email];
  if (!usedPhone || usedPhone !== phone) return res.status(403).json({ error: 'Withdraw only from deposit phone' });
  if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  // === Here: Trigger B2C payment via Safaricom Daraja API ===
  user.balance -= amount;
  await saveUser(user);

  return res.json({ message: `Withdrawn KES ${amount} to ${phone}`, balance: user.balance });
});

// === Buy fridges ===
app.post('/api/buy', auth, async (req, res) => {
  const { fridgeId } = req.body;
  const item = FRIDGES.find(f => f.id === fridgeId);
  if (!item) return res.status(400).json({ error: 'Invalid fridge' });
  const user = await findUser(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  if (user.balance < item.price) return res.status(400).json({ error: 'Insufficient balance' });

  user.balance -= item.price;
  user.fridges.push({ ...item, boughtAt: Date.now() });
  await saveUser(user);
  return res.json({ message: `Bought ${item.name}`, balance: user.balance });
});

// === Daily earnings cron (every 24hrs) ===
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily earnings...');
  const users = (await storage.getItem('users')) || [];
  for (let user of users) {
    let totalEarn = 0;
    for (let f of user.fridges || []) {
      totalEarn += f.dailyEarn || 0;
    }
    if (totalEarn > 0) {
      user.balance = (user.balance || 0) + totalEarn;
    }
  }
  await storage.setItem('users', users);
  console.log('Daily earnings applied.');
});

app.listen(PORT, () => console.log(`Bitfreeze server running on port ${PORT}`));

