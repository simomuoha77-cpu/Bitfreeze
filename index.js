/**
 * Bitfreeze - Full index.js
 * Manual deposits/withdrawals, referral rewards, fridges, email approvals
 */

require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const storage = require('node-persist');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SECRET = process.env.BF_SECRET || 'bitfreeze_dev_secret_change_me';

// Referral reward mapping
const REFERRAL_RULES = [
  { min: 500, reward: 50 },
  { min: 1000, reward: 100 },
  { min: 2000, reward: 150 },
  { min: 4000, reward: 250 },
  { min: 6000, reward: 350 },
  { min: 8000, reward: 500 },
];

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
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Nodemailer setup for deposits
const depositMailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.DEPOSIT_EMAIL, // bitfreezedeposit@gmail.com
    pass: process.env.DEPOSIT_EMAIL_PASS
  }
});

// Nodemailer setup for withdrawals
const withdrawMailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.WITHDRAW_EMAIL, // bitfreezebitfreeze@gmail.com
    pass: process.env.WITHDRAW_EMAIL_PASS
  }
});

// Initialize storage
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist') });

  // Ensure default arrays
  if (!Array.isArray(await storage.getItem('users'))) await storage.setItem('users', []);
  if (!Array.isArray(await storage.getItem('deposits'))) await storage.setItem('deposits', []);
  if (!Array.isArray(await storage.getItem('withdrawals'))) await storage.setItem('withdrawals', []);

  console.log('Storage initialized.');
})();

// Helpers
async function getUserByEmail(email) {
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
  if (!tok || tok !== (process.env.BF_ADMIN_PASS || 'admin-pass')) return res.status(401).json({ error: 'Admin auth required' });
  next();
}

// Referral reward
function referralRewardFor(amount) {
  let selected = 0;
  for (const r of REFERRAL_RULES) {
    if (amount >= r.min) selected = r.reward;
  }
  return selected;
}

// ========== API ==========

// Register
app.post('/api/register', async (req, res) => {
  const { email, password, phone, ref } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const users = (await storage.getItem('users')) || [];
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'User already exists' });

  const hashed = await bcrypt.hash(password, 10);
  const newUser = { email, password: hashed, phone: phone || null, balance: 0, fridges: [], referrals: [], createdAt: Date.now() };
  await saveUser(newUser);

  if (ref) {
    const inviter = await getUserByEmail(String(ref));
    if (inviter) {
      inviter.referrals = inviter.referrals || [];
      inviter.referrals.push({ email, createdAt: Date.now() });
      await saveUser(inviter);
    }
  }
  return res.json({ message: 'Registered', email });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  const user = await getUserByEmail(email);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ email: user.email }, SECRET, { expiresIn: '7d' });
  return res.json({ token, email: user.email, phone: user.phone, balance: user.balance });
});

// Get fridges
app.get('/api/fridges', (req, res) => {
  res.json({ fridges: FRIDGES });
});

// Get user info
app.get('/api/me', auth, async (req, res) => {
  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  res.json({ user: { email: user.email, phone: user.phone, balance: user.balance, fridges: user.fridges, referrals: user.referrals } });
});

// Manual deposit
app.post('/api/deposit', auth, async (req, res) => {
  const { amount, mpesaCode, phone } = req.body || {};
  if (!amount || !mpesaCode || !phone) return res.status(400).json({ error: 'Phone, amount, and MPESA code required' });

  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  // Save deposit
  const depositsRaw = await storage.getItem('deposits');
  const deposits = Array.isArray(depositsRaw) ? depositsRaw : [];
  const deposit = { id: crypto.randomUUID(), email: user.email, phone, amount: Number(amount), mpesaCode, status: 'pending', createdAt: Date.now() };
  deposits.push(deposit);
  await storage.setItem('deposits', deposits);

  // Email to admin
  await depositMailer.sendMail({
    from: `"Bitfreeze Deposit" <${process.env.DEPOSIT_EMAIL}>`,
    to: process.env.DEPOSIT_EMAIL,
    subject: 'New Deposit Pending Approval',
    html: `
      <h3>New Deposit Request</h3>
      <p><b>Email:</b> ${user.email}</p>
      <p><b>Phone:</b> ${phone}</p>
      <p><b>Amount:</b> KES ${amount}</p>
      <p><b>MPESA Code:</b> ${mpesaCode}</p>
      <p>Status: <b>PENDING</b></p>
    `
  });

  res.json({ message: 'Deposit submitted. Await admin approval.' });
});

