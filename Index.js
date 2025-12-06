/**
 * Bitfreeze - Full server (index.js)
 *
 * - register / login (JWT)
 * - deposits (Daraja STK push if configured, otherwise pending)
 * - withdrawals (create request -> admin approves)
 * - referral rewards
 * - daily earnings job (credits per-fridge dailyEarn once per 24h)
 * - storage with node-persist (persist/ folder)
 * - optional email notifications (nodemailer)
 *
 * Edit .env for secrets and MPESA settings. See README snippet below.
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
const axios = require('axios'); // using axios to avoid node-fetch require quirks
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const app = express();

// ----- Config from env -----
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || process.env.BF_SECRET || 'bitfreeze_dev_secret_change_me';
const ADMIN_PASS = process.env.ADMIN_PASS || 'adminpass';
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const SITE_RECEIVER_PHONE = process.env.SITE_RECEIVER_PHONE || '0707389787';

// MPESA / Daraja env
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || '';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || '';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || ''; // till or shortcode
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '';
const MPESA_ENV = process.env.MPESA_ENV || 'sandbox'; // sandbox or production
const MPESA_CALLBACK_BASE = process.env.MPESA_CALLBACK_BASE || ''; // e.g. https://yourdomain.com

// Simulation toggle (if you want to allow simulated local deposits)
const SIMULATE_MPESA = (process.env.SIMULATE_MPESA || 'true').toLowerCase() === 'true';

// Referral rules (min deposit => reward)
const REFERRAL_RULES = [
  { min: 8000, reward: 500 },
  { min: 6000, reward: 350 },
  { min: 4000, reward: 250 },
  { min: 2000, reward: 150 },
  { min: 1000, reward: 100 },
  { min: 500,  reward: 50  },
];

// Fridges catalog (images should live under public/images)
const FRIDGES = [
  { id: '2ft',  name: '2 ft Fridge',  price: 500,  dailyEarn: 25,  image: '/images/fridge2ft.jpg' },
  { id: '4ft',  name: '4 ft Fridge',  price: 1000, dailyEarn: 55,  image: '/images/fridge4ft.jpg' },
  { id: '6ft',  name: '6 ft Fridge',  price: 2000, dailyEarn: 100, image: '/images/fridge6ft.jpg' },
  { id: '8ft',  name: '8 ft Fridge',  price: 4000, dailyEarn: 150, image: '/images/fridge8ft.jpg' },
  { id: '10ft', name: '10 ft Fridge', price: 6000, dailyEarn: 250, image: '/images/fridge10ft.jpg' },
  { id: '12ft', name: '12 ft Fridge', price: 8000, dailyEarn: 350, image: '/images/fridge12ft.jpg' },
];

// Nodemailer (optional)
const mailer = (EMAIL_USER && EMAIL_PASS) ? nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
}) : null;

// Middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Storage init
(async function initStorage(){
  await storage.init({ dir: path.join(__dirname, 'persist'), stringify: JSON.stringify, parse: JSON.parse });
  const ensure = async (k, defaultVal) => {
    const v = await storage.getItem(k);
    if (v === undefined) await storage.setItem(k, defaultVal);
  };
  await ensure('users', {});
  await ensure('deposits', {});
  await ensure('withdrawals', {});
  await ensure('meta', { lastDailyRun: 0 });
  console.log('Storage initialized.');
})().catch(err => {
  console.error('Storage init error', err);
  process.exit(1);
});

// Helpers
const makeId = (len = 8) => crypto.randomBytes(Math.max(1, len)).toString('hex').slice(0, len);

async function getUsersObj(){ return (await storage.getItem('users')) || {}; }
async function saveUsersObj(obj){ await storage.setItem('users', obj); }
async function getDeposits(){ return (await storage.getItem('deposits')) || {}; }
async function saveDeposits(obj){ await storage.setItem('deposits', obj); }
async function getWithdrawals(){ return (await storage.getItem('withdrawals')) || {}; }
async function saveWithdrawals(obj){ await storage.setItem('withdrawals', obj); }
async function getMeta(){ return (await storage.getItem('meta')) || {}; }
async function saveMeta(m){ await storage.setItem('meta', m); }

async function findUserByEmail(email){
  const users = await getUsersObj();
  return users[email] || null;
}
async function findUserByIdentifier(id){ // id may be email or phone
  const users = await getUsersObj();
  for (const k of Object.keys(users)){
    const u = users[k];
    if (u.email === id || (u.phone && u.phone === id)) return u;
  }
  return null;
}
async function putUser(u){
  const users = await getUsersObj();
  users[u.email] = u;
  await saveUsersObj(users);
}

// Auth middleware
function auth(req, res, next){
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Admin guard: x-admin-pass header OR body.adminPass
function adminAuth(req, res, next){
  const pass = (req.headers['x-admin-pass'] || req.body.adminPass || '');
  if (!pass || pass !== ADMIN_PASS) return res.status(403).json({ error: 'Forbidden - admin' });
  return next();
}

// Referral reward function
async function applyReferral(amount, userEmail){
  try {
    const user = await findUserByEmail(userEmail);
    if (!user) return;
    const referredBy = user.referredBy;
    if (!referredBy) return;

    const users = await getUsersObj();
    let refUser = null;
    for (const k of Object.keys(users)){
      const u = users[k];
      if (u.refCode === referredBy || u.email === referredBy) { refUser = u; break; }
    }
    if (!refUser) return;

    // pick largest rule that matches amount
    const rule = REFERRAL_RULES.find(r => amount >= r.min);
    if (!rule) return;

    refUser.balance = (refUser.balance || 0) + rule.reward;
    await putUser(refUser);

    if (mailer && EMAIL_USER) {
      mailer.sendMail({
        from: EMAIL_USER, to: refUser.email,
        subject: `Referral reward: KES ${rule.reward}`,
        text: `You earned KES ${rule.reward} because ${userEmail} deposited KES ${amount}. New balance: KES ${refUser.balance}`
      }).catch(()=>{});
    }
  } catch (e){
    console.error('applyReferral err', e && e.message);
  }
}

// ---- Daraja (Lipa na M-PESA) helpers ----
async function getDarajaToken(){
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) throw new Error('Daraja credentials missing');
  const base = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const url = MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
    : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
  const resp = await axios.get(url, { headers: { Authorization: `Basic ${base}` }});
  return resp.data.access_token;
}

function darajaTimestamp(){
  // format YYYYMMDDHHmmss
  const d = new Date();
  const y = d.getFullYear().toString();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  const ss = String(d.getSeconds()).padStart(2,'0');
  return `${y}${m}${day}${hh}${mm}${ss}`;
}

async function darajaStkPush({ phone, amount, accountReference='Bitfreeze', description='Deposit' }){
  if (!MPESA_PASSKEY || !MPESA_SHORTCODE || !MPESA_CALLBACK_BASE) {
    throw new Error('Daraja STK config missing (PASSKEY/SHORTCODE/CALLBACK_BASE)');
  }
  const token = await getDarajaToken();
  const timestamp = darajaTimestamp();
  const password = Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + timestamp).toString('base64');
  const phoneNorm = phone.replace(/^\+/, '');
  const url = MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
    : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

  const payload = {
    BusinessShortCode: MPESA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(Number(amount)),
    PartyA: phoneNorm,
    PartyB: MPESA_SHORTCODE,
    PhoneNumber: phoneNorm,
    CallBackURL: `${MPESA_CALLBACK_BASE.replace(/\/+$/, '')}/api/mpesa/callback`,
    AccountReference: accountReference,
    TransactionDesc: description
  };

  const resp = await axios.post(url, payload, { headers: { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' }});
  return resp.data;
}

// ---- deposit recording helper ----
async function recordDeposit({ userEmail, amount, phone, status='pending', darajaRef=null }){
  const deposits = await getDeposits();
  const id = makeId(12);
  deposits[id] = { id, user: userEmail, amount: Number(amount), phone: phone || null, status, createdAt: Date.now(), darajaRef };
  await saveDeposits(deposits);
  return deposits[id];
}

// ---- API Routes ----

// List fridges
app.get('/api/fridges', (req, res) => res.json({ fridges: FRIDGES }));

// Get my profile
app.get('/api/me', auth, async (req, res) => {
  const user = await findUserByEmail(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password, ...safe } = user;
  return res.json({ user: safe });
});

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, phone, ref } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email & password required' });

    const users = await getUsersObj();
    if (users[email]) return res.status(400).json({ error: 'User exists' });

    const hashed = await bcrypt.hash(password, 10);
    const user = {
      email,
      phone: phone || null,
      password: hashed,
      balance: 0,
      fridges: [],
      refCode: makeId(6),
      referredBy: ref || null,
      lastDailyCredit: 0,
      createdAt: Date.now()
    };
    users[email] = user;
    await saveUsersObj(users);
    return res.json({ message: 'Registered', email });
  } catch (e){
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Login (identifier = email or phone)
app.post('/api/login', async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) return res.status(400).json({ error: 'Identifier & password required' });
    const user = await findUserByIdentifier(identifier);
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, email: user.email, phone: user.phone, balance: user.balance });
  } catch (e){
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Buy fridge (deduct balance)
app.post('/api/buy', auth, async (req, res) => {
  try {
    const { fridgeId } = req.body || {};
    if (!fridgeId) return res.status(400).json({ error: 'fridgeId required' });
    const item = FRIDGES.find(f => f.id === fridgeId);
    if (!item) return res.status(400).json({ error: 'Invalid fridge' });
    const user = await findUserByEmail(req.user.email);
    if (!user) return res.status(400).json({ error: 'User not found' });
    if ((user.balance || 0) < item.price) return res.status(400).json({ error: 'Insufficient balance' });
    user.balance -= item.price;
    user.fridges = user.fridges || [];
    user.fridges.push({ id: item.id, name: item.name, price: item.price, boughtAt: Date.now() });
    await putUser(user);
    return res.json({ message: 'Bought ' + item.name, balance: user.balance });
  } catch (e){
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Deposit (initiates STK push if Daraja configured, otherwise records pending deposit)
app.post('/api/deposit', auth, async (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    const phone = (req.body.phone || '').trim();
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    const user = await findUserByEmail(req.user.email);
    if (!user) return res.status(400).json({ error: 'User not found' });

    // Attempt real Daraja STK push when fully configured
    if (MPESA_CONSUMER_KEY && MPESA_CONSUMER_SECRET && MPESA_SHORTCODE && MPESA_PASSKEY && MPESA_CALLBACK_BASE){
      try {
        const stk = await darajaStkPush({ phone, amount, accountReference: user.email, description: 'Bitfreeze deposit' });
        // record pending deposit with daraja checkout id (if any)
        const checkoutRef = stk.CheckoutRequestID || stk.MerchantRequestID || null;
        const rec = await recordDeposit({ userEmail: user.email, amount, phone, status: 'pending', darajaRef: checkoutRef });
        return res.json({ message: 'STK Push initiated - check your phone', daraja: stk, depositId: rec.id });
      } catch (e){
        console.log('Daraja STK error:', e && e.message);
        // fall through to simulation or pending
      }
    }

    // If simulation enabled, create an immediate confirmed deposit (local testing)
    if (SIMULATE_MPESA){
      // optionally require PIN on client side — here we simply confirm (you previously complained about demo; use SIMULATE_MPESA=false in production)
      const rec = await recordDeposit({ userEmail: user.email, amount, phone, status: 'confirmed' });
      user.balance = (user.balance || 0) + Number(amount);
      await putUser(user);
      // apply referral
      await applyReferral(amount, user.email).catch(()=>{});
      // email user
      if (mailer && EMAIL_USER){
        mailer.sendMail({ from: EMAIL_USER, to: user.email, subject: `Deposit confirmed: KES ${amount}`, text: `Your deposit KES ${amount} confirmed. New balance: KES ${user.balance}` }).catch(()=>{});
      }
      return res.json({ message: 'Deposit simulated and confirmed (SIMULATE_MPESA=true)', depositId: rec.id, balance: user.balance });
    }

    // Otherwise, create pending deposit for manual admin confirmation
    const rec = await recordDeposit({ userEmail: user.email, amount, phone, status: 'pending' });
    if (mailer && EMAIL_USER){
      mailer.sendMail({ from: EMAIL_USER, to: EMAIL_USER, subject: `Pending deposit: KES ${amount}`, text: `Pending deposit ${rec.id}\nUser: ${user.email}\nPhone: ${phone}\nAmount: KES ${amount}` }).catch(()=>{});
    }
    return res.json({ message: 'Deposit recorded as pending. Admin must confirm.', depositId: rec.id });

  } catch (e){
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Daraja callback endpoint - Safaricom will POST results here. Must be public.
app.post('/api/mpesa/callback', async (req, res) => {
  // Accept any body, then process as needed.
  // Safaricom callback body differs by API and environment; we record references and if success -> confirm deposit
  try {
    const body = req.body || {};
    // Very conservative approach: search for CheckoutRequestID or MerchantRequestID
    const checkoutId = body.Body?.stkCallback?.CheckoutRequestID || body.CheckoutRequestID || body.MerchantRequestID || null;
    // A real implementation must parse response codes and amounts; this is a simple helpful handler.
    if (!checkoutId) {
      // respond 200 to keep Safaricom happy
      return res.json({ result: 'ignored - no checkout id' });
    }
    // Find deposit with darajaRef matching checkoutId and mark confirmed if callback suggests success
    const deposits = await getDeposits();
    const found = Object.values(deposits).find(d => (d.darajaRef && d.darajaRef === checkoutId));
    if (!found) return res.json({ result: 'no matching deposit' });

    // Detect success -> many safaricom stkp callback have ResultCode === 0
    const resultCode = body.Body?.stkCallback?.ResultCode ?? body.ResultCode ?? null;
    if (resultCode === 0 || resultCode === '0' || body.status === 'Success' || body.Status === 'Success') {
      found.status = 'confirmed';
      found.confirmedAt = Date.now();
      deposits[found.id] = found;
      await saveDeposits(deposits);
      // update user
      const user = await findUserByEmail(found.user);
      if (user) {
        user.balance = (user.balance || 0) + Number(found.amount);
        await putUser(user);
        await applyReferral(found.amount, user.email).catch(()=>{});
        if (mailer && EMAIL_USER) {
          mailer.sendMail({ from: EMAIL_USER, to: user.email, subject: `Deposit confirmed: KES ${found.amount}`, text: `Your deposit of KES ${found.amount} has been confirmed.` }).catch(()=>{});
        }
      }
      return res.json({ result: 'ok - confirmed' });
    } else {
      // mark failed
      found.status = 'failed';
      deposits[found.id] = found;
      await saveDeposits(deposits);
      return res.json({ result: 'not success' });
    }
  } catch (e){
    console.error('mpesa callback err', e && e.message);
    return res.json({ error: 'server error' });
  }
});

// Admin: list pending deposits
app.get('/api/admin/deposits', adminAuth, async (req, res) => {
  const deposits = await getDeposits();
  const pending = Object.values(deposits).filter(d => d.status === 'pending');
  return res.json({ pending });
});

// Admin: confirm deposit manually
app.post('/api/admin/deposits/confirm', adminAuth, async (req, res) => {
  try {
    const { depositId } = req.body || {};
    if (!depositId) return res.status(400).json({ error: 'depositId required' });
    const deposits = await getDeposits();
    const rec = deposits[depositId];
    if (!rec) return res.status(404).json({ error: 'Deposit not found' });
    if (rec.status === 'confirmed') return res.json({ message: 'Already confirmed' });

    rec.status = 'confirmed';
    rec.confirmedAt = Date.now();
    deposits[depositId] = rec;
    await saveDeposits(deposits);

    const user = await findUserByEmail(rec.user);
    if (!user) return res.status(400).json({ error: 'User not found' });

    user.balance = (user.balance || 0) + Number(rec.amount);
    await putUser(user);
    await applyReferral(rec.amount, rec.user).catch(()=>{});

    if (mailer && EMAIL_USER) {
      mailer.sendMail({ from: EMAIL_USER, to: user.email, subject: `Deposit confirmed: KES ${rec.amount}`, text: `Your deposit of KES ${rec.amount} has been confirmed. New balance: KES ${user.balance}` }).catch(()=>{});
    }

    return res.json({ message: 'Deposit confirmed', balance: user.balance });
  } catch (e){
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Withdraw: user request (pending admin)
app.post('/api/withdraw', auth, async (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    const phone = (req.body.phone || '').trim();
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    if (amount < 200) return res.status(400).json({ error: 'Minimum withdrawal is KES 200' });

    const user = await findUserByEmail(req.user.email);
    if (!user) return res.status(400).json({ error: 'User not found' });
    if ((user.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient account balance' });

    // enforce withdrawal phone must match last confirmed deposit phone
    const deposits = await getDeposits();
    const userDeposits = Object.values(deposits).filter(d => d.user === user.email && d.status === 'confirmed').sort((a,b)=>b.confirmedAt - a.confirmedAt);
    const usedPhone = userDeposits.length ? userDeposits[0].phone : null;
    if (!usedPhone) return res.status(403).json({ error: 'No deposit phone recorded for this account' });
    if (usedPhone !== phone) return res.status(403).json({ error: 'Withdrawals allowed only from the phone used to deposit' });

    const withdrawals = await getWithdrawals();
    const id = makeId(12);
    withdrawals[id] = { id, user: user.email, amount: Number(amount), phone, status: 'pending', requestedAt: Date.now() };
    await saveWithdrawals(withdrawals);

    // notify admin via email
    if (mailer && EMAIL_USER) {
      mailer.sendMail({
        from: EMAIL_USER, to: EMAIL_USER,
        subject: `Withdrawal request: KES ${amount} by ${user.email}`,
        text: `Withdraw request ${id}\nUser: ${user.email}\nPhone: ${phone}\nAmount: KES ${amount}\nApprove via /api/admin/withdraws/approve`
      }).catch(()=>{});
    }

    return res.json({ message: 'Withdrawal request created. Awaiting admin approval', requestId: id });
  } catch (e){
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Admin: list withdraw requests
app.get('/api/admin/withdraws', adminAuth, async (req, res) => {
  const w = await getWithdrawals();
  return res.json({ withdrawals: Object.values(w) });
});

// Admin: approve withdrawal
app.post('/api/admin/withdraws/approve', adminAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const withdrawals = await getWithdrawals();
    const w = withdrawals[id];
    if (!w) return res.status(404).json({ error: 'Withdraw request not found' });
    if (w.status !== 'pending') return res.json({ message: 'Already processed' });

    const user = await findUserByEmail(w.user);
    if (!user) return res.status(400).json({ error: 'User not found' });
    if ((user.balance || 0) < w.amount) return res.status(400).json({ error: 'Insufficient balance' });

    user.balance -= w.amount;
    await putUser(user);

    w.status = 'approved';
    w.approvedAt = Date.now();
    withdrawals[id] = w;
    await saveWithdrawals(withdrawals);

    if (mailer && EMAIL_USER) {
      mailer.sendMail({ from: EMAIL_USER, to: user.email, subject: `Withdrawal approved: KES ${w.amount}`, text: `Your withdrawal of KES ${w.amount} has been approved. New balance: KES ${user.balance}` }).catch(()=>{});
    }

    return res.json({ message: 'Withdrawal approved and balance deducted', balance: user.balance });
  } catch (e){
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Admin: reject withdrawal
app.post('/api/admin/withdraws/reject', adminAuth, async (req, res) => {
  try {
    const { id, reason } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const withdrawals = await getWithdrawals();
    const w = withdrawals[id];
    if (!w) return res.status(404).json({ error: 'Withdraw request not found' });
    if (w.status !== 'pending') return res.json({ message: 'Already processed' });

    w.status = 'rejected';
    w.rejectionReason = reason || 'Rejected';
    w.rejectedAt = Date.now();
    withdrawals[id] = w;
    await saveWithdrawals(withdrawals);

    const user = await findUserByEmail(w.user);
    if (mailer && EMAIL_USER && user) {
      mailer.sendMail({ from: EMAIL_USER, to: user.email, subject: `Withdrawal rejected: ${id}`, text: `Your withdrawal request ${id} was rejected. Reason: ${w.rejectionReason}` }).catch(()=>{});
    }

    return res.json({ message: 'Withdrawal rejected' });
  } catch (e){
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Admin: basic info
app.get('/api/admin/info', adminAuth, async (req, res) => {
  const users = await getUsersObj();
  const deposits = await getDeposits();
  const withdrawals = await getWithdrawals();
  return res.json({ users: Object.keys(users).length, deposits: Object.keys(deposits).length, withdrawals: Object.keys(withdrawals).length });
});

// ---- Daily earnings job (run once per 24 hours) ----
// This cron runs at 00:05 UTC daily. Adjust schedule as you need.
cron.schedule('5 0 * * *', async () => {
  try {
    const meta = await getMeta();
    const lastRun = meta.lastDailyRun || 0;
    // Very simple protection: if last run was less than 20 hours ago, skip.
    if (Date.now() - lastRun < (20 * 60 * 60 * 1000)) return;
    const users = await getUsersObj();
    for (const email of Object.keys(users)){
      const u = users[email];
      if (!u.fridges || u.fridges.length === 0) continue;
      let credit = 0;
      for (const f of u.fridges){
        const cfg = FRIDGES.find(x => x.id === f.id);
        if (cfg && cfg.dailyEarn) credit += cfg.dailyEarn;
      }
      if (credit > 0) {
        u.balance = (u.balance || 0) + credit;
        await putUser(u);
        if (mailer && EMAIL_USER) {
          mailer.sendMail({ from: EMAIL_USER, to: u.email, subject: `Daily earnings: KES ${credit}`, text: `Your fridges earned KES ${credit} today. New balance: KES ${u.balance}` }).catch(()=>{});
        }
      }
    }
    meta.lastDailyRun = Date.now();
    await saveMeta(meta);
    console.log('Daily earnings applied.');
  } catch (e){
    console.error('daily cron error', e && e.message);
  }
}, { timezone: 'UTC' });

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`Bitfreeze server running on port ${PORT}`);
});
