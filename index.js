/**
 * index.js - Bitfreeze server (referral tiers implemented)
 *
 * Notes:
 * - This is a local/demo server using node-persist for storage.
 * - For real M-PESA you'd replace the deposit simulation with Daraja (STK push / callbacks).
 * - This code will NOT delete images or balances. It only updates users & deposits storage.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const storage = require('node-persist');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.BF_SECRET || 'bitfreeze_dev_secret_change_me';

// simple fridge catalog
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

// ----------------------
// Simulated external M-PESA (demo).
// Replace when you integrate Daraja for production.
// ----------------------
const mpesaBalances = {
  '0712345678': 5000,
  '0707389787': 100000, // site receiver account (example)
  '0710000000': 2000
};
const mpesaPins = {
  '0712345678': '1234',
  '0707389787': '0000',
  '0710000000': '9999'
};

// ----------------------
// Storage init
// ----------------------
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist'), ttl: false });

  // ensure keys exist
  const users = (await storage.getItem('users')) || [];
  const deposits = (await storage.getItem('deposits')) || []; // array of deposit records
  await storage.setItem('users', users);
  await storage.setItem('deposits', deposits);

  console.log('Storage initialized.');
})();

// ----------------------
// Helpers
// ----------------------
async function findUser(email) {
  const users = (await storage.getItem('users')) || [];
  return users.find(u => u.email === email);
}
async function findUserByReferralCode(code) {
  const users = (await storage.getItem('users')) || [];
  return users.find(u => u.referralCode === code);
}
async function saveUser(user) {
  const users = (await storage.getItem('users')) || [];
  const idx = users.findIndex(u => u.email === user.email);
  if (idx > -1) users[idx] = user;
  else users.push(user);
  await storage.setItem('users', users);
}
async function addDepositRecord(record) {
  const deposits = (await storage.getItem('deposits')) || [];
  deposits.push(record);
  await storage.setItem('deposits', deposits);
}
function makeReferralCode() {
  return crypto.randomBytes(4).toString('hex'); // 8 chars
}
function getReferralReward(amount) {
  // tiers:
  // 500 -> 50
  // 1000 -> 100
  // 2000 -> 150
  // 4000 -> 250
  // 6000 -> 350
  // 8000 -> 500
  // For amounts between, pick the highest tier <= amount.
  const tiers = [
    { threshold: 8000, reward: 500 },
    { threshold: 6000, reward: 350 },
    { threshold: 4000, reward: 250 },
    { threshold: 2000, reward: 150 },
    { threshold: 1000, reward: 100 },
    { threshold: 500, reward: 50 }
  ];
  for (const t of tiers) {
    if (amount >= t.threshold) return t.reward;
  }
  return 0;
}

// ----------------------
// Auth helpers
// ----------------------
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

// ----------------------
// Routes
// ----------------------

// public: fridges
app.get('/api/fridges', (req, res) => {
  res.json({ fridges: FRIDGES });
});

// register: accepts optional `ref` (referral code)
app.post('/api/register', async (req, res) => {
  const { email, password, phone, ref } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  if (await findUser(email)) return res.status(400).json({ error: 'User already exists' });

  const hashed = await bcrypt.hash(password, 10);
  const referralCode = makeReferralCode();

  const newUser = {
    email,
    password: hashed,
    phone: phone || null,
    balance: 0,
    fridges: [],
    referralCode,
    referredBy: ref || null,      // store referral code (if any)
    referralEarned: 0            // total earned via referrals (as referrer)
  };

  await saveUser(newUser);
  return res.json({ message: 'User registered successfully', email, referralCode });
});

// login (identifier = email or phone)
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'Identifier and password required' });

  const users = (await storage.getItem('users')) || [];
  const user = users.find(u => u.email === identifier || u.phone === identifier);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ email: user.email }, SECRET, { expiresIn: '7d' });
  return res.json({ token, email: user.email, phone: user.phone, balance: user.balance });
});

// me
app.get('/api/me', auth, async (req, res) => {
  const user = await findUser(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  const referralLink = `${req.protocol}://${req.get('host')}/register.html?ref=${user.referralCode}`;
  res.json({
    user: {
      email: user.email,
      phone: user.phone,
      balance: user.balance,
      fridges: user.fridges || [],
      referralCode: user.referralCode,
      referralLink,
      referralEarned: user.referralEarned || 0
    }
  });
});

// Deposit (STK push simulation).
// Body: { amount, phone, mpesaPin }
// IMPORTANT: Replace this simulation with real Daraja STK push in production.
app.post('/api/deposit', auth, async (req, res) => {
  const amount = Number(req.body.amount || 0);
  const phone = (req.body.phone || '').trim();
  const mpesaPin = String(req.body.mpesaPin || '').trim(); // in simulation we verify pin

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  if (!mpesaPin) return res.status(400).json({ error: 'M-PESA PIN required' });

  // simulate external mpesa check
  const externalBal = mpesaBalances[phone];
  const expectedPin = mpesaPins[phone];
  if (typeof externalBal === 'undefined' || typeof expectedPin === 'undefined') {
    return res.status(400).json({ error: 'Payer not recognized in demo M-PESA' });
  }
  if (expectedPin !== mpesaPin) return res.status(403).json({ error: 'Invalid M-PESA PIN' });
  if (externalBal < amount) return res.status(400).json({ error: 'Insufficient external M-PESA balance' });

  // simulate transfer: deduct payer (site receiver not tracked here)
  mpesaBalances[phone] -= amount;
  // record deposit
  const depositEntry = {
    id: crypto.randomBytes(6).toString('hex'),
    email: req.user.email,
    phone,
    amount,
    date: Date.now()
  };
  await addDepositRecord(depositEntry);

  // credit the user's site balance
  const user = await findUser(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  user.balance = (user.balance || 0) + amount;
  // save last deposit phone for withdrawal restriction
  user.lastDepositPhone = phone;
  await saveUser(user);

  // Referral reward logic (scaled tiers) - reward referrer for this deposit
  if (user.referredBy) {
    const reward = getReferralReward(amount); // 0 if below 500
    if (reward > 0) {
      const referrer = await findUserByReferralCode(user.referredBy);
      if (referrer) {
        referrer.balance = (referrer.balance || 0) + reward;
        referrer.referralEarned = (referrer.referralEarned || 0) + reward;
        // Optionally you can record referral transactions separately
        await saveUser(referrer);
      }
    }
  }

  return res.json({ message: `Deposit of KES ${amount} processed`, balance: user.balance });
});

// Withdraw - only allowed from the same phone used to deposit
// Body: { amount, phone }
app.post('/api/withdraw', auth, async (req, res) => {
  const amount = Number(req.body.amount || 0);
  const phone = (req.body.phone || '').trim();

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  if (amount < 200) return res.status(400).json({ error: 'Minimum withdrawal is KES 200' });

  const user = await findUser(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  if (!user.lastDepositPhone) return res.status(403).json({ error: 'No deposit phone recorded for this account' });
  if (user.lastDepositPhone !== phone) return res.status(403).json({ error: 'Withdrawals allowed only from the phone used to deposit' });

  if ((user.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient account balance' });

  // simulate payout: decrease user balance and increase external phone balance
  user.balance -= amount;
  mpesaBalances[phone] = (mpesaBalances[phone] || 0) + amount;
  await saveUser(user);

  return res.json({ message: `Withdrawn KES ${amount} to ${phone}`, balance: user.balance });
});

// Buy fridge
app.post('/api/buy', auth, async (req, res) => {
  const { fridgeId } = req.body || {};
  const item = FRIDGES.find(f => f.id === fridgeId);
  if (!item) return res.status(400).json({ error: 'Invalid fridge' });

  const user = await findUser(req.user.email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  if ((user.balance || 0) < item.price) return res.status(400).json({ error: 'Insufficient balance' });

  user.balance -= item.price;
  user.fridges = user.fridges || [];
  user.fridges.push({ id: item.id, name: item.name, price: item.price, boughtAt: Date.now() });
  await saveUser(user);

  return res.json({ message: 'Bought ' + item.name, balance: user.balance });
});

// dev route: reset (CAREFUL)
app.post('/api/_reset', async (req, res) => {
  await storage.setItem('users', []);
  await storage.setItem('deposits', []);
  res.json({ ok: true });
});

// debug: list deposits (admin)
app.get('/api/_deposits', async (req, res) => {
  const deposits = (await storage.getItem('deposits')) || [];
  res.json({ deposits });
});

// start
app.listen(PORT, () => console.log(`Bitfreeze server running on port ${PORT}`));
