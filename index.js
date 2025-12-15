// ===============================
// Bitfreeze – FULL index.js (PATCHED & STABLE)
// - Manual MPESA (email approval only)
// - Deposit / Withdraw FIXED
// - node-persist crash FIXED
// - Works on Railway domain (no localhost hardcode)
// ===============================

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const storage = require('node-persist');
const path = require('path');

// ===============================
// ENV
// ===============================
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.BF_SECRET;
const DOMAIN = process.env.DOMAIN; // MUST be your Railway domain
const ADMIN_PASS = process.env.ADMIN_PASS;

const DEPOSIT_EMAIL = process.env.DEPOSIT_EMAIL;
const DEPOSIT_EMAIL_PASS = process.env.DEPOSIT_EMAIL_PASS;
const WITHDRAW_EMAIL = process.env.WITHDRAW_EMAIL;
const WITHDRAW_EMAIL_PASS = process.env.WITHDRAW_EMAIL_PASS;

const MPESA_TILL = process.env.MPESA_TILL;
const MPESA_NAME = process.env.MPESA_NAME;

// ===============================
// APP
// ===============================
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===============================
// STORAGE (CRASH FIX)
// ===============================
(async () => {
  await storage.init({
    dir: path.join(__dirname, 'storage'),
    forgiveParseErrors: true
  });
  await ensure('users', []);
  await ensure('deposits', []);
  await ensure('withdrawals', []);
  console.log('Storage initialized.');
})();

async function ensure(key, def) {
  const v = await storage.getItem(key);
  if (!v) await storage.setItem(key, def);
}

// ===============================
// EMAIL (TIMEOUT FIX)
// ===============================
function mailer(user, pass) {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    socketTimeout: 10000,
    connectionTimeout: 10000
  });
}

const depositMailer = mailer(DEPOSIT_EMAIL, DEPOSIT_EMAIL_PASS);
const withdrawMailer = mailer(WITHDRAW_EMAIL, WITHDRAW_EMAIL_PASS);

// ===============================
// AUTH
// ===============================
function auth(req, res, next) {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.sendStatus(401);
  try {
    req.user = jwt.verify(t, SECRET);
    next();
  } catch {
    res.sendStatus(401);
  }
}

// ===============================
// SAMPLE FRIDGES
// ===============================
const FRIDGES = [
  { id: 'f1', name: '2FT Fridge', price: 1000, image: '/images/fridge2ft.jpg' },
  { id: 'f2', name: '3FT Fridge', price: 2000, image: '/images/fridge3ft.jpg' },
  { id: 'f3', name: '4FT Fridge', price: 3000, image: '/images/fridge4ft.jpg' }
];

// ===============================
// API
// ===============================
app.get('/api/fridges', (req, res) => res.json(FRIDGES));

app.get('/api/me', auth, async (req, res) => {
  const users = await storage.getItem('users');
  const u = users.find(x => x.id === req.user.id);
  if (!u) return res.sendStatus(404);
  res.json({
    email: u.email,
    phone: u.phone,
    balance: u.balance,
    fridges: u.fridges,
    referral: `${DOMAIN}/register?ref=${u.id}`,
    till: MPESA_TILL
  });
});

// ===============================
// DEPOSIT (FIXED)
// ===============================
app.post('/api/deposit', auth, async (req, res) => {
  try {
    const { phone, amount, code } = req.body;
    if (!phone || !amount || !code) return res.status(400).json({ error: 'Missing fields' });

    const deposits = await storage.getItem('deposits');
    const dep = {
      id: crypto.randomUUID(),
      userId: req.user.id,
      phone,
      amount,
      code,
      status: 'pending',
      ts: Date.now()
    };

    deposits.push(dep);
    await storage.setItem('deposits', deposits);

    await depositMailer.sendMail({
      from: `Bitfreeze <${DEPOSIT_EMAIL}>`,
      to: DEPOSIT_EMAIL,
      subject: 'New Deposit Approval',
      text:
`Amount: ${amount}
Phone: ${phone}
Code: ${code}

APPROVE:
${DOMAIN}/admin.html?action=approve&type=deposit&id=${dep.id}

REJECT:
${DOMAIN}/admin.html?action=reject&type=deposit&id=${dep.id}`
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('DEPOSIT ERROR', e);
    res.status(500).json({ error: 'Deposit failed' });
  }
});

// ===============================
// WITHDRAW (FIXED)
// ===============================
app.post('/api/withdraw', auth, async (req, res) => {
  try {
    const { phone, amount } = req.body;
    if (!phone || !amount || amount < 200) return res.status(400).json({ error: 'Invalid' });

    const withdrawals = await storage.getItem('withdrawals');
    const w = {
      id: crypto.randomUUID(),
      userId: req.user.id,
      phone,
      amount,
      status: 'pending',
      ts: Date.now()
    };

    withdrawals.push(w);
    await storage.setItem('withdrawals', withdrawals);

    await withdrawMailer.sendMail({
      from: `Bitfreeze <${WITHDRAW_EMAIL}>`,
      to: WITHDRAW_EMAIL,
      subject: 'Withdraw Approval',
      text:
`Amount: ${amount}
Phone: ${phone}

APPROVE:
${DOMAIN}/admin.html?action=approve&type=withdraw&id=${w.id}

REJECT:
${DOMAIN}/admin.html?action=reject&type=withdraw&id=${w.id}`
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('WITHDRAW ERROR', e);
    res.status(500).json({ error: 'Withdraw failed' });
  }
});

// ===============================
// START
// ===============================
app.listen(PORT, () => console.log('Bitfreeze running on', PORT));
    
