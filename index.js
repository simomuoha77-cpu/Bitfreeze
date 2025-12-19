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
  { id: '2ft', name: '2 ft Fridge', price: 500, dailyEarn: 25, img: 'images/fridge2ft.jpg' },
  { id: '4ft', name: '4 ft Fridge', price: 1000, dailyEarn: 55, img: 'images/fridge4ft.jpg' },
  { id: '6ft', name: '6 ft Fridge', price: 2000, dailyEarn: 100, img: 'images/fridge6ft.jpg' },
  { id: '8ft', name: '8 ft Fridge', price: 4000, dailyEarn: 150, img: 'images/fridge8ft.jpg' },
  { id: '10ft', name: '10 ft Fridge', price: 6000, dailyEarn: 250, img: 'images/fridge10ft.jpg' },
  { id: '12ft', name: '12 ft Fridge', price: 8000, dailyEarn: 350, img: 'images/fridge12ft.jpg' },
];

// Referral rules
const REFERRAL_RULES = [
  { min: 8000, reward: 500 },
  { min: 6000, reward: 350 },
  { min: 4000, reward: 250 },
  { min: 2000, reward: 150 },
  { min: 1000, reward: 100 },
  { min: 500, reward: 50 },
];

// Middleware
app.use(bodyParser.json());
app.use(cors({ origin: DOMAIN }));
app.use(express.static(path.join(__dirname, 'public')));

// ===================== MONGODB =====================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(e => console.error('MongoDB connection error:', e));

// ===================== SCHEMA =====================
const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  password: String,
  phone: String,
  depositPhone: String,
  balance: { type: Number, default: 0 },
  earning: { type: Number, default: 0 },
  lockedBonus: { type: Number, default: 0 },
  fridges: { type: Array, default: [] },
  referrals: { type: Array, default: [] },
  referredBy: String,
  lastPaid: String,
  firstDepositMade: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const depositSchema = new mongoose.Schema({
  id: String,
  email: String,
  phone: String,
  amount: Number,
  mpesaCode: String,
  status: String,
  requestedAt: Date,
  processedAt: Date,
  telegramMessageId: String
});

