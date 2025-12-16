require('dotenv').config();

/**

==============================================================

BITFREEZE - FULL SIMPLE INDEX.JS (STABLE STYLE)

==============================================================

Single Telegram bot (admin only)


No WhatsApp link pushed by bot


WhatsApp link can exist ONLY on frontend (optional)


node-persist storage (safe, restart-proof)


Daily earnings credited at 12:00 AM (once per day)


Very verbose & linear (easy to debug, no magic)


============================================================== */


// ================== IMPORTS ================== const express = require('express'); const bcrypt = require('bcryptjs'); const jwt = require('jsonwebtoken'); const bodyParser = require('body-parser'); const cors = require('cors'); const storage = require('node-persist'); const path = require('path'); const crypto = require('crypto'); const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ================== APP ================== const app = express();

// ================== BASIC CONFIG ================== const PORT = process.env.PORT ? Number(process.env.PORT) : 3000; const SECRET = process.env.BF_SECRET || 'bitfreeze_dev_secret'; const DOMAIN = process.env.DOMAIN || 'http://localhost:' + PORT; const ADMIN_PASS = process.env.ADMIN_PASS || 'admin-pass';

// ================== TELEGRAM BOT (ONE ONLY) ================== const TG_BOT = process.env.TELEGRAM_BOT_TOKEN || ''; const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

// ================== MPESA DISPLAY ================== const MPESA_TILL = process.env.MPESA_TILL || '6992349'; const MPESA_NAME = process.env.MPESA_NAME || 'Bitfreeze';

// ================== FRIDGES CATALOG ================== const FRIDGES = [ { id: '2ft',  name: '2 ft Fridge',  price: 500,  dailyEarn: 25 }, { id: '4ft',  name: '4 ft Fridge',  price: 1000, dailyEarn: 55 }, { id: '6ft',  name: '6 ft Fridge',  price: 2000, dailyEarn: 100 }, { id: '8ft',  name: '8 ft Fridge',  price: 4000, dailyEarn: 150 }, { id: '10ft', name: '10 ft Fridge', price: 6000, dailyEarn: 250 }, { id: '12ft', name: '12 ft Fridge', price: 8000, dailyEarn: 350 } ];

// ================== MIDDLEWARE ================== app.use(bodyParser.json({ limit: '1mb' })); app.use(cors({ origin: '*' })); app.use(express.static(path.join(__dirname, 'public')));

// ================== STORAGE INIT ================== (async function initStorage(){ await storage.init({ dir: path.join(__dirname, 'persist'), forgiveParseErrors: true });

if (!await storage.getItem('users')) await storage.setItem('users', []); if (!await storage.getItem('deposits')) await storage.setItem('deposits', []); if (!await storage.getItem('withdrawals')) await storage.setItem('withdrawals', []);

console.log('[OK] Storage ready'); })();

// ================== HELPERS ================== async function getUsers(){ return (await storage.getItem('users')) || []; }

async function saveUsers(users){ await storage.setItem('users', users); }

async function findUser(email){ const users = await getUsers(); return users.find(u => u.email === email); }

async function saveUser(user){ const users = await getUsers(); const i = users.findIndex(u => u.email === user.email); if (i >= 0) users[i] = user; else users.push(user); await saveUsers(users); }

function auth(req, res, next){ const h = req.headers.authorization; if (!h || !h.startsWith('Bearer ')){ return res.status(401).json({ error: 'Unauthorized' }); } try{ req.user = jwt.verify(h.slice(7), SECRET); next(); }catch(e){ return res.status(401).json({ error: 'Invalid token' }); } }

