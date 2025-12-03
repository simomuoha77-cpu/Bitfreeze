/**
 * Bitfreeze - index.js
 * Single-file server for Termux / small VPS
 *
 * - node-persist used for simple file storage (persist/ directory)
 * - JWT for auth
 * - referral rewards applied when deposit confirmed
 * - withdrawals require admin approval (endpoint /api/admin/withdrawals)
 * - optional Daraja (Safaricom) STK push integration using env vars (see README)
 *
 * Run: node index.js
 * Or: pm2 start index.js --name bitfreeze --update-env -f
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
const fetch = require('node-fetch'); // included in npm deps

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SECRET = process.env.BF_SECRET || 'bitfreeze_dev_secret_change_me';

// Referral reward mapping (KES deposit -> referral reward)
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

// Optional: your site's receiving phone number (where real M-PESA funds go)
const SITE_RECEIVER_PHONE = process.env.SITE_RECEIVER_PHONE || '0707389787';

// Optional Daraja config environment variables, when available
const DAR_KEY = process.env.DAR_CONSUMER_KEY || '';
const DAR_SECRET = process.env.DAR_CONSUMER_SECRET || '';
const DAR_ENVIRONMENT = process.env.DAR_ENVIRONMENT || 'sandbox'; // sandbox or production
const USE_DARAJA = Boolean(DAR_KEY && DAR_SECRET);

// Simulated external M-PESA balances for test mode (NOT used when DAR integration is enabled)
const simulatedMpesa = (process.env.SIMULATE_MPESA === 'true');

// initialize storage
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist') });

  // ensure default objects exist
  if (!await storage.getItem('users')) await storage.setItem('users', []);
  if (!await storage.getItem('deposits')) await storage.setItem('deposits', {}); // { email: phone }
  if (!await storage.getItem('withdrawals')) await storage.setItem('withdrawals', []); // pending withdrawals
  if (!await storage.getItem('mpesaBalances')) {
    // small demo balances only when simulation mode is on
    await storage.setItem('mpesaBalances', {
      '0712345678': 5000,
      '0707389787': 100000,
      '0710000000': 2000
    });
  }
  console.log('Storage initialized.');
})();

// helpers
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

// auth middleware
function auth(req, res, next) {
  const a = req.headers.authorization;
  if (!a || !a.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = a.slice(7);
  try {
    const p = jwt.verify(token, SECRET);
    req.user = p;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// small util: compute referral reward for an amount
function referralRewardFor(amount) {
  // find highest matching rule where min <= amount
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
  const users = await storage.getItem('users');
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'User already exists' });

  const hashed = await bcrypt.hash(password, 10);
  const newUser = { email, password: hashed, phone: phone || null, balance: 0, fridges: [], createdAt: Date.now(), referrals: [] };
  await saveUser(newUser);

  // if ref is present (ref param is inviter's email), record on inviter (but rewards only when deposit happens)
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
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'Identifier and password required' });
  const users = await storage.getItem('users');
  const user = users.find(u => u.email === identifier || u.phone === identifier);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ email: user.email }, SECRET, { expiresIn: '7d' });
  return res.json({ token, email: user.email, phone: user.phone, balance: user.balance });
});

// Public: get fridges
app.get('/api/fridges', (req, res) => {
  res.json({ fridges: FRIDGES });
});

// me
app.get('/api/me', auth, async (req, res) => {
  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  res.json({ user: { email: user.email, phone: user.phone, balance: user.balance || 0, fridges: user.fridges || [], referrals: user.referrals || [] } });
});

// Deposit: if you enable Daraja env vars, this route will attempt STK Push and return a "checkoutId" to poll.
// If Daraja not configured, the server uses simulation mode: it expects {phone, mpesaPin, amount} and will credit immediately if correct in simulated balances.
app.post('/api/deposit', auth, async (req, res) => {
  const amount = Number(req.body.amount || 0);
  const phone = String(req.body.phone || '').trim();
  const mpesaPin = String(req.body.mpesaPin || '').trim(); // used only in simulation mode
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount > 0 required' });
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  // real Daraja mode (if configured) - initiate STK Push
  if (USE_DARAJA) {
    // IMPORTANT: production-grade Daraja flow requires token management, callback URL and async confirmation handling.
    // Here we only return a helpful response to indicate STK should be triggered by a dedicated Daraja helper (not implemented automatically).
    return res.json({ message: 'Daraja enabled on server. Trigger STK Push from your Daraja integration and confirm via callback.' });
  }

  // simulation mode (local test only). This mode will check simulated mpesaBalances and mpesaPin.
  if (!simulatedMpesa) {
    return res.status(400).json({ error: 'Payment functionality not available (no Daraja and simulation disabled)' });
  }

  const mpesaBalances = await storage.getItem('mpesaBalances') || {};
  // check phone exists in simulated dataset
  if (typeof mpesaBalances[phone] === 'undefined') {
    return res.status(400).json({ error: 'Payer not recognized in simulated M-PESA' });
  }

  // simple pin check (simulation)
  const pins = (await storage.getItem('mpesaPins')) || { '0712345678': '1234', '0707389787': '0000', '0710000000': '9999' };
  if (!mpesaPin || pins[phone] !== mpesaPin) return res.status(403).json({ error: 'Invalid M-PESA PIN (simulation)' });

  if (mpesaBalances[phone] < amount) return res.status(400).json({ error: 'Insufficient external M-PESA balance (simulation)' });

  // debit payer (simulation) and credit user
  mpesaBalances[phone] -= amount;
  await storage.setItem('mpesaBalances', mpesaBalances);

  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  user.balance = (user.balance || 0) + amount;
  await saveUser(user);

  // record deposit phone for this user (used to restrict withdrawals)
  const deposits = (await storage.getItem('deposits')) || {};
  deposits[user.email] = phone;
  await storage.setItem('deposits', deposits);

  // apply referral reward if there is an inviter
  // find inviter who has this user in their referrals array
  const users = await storage.getItem('users');
  for (const u of users) {
    if (u.referrals && u.referrals.find(r => r.email === user.email)) {
      // reward according to mapping
      const reward = referralRewardFor(amount);
      if (reward > 0) {
        u.balance = (u.balance || 0) + reward;
      }
      await saveUser(u);
      break;
    }
  }

  return res.json({ message: `Deposit of KES ${amount} (sim) successful`, balance: user.balance });
});

// Withdraw: only allowed from the phone used to deposit; creates a withdrawal request for admin approval
app.post('/api/withdraw', auth, async (req, res) => {
  const amount = Number(req.body.amount || 0);
  const phone = String(req.body.phone || '').trim();
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount > 0 required' });
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  if (amount < 200) return res.status(400).json({ error: 'Minimum withdrawal is KES 200' });

  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  const deposits = (await storage.getItem('deposits')) || {};
  const usedPhone = deposits[user.email];
  if (!usedPhone) return res.status(403).json({ error: 'No deposit phone recorded for this account' });
  if (usedPhone !== phone) return res.status(403).json({ error: 'Withdrawals allowed only from the phone used to deposit' });

  if ((user.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient account balance' });

  // create withdrawal request (admin must approve)
  const withdrawals = (await storage.getItem('withdrawals')) || [];
  const request = {
    id: crypto.randomUUID(),
    email: user.email,
    phone,
    amount,
    status: 'pending',
    requestedAt: Date.now()
  };
  withdrawals.push(request);
  await storage.setItem('withdrawals', withdrawals);

  return res.json({ message: 'Withdrawal request created and pending admin approval', requestId: request.id });
});

// Admin endpoints (simple, protected by admin token set via env BF_ADMIN_PASS)
function adminAuth(req, res, next) {
  const tok = req.headers['x-admin-token'] || '';
  if (!tok || tok !== (process.env.BF_ADMIN_PASS || 'admin-pass')) return res.status(401).json({ error: 'Admin auth required' });
  next();
}

// list pending withdrawals
app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
  const withdrawals = (await storage.getItem('withdrawals')) || [];
  res.json({ withdrawals });
});

// approve a withdrawal: will debit user and (if simulation) credit external mpesa balance
app.post('/api/admin/withdrawals/:id/approve', adminAuth, async (req, res) => {
  const id = req.params.id;
  const withdrawals = (await storage.getItem('withdrawals')) || [];
  const w = withdrawals.find(x => x.id === id);
  if (!w) return res.status(404).json({ error: 'Request not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: 'Request not pending' });

  const user = await getUserByEmail(w.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  if ((user.balance || 0) < w.amount) return res.status(400).json({ error: 'Insufficient account balance' });

  user.balance -= w.amount;
  await saveUser(user);

  // simulation: credit external balance for the phone
  if (simulatedMpesa) {
    const mpesaBalances = (await storage.getItem('mpesaBalances')) || {};
    mpesaBalances[w.phone] = (mpesaBalances[w.phone] || 0) + w.amount;
    await storage.setItem('mpesaBalances', mpesaBalances);
  }

  w.status = 'approved';
  w.processedAt = Date.now();
  await storage.setItem('withdrawals', withdrawals);

  return res.json({ message: 'Approved', request: w });
});

// reject
app.post('/api/admin/withdrawals/:id/reject', adminAuth, async (req, res) => {
  const id = req.params.id;
  const withdrawals = (await storage.getItem('withdrawals')) || [];
  const w = withdrawals.find(x => x.id === id);
  if (!w) return res.status(404).json({ error: 'Request not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: 'Request not pending' });
  w.status = 'rejected';
  w.processedAt = Date.now();
  await storage.setItem('withdrawals', withdrawals);
  return res.json({ message: 'Rejected', request: w });
});

// Buy fridge
app.post('/api/buy', auth, async (req, res) => {
  const { fridgeId } = req.body || {};
  if (!fridgeId) return res.status(400).json({ error: 'fridgeId required' });
  const item = FRIDGES.find(f => f.id === fridgeId);
  if (!item) return res.status(400).json({ error: 'Invalid fridge' });
  const user = await getUserByEmail(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  if ((user.balance || 0) < item.price) return res.status(400).json({ error: 'Insufficient balance' });

  user.balance -= item.price;
  user.fridges = user.fridges || [];
  user.fridges.push({ id: item.id, name: item.name, price: item.price, boughtAt: Date.now() });
  await saveUser(user);
  return res.json({ message: 'Bought ' + item.name, balance: user.balance });
});

// small status
app.get('/api/status', (req, res) => res.json({ status: 'ok', time: Date.now(), env: { daraja: USE_DARAJA ? 'on' : 'off' } }));

// serve static (public folder) is already configured by express.static

app.listen(PORT, () => console.log(`Bitfreeze server running on port ${PORT}`));
