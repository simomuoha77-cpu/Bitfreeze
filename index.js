/*
 Bitfreeze - Termux-friendly server (pure-js storage)
*/
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const storage = require('node-persist');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.BF_SECRET || 'bitfreeze_dev_secret_change_me';

// simple fridge catalog (KES) - adjust values if needed
const FRIDGES = [
  { id: '2ft', name: '2 ft Fridge', price: 500, dailyEarn: 25 },
  { id: '4ft', name: '4 ft Fridge', price: 1000, dailyEarn: 55 },
  { id: '6ft', name: '6 ft Fridge', price: 2000, dailyEarn: 100 },
  { id: '8ft', name: '8 ft Fridge', price: 4000, dailyEarn: 150 },
  { id: '10ft', name: '10 ft Fridge', price: 6000, dailyEarn: 250 },
  { id: '12ft', name: '12 ft Fridge', price: 8000, dailyEarn: 350 }
];

app.use(bodyParser.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// init storage
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist'), ttl: false });
  const users = (await storage.getItem('users')) || [];
  await storage.setItem('users', users);
})();

async function allUsers() { return (await storage.getItem('users')) || []; }
async function findUser(email) {
  const users = await allUsers();
  return users.find(u => u.email.toLowerCase() === (email||'').toLowerCase());
}
async function saveUser(user) {
  const users = await allUsers();
  const idx = users.findIndex(u => u.email.toLowerCase() === user.email.toLowerCase());
  if (idx === -1) users.push(user); else users[idx] = user;
  await storage.setItem('users', users);
}

// auth middleware
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'Missing token' });
  const parts = h.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'Bad token' });
  try {
    const payload = jwt.verify(parts[1], SECRET);
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (await findUser(email)) return res.status(400).json({ error: 'Email already registered' });
  const hash = await bcrypt.hash(password, 10);
  const user = { email, password: hash, balance: 0, fridges: [], createdAt: new Date().toISOString() };
  await saveUser(user);
  return res.json({ message: 'Registered' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await findUser(email);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ email: user.email }, SECRET, { expiresIn: '7d' });
  return res.json({ token });
});

app.get('/api/fridges', (req, res) => res.json({ fridges: FRIDGES }));

app.get('/api/me', auth, async (req, res) => {
  const user = await findUser(req.user.email);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const { password, ...safe } = user;
  return res.json({ user: safe });
});

app.post('/api/deposit', auth, async (req, res) => {
  const amount = Number(req.body.amount || 0);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const user = await findUser(req.user.email);
  user.balance = (user.balance || 0) + amount;
  await saveUser(user);
  return res.json({ message: 'Deposit successful (demo)', balance: user.balance });
});

app.post('/api/withdraw', auth, async (req, res) => {
  const amount = Number(req.body.amount || 0);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (amount < 200) return res.status(400).json({ error: 'Minimum withdrawal is KES 200' });
  const user = await findUser(req.user.email);
  if ((user.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient balance' });
  user.balance -= amount;
  await saveUser(user);
  return res.json({ message: 'Withdraw processed (demo)', balance: user.balance });
});

app.post('/api/buy', auth, async (req, res) => {
  const { fridgeId } = req.body || {};
  const item = FRIDGES.find(f => f.id === fridgeId);
  if (!item) return res.status(400).json({ error: 'Invalid fridge' });
  const user = await findUser(req.user.email);
  if ((user.balance || 0) < item.price) return res.status(400).json({ error: 'Insufficient balance' });
  user.balance -= item.price;
  user.fridges.push({ id: item.id, name: item.name, price: item.price, boughtAt: new Date().toISOString() });
  await saveUser(user);
  return res.json({ message: 'Bought ' + item.name, balance: user.balance, fridges: user.fridges });
});

// dev route reset
app.post('/api/_reset', async (req, res) => {
  await storage.setItem('users', []);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('Bitfreeze server running on port', PORT));