async function tgSend(text, buttons){ if (!TG_BOT || !TG_CHAT) return; const payload = { chat_id: TG_CHAT, text, parse_mode: 'HTML' }; if (buttons) payload.reply_markup = { inline_keyboard: buttons }; try{ await fetch(https://api.telegram.org/bot${TG_BOT}/sendMessage, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }catch{} }

// ================== AUTH ROUTES ================== app.post('/api/register', async (req, res) => { const { email, password, phone } = req.body || {}; if (!email || !password) return res.status(400).json({ error: 'Missing data' });

const users = await getUsers(); if (users.find(u => u.email === email)){ return res.status(400).json({ error: 'User exists' }); }

const hash = await bcrypt.hash(password, 10); users.push({ email, password: hash, phone: phone || '', balance: 0, fridges: [], lastEarningDay: null });

await saveUsers(users); res.json({ message: 'Registered' }); });

app.post('/api/login', async (req, res) => { const { email, password } = req.body || {}; const u = await findUser(email); if (!u) return res.status(400).json({ error: 'Invalid login' });

const ok = await bcrypt.compare(password, u.password); if (!ok) return res.status(400).json({ error: 'Invalid login' });

const token = jwt.sign({ email: u.email }, SECRET, { expiresIn: '7d' }); res.json({ token, user: { email: u.email, balance: u.balance, phone: u.phone } }); });

// ================== USER ROUTES ================== app.get('/api/me', auth, async (req, res) => { const u = await findUser(req.user.email); res.json({ user: u }); });

app.get('/api/fridges', (req, res) => { res.json({ fridges: FRIDGES }); });

app.post('/api/buy', auth, async (req, res) => { const { fridgeId } = req.body || {}; const item = FRIDGES.find(f => f.id === fridgeId); if (!item) return res.status(400).json({ error: 'Invalid fridge' });

const u = await findUser(req.user.email); if (u.balance < item.price){ return res.status(400).json({ error: 'Insufficient balance' }); }

u.balance -= item.price; u.fridges.push({ id: item.id, dailyEarn: item.dailyEarn }); await saveUser(u);

res.json({ message: 'Fridge purchased', balance: u.balance }); });

// ================== DEPOSITS ================== app.post('/api/deposit', auth, async (req, res) => { const { amount, mpesaCode, phone } = req.body || {}; if (!amount || !mpesaCode || !phone){ return res.status(400).json({ error: 'Missing fields' }); }

const u = await findUser(req.user.email); const list = await storage.getItem('deposits') || [];

const dep = { id: crypto.randomUUID(), email: u.email, phone, amount: Number(amount), mpesaCode, status: 'PENDING', time: Date.now() };

list.push(dep); await storage.setItem('deposits', list);

res.json({ message: 'Deposit submitted' });

await tgSend( 🟢 <b>DEPOSIT</b>\n${u.email}\nKES ${amount}\nMPESA: ${mpesaCode}, [[ { text: '✅ Approve', url: ${DOMAIN}/api/admin/deposits/${dep.id}/approve?token=${ADMIN_PASS} }, { text: '❌ Reject',  url: ${DOMAIN}/api/admin/deposits/${dep.id}/reject?token=${ADMIN_PASS} } ]] ); });

// ================== WITHDRAWALS ================== app.post('/api/withdraw', auth, async (req, res) => { const { amount, phone } = req.body || {}; const u = await findUser(req.user.email);

if (!amount || !phone) return res.status(400).json({ error: 'Missing data' }); if (u.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

const list = await storage.getItem('withdrawals') || [];

const w = { id: crypto.randomUUID(), email: u.email, phone, amount: Number(amount), status: 'PENDING', time: Date.now() };

list.push(w); await storage.setItem('withdrawals', list);

res.json({ message: 'Withdraw requested' });

await tgSend( 🔵 <b>WITHDRAW</b>\n${u.email}\nPhone: ${phone}\nKES ${amount}, [[ { text: '✅ Approve', url: ${DOMAIN}/api/admin/withdrawals/${w.id}/approve?token=${ADMIN_PASS} }, { text: '❌ Reject',  url: ${DOMAIN}/api/admin/withdrawals/${w.id}/reject?token=${ADMIN_PASS} } ]] ); });

// ================== ADMIN ACTIONS ================== app.get('/api/admin/deposits/:id/:action', async (req, res) => { if (req.query.token !== ADMIN_PASS) return res.send('Unauthorized');

const list = await storage.getItem('deposits') || []; const d = list.find(x => x.id === req.params.id); if (!d || d.status !== 'PENDING') return res.send('Ignored');

d.status = req.params.action === 'approve' ? 'APPROVED' : 'REJECTED';

if (d.status === 'APPROVED'){ const u = await findUser(d.email); u.balance += d.amount; await saveUser(u); }

await storage.setItem('deposits', list); res.send(d.status); });

app.get('/api/admin/withdrawals/:id/:action', async (req, res) => { if (req.query.token !== ADMIN_PASS) return res.send('Unauthorized');

const list = await storage.getItem('withdrawals') || []; const w = list.find(x => x.id === req.params.id); if (!w || w.status !== 'PENDING') return res.send('Ignored');

w.status = req.params.action === 'approve' ? 'APPROVED' : 'REJECTED';

if (w.status === 'APPROVED'){ const u = await findUser(w.email); u.balance -= w.amount; await saveUser(u); }

await storage.setItem('withdrawals', list); res.send(w.status); });

// ================== DAILY EARNINGS (12:00 AM) ================== async function runDailyEarnings(){ const users = await getUsers(); const today = new Date().toISOString().slice(0,10); let changed = false;

for (const u of users){ if (u.lastEarningDay === today) continue;

let earn = 0;
for (const f of u.fridges){
  earn += Number(f.dailyEarn || 0);
}

if (earn > 0){
  u.balance += earn;
  u.lastEarningDay = today;
  changed = true;
}

}

if (changed) await saveUsers(users); }

setInterval(async () => { const now = new Date(); if (now.getHours() === 0 && now.getMinutes() < 5){ await runDailyEarnings(); } }, 5 * 60 * 1000);

// ================== STATUS ================== app.get('/api/status', (req, res) => { res.json({ ok: true, till: MPESA_TILL, name: MPESA_NAME, serverTime: new Date().toISOString() }); });

// ================== START ================== app.listen(PORT, () => { console.log('Bitfreeze running on port', PORT); });