const withdrawalSchema = new mongoose.Schema({
  id: String,
  email: String,
  phone: String,
  amount: Number,
  status: String,
  requestedAt: Date,
  processedAt: Date,
  telegramMessageId: String
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// ===================== HELPERS =====================
function auth(req, res, next) {
  const a = req.headers.authorization;
  if (!a || !a.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(a.slice(7), SECRET); next(); } 
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}

async function tgSend(text, buttons, chatId = TG_CHAT, messageId) {
  if (!TG_BOT || !chatId) return;
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const url = messageId
    ? `https://api.telegram.org/bot${TG_BOT}/editMessageText?chat_id=${chatId}&message_id=${messageId}`
    : `https://api.telegram.org/bot${TG_BOT}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(e => console.error('TG send/edit error', e));
}

// ===================== ROUTES =====================

// Register
app.post('/api/register', async (req, res) => {
  const { name, email, password, referrerEmail } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });

  const hashed = await bcrypt.hash(password, 10);
  const ref = referrerEmail?.trim() || null;

  const user = new User({ 
    name, 
    email, 
    password: hashed, 
    referredBy: ref,
    balance: 0,
    earning: 200, // reward 200 immediately
    lockedBonus: 0,
    firstDepositMade: false
  });
  await user.save();

  const token = jwt.sign({ email: user.email }, SECRET, { expiresIn: '7d' });
  res.json({ message: 'Registered successfully, 200 KES credited to earning', token, email: user.email });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await User.findOne({ email });
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ email: user.email }, SECRET, { expiresIn: '7d' });
  res.json({ token, email: user.email, phone: user.phone, balance: user.balance, earning: user.earning });
});

// Deposit
app.post('/api/deposit', auth, async (req, res) => {
  const { amount, mpesaCode, phone } = req.body || {};
  if (!amount || !mpesaCode || !phone) return res.status(400).json({ error: 'amount, mpesaCode, phone required' });

  const u = await User.findOne({ email: req.user.email });
  if (!u) return res.status(404).json({ error: 'User not found' });

  if (amount < 500) return res.status(400).json({ error: 'Minimum deposit is 500 KES' });

  const pending = await Deposit.findOne({ email: u.email, status: 'PENDING' });
  if (pending) return res.status(400).json({ error: 'You have a pending deposit' });

  const deposit = new Deposit({ id: crypto.randomUUID(), email: u.email, phone, amount: Number(amount), mpesaCode, status: 'PENDING', requestedAt: Date.now() });
  await deposit.save();

  const text = `🟢 <b>New Deposit Request</b>\nEmail: ${u.email}\nPhone: ${phone}\nAmount: KES ${amount}\nMPESA Code: <b>${mpesaCode}</b>\nDeposit ID: ${deposit.id}\nStatus: PENDING`;
  const buttons = [[
    { text: '✅ Approve', url: `${DOMAIN}/api/admin/deposits/${deposit.id}/approve?token=${ADMIN_PASS}` },
    { text: '❌ Reject', url: `${DOMAIN}/api/admin/deposits/${deposit.id}/reject?token=${ADMIN_PASS}` }
  ]];

  const tgResponse = await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    })
  });
  const tgData = await tgResponse.json();
  if (tgData.ok && tgData.result) {
    deposit.telegramMessageId = tgData.result.message_id;
    await deposit.save();
  }

  res.json({ message: 'Deposit submitted. Wait for admin approval' });
});

// Approve deposit
app.get('/api/admin/deposits/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const token = req.query.token;
  if (token !== ADMIN_PASS) return res.status(401).send('Unauthorized');

  const deposit = await Deposit.findOne({ id });
  if (!deposit) return res.status(404).send('Deposit not found');
  if (deposit.status !== 'PENDING') return res.status(400).send('Deposit already processed');

  deposit.status = action.toUpperCase() === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  deposit.processedAt = Date.now();
  await deposit.save();

  if (deposit.status === 'APPROVED') {
    const u = await User.findOne({ email: deposit.email });
    if (u) {
      u.balance += Number(deposit.amount);
      u.firstDepositMade = true;
      u.depositPhone = deposit.phone; // set the number for withdrawals
      await u.save();

      if (u.referredBy) {
        const refUser = await User.findOne({ email: u.referredBy });
        if (refUser) {
          const rewardRule = REFERRAL_RULES.find(r => deposit.amount >= r.min);
          if (rewardRule) { refUser.earning += rewardRule.reward; await refUser.save(); }
        }
      }
    }
  }

  // Update Telegram message
  if (deposit.telegramMessageId) {
    await tgSend(
      `🟢 Deposit ${deposit.status}\nEmail: ${deposit.email}\nPhone: ${deposit.phone}\nAmount: KES ${deposit.amount}`,
      null,
      TG_CHAT,
      deposit.telegramMessageId
    );
  }

  res.send(`Deposit ${deposit.status}`);
});

// Withdraw (only Mon-Fri, only from deposit phone)
app.post('/api/withdraw', auth, async (req, res) => {
  const { amount, phone } = req.body || {};
  if (!amount || !phone) return res.status(400).json({ error: 'amount & phone required' });

  const today = new Date().getDay(); // 0=Sun, 6=Sat
  if (today === 0 || today === 6) return res.status(400).json({ error: 'Withdrawals allowed only Monday to Friday' });

  const u = await User.findOne({ email: req.user.email });
  if (!u) return res.status(404).json({ error: 'User not found' });

  if (!u.firstDepositMade) return res.status(400).json({ error: 'You must make a deposit first to withdraw' });
  if (phone !== u.depositPhone) return res.status(400).json({ error: `You must use your deposit phone (${u.depositPhone}) for withdrawal` });
  if (u.earning < Number(amount)) return res.status(400).json({ error: 'Insufficient earnings balance' });

  const pending = await Withdrawal.findOne({ email: u.email, status: 'PENDING' });
  if (pending) return res.status(400).json({ error: 'You have a pending withdrawal' });

  const w = new Withdrawal({ id: crypto.randomUUID(), email: u.email, phone, amount: Number(amount), status: 'PENDING', requestedAt: Date.now() });
  await w.save();

  const text = `🔵 <b>New Withdrawal Request</b>\nEmail: ${u.email}\nPhone: ${phone}\nAmount: KES ${amount}\nEarning Balance: KES ${u.earning}\nWithdraw ID: ${w.id}\nStatus: PENDING`;
  const buttons = [[
    { text: '✅ Approve', url: `${DOMAIN}/api/admin/withdrawals/${w.id}/approve?token=${ADMIN_PASS}` },
    { text: '❌ Reject', url: `${DOMAIN}/api/admin/withdrawals/${w.id}/reject?token=${ADMIN_PASS}` }
  ]];

  const tgResponse = await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    })
  });
  const tgData = await tgResponse.json();
  if (tgData.ok && tgData.result) { w.telegramMessageId = tgData.result.message_id; await w.save(); }

  res.json({ message: 'Withdrawal submitted' });
});

// Approve withdraw
app.get('/api/admin/withdrawals/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const token = req.query.token;
  if (token !== ADMIN_PASS) return res.status(401).send('Unauthorized');

  const w = await Withdrawal.findOne({ id });
  if (!w) return res.status(404).send('Withdrawal not found');
  if (w.status !== 'PENDING') return res.status(400).send('Withdrawal already processed');

  w.status = action.toUpperCase() === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  w.processedAt = Date.now();
  await w.save();

  if (w.status === 'APPROVED') {
    const u = await User.findOne({ email: w.email });
    if (u) {
      u.earning -= Number(w.amount);
      await u.save();
    }
  }

  if (w.telegramMessageId) {
    await tgSend(
      `🔵 Withdrawal ${w.status}\nEmail: ${w.email}\nPhone: ${w.phone}\nAmount: KES ${w.amount}`,
      null,
      TG_CHAT,
      w.telegramMessageId
    );
  }

  res.send(`Withdrawal ${w.status}`);
});

// Daily earnings at 12:00 AM Nairobi (every 24 hours)
async function runDailyEarnings() {
  const users = await User.find();
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Nairobi' });
  for (const u of users) {
    if (u.lastPaid === today) continue;
    let earn = 0;
    for (const f of u.fridges) {
      const fridge = FRIDGES.find(fr => fr.id === f.id);
      if (fridge) earn += fridge.dailyEarn;
    }
    if (earn > 0) {
      u.earning += earn;
      u.lastPaid = today;
      await u.save();
    }
  }
}

// Run daily earnings on server start to ensure it's up to date
runDailyEarnings();

// Check every minute if it's 00:00 Nairobi time
setInterval(async () => {
  const now = new Date();
  const hours = now.toLocaleString('en-US', { hour12: false, hour: '2-digit', timeZone: 'Africa/Nairobi' });
  const minutes = now.toLocaleString('en-US', { minute: '2-digit', timeZone: 'Africa/Nairobi' });
  if (Number(hours) === 0 && Number(minutes) === 0) await runDailyEarnings();
}, 60000); // 60000 ms = 1 minute

// Status
app.get('/api/status', (req, res) => res.json({ status: 'ok', time: Date.now(), till: MPESA_TILL, name: MPESA_NAME }));

// Fridges list
app.get('/api/fridges', (req, res) => res.json({ fridges: FRIDGES }));

// Buy fridge
app.post('/api/buy', auth, async (req, res) => {
  const { fridgeId } = req.body || {};
  const item = FRIDGES.find(f => f.id === fridgeId);
  if (!item) return res.status(400).json({ error: 'Invalid fridge' });
  const u = await User.findOne({ email: req.user.email });
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.balance < item.price) return res.status(400).json({ error: 'Insufficient balance' });
  u.balance -= item.price;
  u.fridges.push({ id: item.id, name: item.name, price: item.price, boughtAt: Date.now() });
  await u.save();
  res.json({ message: `Bought ${item.name}`, balance: u.balance });
});

// Profile
app.get('/api/me', auth, async (req, res) => {
  const u = await User.findOne({ email: req.user.email });
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ user: u });
});

// Start server
app.listen(PORT, () => console.log(`Bitfreeze running on ${PORT}`));
