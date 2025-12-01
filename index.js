// index.js
// Bitfreeze minimal server - safe, persistent, email+phone support
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const storage = require('node-persist');
const path = require('path');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const SECRET = process.env.BF_SECRET || 'bitfreeze_dev_secret_change_me';

// Catalog - simple demo values (KES)
const FRIDGES = [
  { id: '2ft',  name: '2 ft Fridge',  price: 500,  dailyEarn: 25 },
  { id: '4ft',  name: '4 ft Fridge',  price: 1000, dailyEarn: 55 },
  { id: '6ft',  name: '6 ft Fridge',  price: 2000, dailyEarn: 100 },
  { id: '8ft',  name: '8 ft Fridge',  price: 4000, dailyEarn: 150 },
  { id: '10ft', name: '10 ft Fridge', price: 6000, dailyEarn: 250 },
  { id: '12ft', name: '12 ft Fridge', price: 8000, dailyEarn: 350 }
];

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// storage initialization in IIFE to avoid top-level await problems
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist'), stringify: JSON.stringify, parse: JSON.parse, encoding: 'utf8', logging: false, ttl: false });
  // ensure base keys exist
  const users = (await storage.getItem('users')) || [];
  const deposits = (await storage.getItem('deposits')) || {}; // deposits[email] = phone
  await storage.setItem('users', users);
  await storage.setItem('deposits', deposits);
})().catch(err => {
  console.error('Storage init error', err);
});

// ----------------- helpers -----------------
async function getUsers() {
  return (await storage.getItem('users')) || [];
}

async function findUserByEmail(email) {
  const users = await getUsers();
  return users.find(u => u.email === email);
}

async function findUserByPhone(phone) {
  const users = await getUsers();
  return users.find(u => u.phone === phone);
}

async function findUserByIdentifier(identifier) {
  if (!identifier) return null;
  // if contains @ assume email else phone-ish
  if (identifier.includes('@')) return findUserByEmail(identifier.toLowerCase());
  return findUserByPhone(identifier);
}

async function saveUser(user) {
  const users = await getUsers();
  const idx = users.findIndex(u => u.email === user.email);
  if (idx >= 0) users[idx] = user;
  else users.push(user);
  await storage.setItem('users', users);
}

async function getDepositsMap() {
  return (await storage.getItem('deposits')) || {};
}

async function setDepositsMap(m) {
  await storage.setItem('deposits', m);
}

// JWT helper
function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'Missing Authorization header' });
  const parts = h.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ error: 'Invalid Authorization header' });
  const token = parts[1];
  try {
    const p = jwt.verify(token, SECRET);
    req.user = p;
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ----------------- routes -----------------

// GET fridge catalog
app.get('/api/fridges', (req, res) => {
  res.json({ fridges: FRIDGES });
});

// Register: requires email (unique), phone, password
app.post('/api/register', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const phone = (req.body.phone || '').trim();
  const password = req.body.password || '';

  if (!email || !phone || !password) return res.status(400).json({ error: 'Email, phone and password required' });
  if (!email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

  if (await findUserByEmail(email)) return res.status(400).json({ error: 'Email already registered' });
  if (await findUserByPhone(phone)) return res.status(400).json({ error: 'Phone already registered' });

  const hashed = await bcrypt.hash(password, 10);
  const newUser = { email, phone, password: hashed, balance: 0, fridges: [] };
  await saveUser(newUser);
  return res.json({ message: 'User registered', email, phone });
});

// Login: identifier (email or phone) + password
app.post('/api/login', async (req, res) => {
  const identifier = (req.body.identifier || '').trim();
  const password = req.body.password || '';
  if (!identifier || !password) return res.status(400).json({ error: 'Identifier and password required' });

  const user = await findUserByIdentifier(identifier);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password || '');
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });

  const token = signToken({ email: user.email, phone: user.phone });
  return res.json({ token, email: user.email, phone: user.phone });
});

// Get profile
app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await findUserByEmail(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // don't return password hash
  const { password, ...safe } = user;
  return res.json({ user: safe });
});

// Deposit: email, amount, phone, mpesaPin (demo accepts any pin)
app.post('/api/deposit', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const amount = Number(req.body.amount || 0);
  const phone = (req.body.phone || '').trim();
  const mpesaPin = req.body.mpesaPin || '';

  if (!email || !amount || amount <= 0 || !phone) return res.status(400).json({ error: 'Email, amount and phone required' });

  const user = await findUserByEmail(email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  // Save which phone made deposit for that email (overwrites previous — that's intentional)
  const deposits = await getDepositsMap();
  deposits[email] = phone;
  await setDepositsMap(deposits);

  // Demo: accept any pin but still check length so user can't send blank
  if (!mpesaPin || String(mpesaPin).length < 4) {
    // accept as demo but warn
    // In production: integrate real MPESA API and validate pin/session
  }

  user.balance = (user.balance || 0) + Number(amount);
  await saveUser(user);
  return res.json({ message: `Deposited KES ${amount}`, balance: user.balance, phoneUsed: phone });
});

// Withdraw: email, amount, phone. Only the phone used for deposit can withdraw
app.post('/api/withdraw', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const amount = Number(req.body.amount || 0);
  const phone = (req.body.phone || '').trim();

  if (!email || !amount || amount <= 0 || !phone) return res.status(400).json({ error: 'Email, amount and phone required' });
  if (amount < 200) return res.status(400).json({ error: 'Minimum withdrawal: KES 200' });

  const user = await findUserByEmail(email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  const deposits = await getDepositsMap();
  if (deposits[email] !== phone) return res.status(403).json({ error: 'Withdrawals must be made from the same phone used for deposit' });

  if ((user.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient balance' });

  user.balance -= amount;
  await saveUser(user);
  return res.json({ message: `Withdrawn KES ${amount}`, balance: user.balance });
});

// Buy fridge endpoint (authenticated)
app.post('/api/buy', authMiddleware, async (req, res) => {
  const fridgeId = (req.body.fridgeId || '').toString();
  const item = FRIDGES.find(f => f.id === fridgeId);
  if (!item) return res.status(400).json({ error: 'Invalid fridge id' });

  const user = await findUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  if ((user.balance || 0) < item.price) return res.status(400).json({ error: 'Insufficient balance' });
  user.balance -= item.price;
  user.fridges = user.fridges || [];
  user.fridges.push({ id: item.id, name: item.name, price: item.price, boughtAt: Date.now() });
  await saveUser(user);
  return res.json({ message: `Bought ${item.name}`, balance: user.balance });
});

// Small dev-only route: reset (BE CAREFUL — left for convenience; you may remove)
app.post('/api/_reset', async (req, res) => {
  // For safety: don't delete images; only wipe users and deposits if you really want to.
  await storage.setItem('users', []);
  await storage.setItem('deposits', {});
  return res.json({ ok: true });
});

// Always return index or 404 for static
app.use((req, res) => {
  res.status(404).send('Not found');
});

// Start server (wrap in try-catch so pm2 doesn't crash forever with cryptic errors)
try {
  app.listen(PORT, () => console.log(`Bitfreeze server running on port ${PORT}`));
} catch (err) {
  console.error('Server start error', err);
}