// Admin approve deposit
app.post('/api/admin/deposit/:id/approve', adminAuth, async (req, res) => {
  const { id } = req.params;
  const depositsRaw = await storage.getItem('deposits');
  const deposits = Array.isArray(depositsRaw) ? depositsRaw : [];
  const dep = deposits.find(d => d.id === id);
  if (!dep || dep.status !== 'pending') return res.status(400).json({ error: 'Invalid deposit' });

  const user = await getUserByEmail(dep.email);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Credit balance
  user.balance += dep.amount;
  dep.status = 'approved';
  await saveUser(user);
  await storage.setItem('deposits', deposits);

  res.json({ message: 'Deposit approved', deposit: dep });
});

// Withdraw request
app.post('/api/withdraw', auth, async (req, res) => {
  const { amount, phone } = req.body || {};
  if (!amount || !phone) return res.status(400).json({ error: 'Phone and amount required' });
  if (amount < 200) return res.status(400).json({ error: 'Minimum withdrawal is KES 200' });

  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  // Only allow withdraw from deposited phone
  const depositsRaw = await storage.getItem('deposits');
  const deposits = Array.isArray(depositsRaw) ? depositsRaw : [];
  const approvedDeposit = deposits.find(d => d.email === user.email && d.status === 'approved');
  if (!approvedDeposit) return res.status(403).json({ error: 'No approved deposit found' });
  if (approvedDeposit.phone !== phone) return res.status(403).json({ error: 'Withdrawals only allowed from deposited phone' });

  if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  // Save withdrawal request
  const withdrawalsRaw = await storage.getItem('withdrawals');
  const withdrawals = Array.isArray(withdrawalsRaw) ? withdrawalsRaw : [];
  const request = { id: crypto.randomUUID(), email: user.email, phone, amount, status: 'pending', requestedAt: Date.now() };
  withdrawals.push(request);
  await storage.setItem('withdrawals', withdrawals);

  // Email notification to admin
  await withdrawMailer.sendMail({
    from: `"Bitfreeze Withdraw" <${process.env.WITHDRAW_EMAIL}>`,
    to: process.env.WITHDRAW_EMAIL,
    subject: 'New Withdrawal Request',
    html: `
      <h3>Withdrawal Request</h3>
      <p><b>Email:</b> ${user.email}</p>
      <p><b>Phone:</b> ${phone}</p>
      <p><b>Amount:</b> KES ${amount}</p>
      <p>Status: <b>PENDING</b></p>
    `
  });

  res.json({ message: 'Withdrawal request created. Await admin approval.', requestId: request.id });
});

// Admin approve withdrawal
app.post('/api/admin/withdraw/:id/approve', adminAuth, async (req, res) => {
  const { id } = req.params;
  const withdrawalsRaw = await storage.getItem('withdrawals');
  const withdrawals = Array.isArray(withdrawalsRaw) ? withdrawalsRaw : [];
  const w = withdrawals.find(x => x.id === id);
  if (!w || w.status !== 'pending') return res.status(404).json({ error: 'Request not pending' });

  const user = await getUserByEmail(w.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.balance < w.amount) return res.status(400).json({ error: 'Insufficient balance' });

  user.balance -= w.amount;
  w.status = 'approved';
  w.processedAt = Date.now();
  await saveUser(user);
  await storage.setItem('withdrawals', withdrawals);

  res.json({ message: 'Withdrawal approved', request: w });
});

// Fridge purchase
app.post('/api/buy', auth, async (req, res) => {
  const { fridgeId } = req.body || {};
  if (!fridgeId) return res.status(400).json({ error: 'fridgeId required' });
  const item = FRIDGES.find(f => f.id === fridgeId);
  if (!item) return res.status(400).json({ error: 'Invalid fridge' });

  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  if (user.balance < item.price) return res.status(400).json({ error: 'Insufficient balance' });

  user.balance -= item.price;
  user.fridges.push({ id: item.id, name: item.name, price: item.price, boughtAt: Date.now() });
  await saveUser(user);

  res.json({ message: `Bought ${item.name}`, balance: user.balance });
});

// Status check
app.get('/api/status', (req, res) => res.json({ status: 'ok', time: Date.now() }));

app.listen(PORT, () => console.log(`Bitfreeze server running on port ${PORT}`));

