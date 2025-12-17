require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const storage = require('node-persist');
const path = require('path');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
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
  { id: '2ft', name: '2 ft Fridge', price: 500, dailyEarn: 25 },
  { id: '4ft', name: '4 ft Fridge', price: 1000, dailyEarn: 55 },
  { id: '6ft', name: '6 ft Fridge', price: 2000, dailyEarn: 100 },
  { id: '8ft', name: '8 ft Fridge', price: 4000, dailyEarn: 150 },
  { id: '10ft', name: '10 ft Fridge', price: 6000, dailyEarn: 250 },
  { id: '12ft', name: '12 ft Fridge', price: 8000, dailyEarn: 350 },
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

app.use(bodyParser.json());
app.use(cors({ origin: DOMAIN }));
app.use(express.static(path.join(__dirname, 'public')));

// ================= STORAGE INIT =================
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist'), forgiveParseErrors: true });
  if (!await storage.getItem('users')) await storage.setItem('users', []);
  if (!await storage.getItem('deposits')) await storage.setItem('deposits', []);
  if (!await storage.getItem('withdrawals')) await storage.setItem('withdrawals', []);
  console.log('Storage initialized');
})();

// ================= HELPERS =================
async function getUsers(){ return (await storage.getItem('users')) || []; }
async function saveUsers(u){ await storage.setItem('users', u); }
async function findUser(email){ return (await getUsers()).find(x=>x.email===email); }
async function saveUser(user){
  const users = await getUsers();
  const i = users.findIndex(u=>u.email===user.email);
  if(i>-1) users[i] = user;
  else users.push(user);
  await saveUsers(users);
}

// Kenya date helper (VERY IMPORTANT)
function kenyaToday(){
  return new Date().toLocaleDateString('en-CA', { timeZone:'Africa/Nairobi' });
}

// ================= AUTH =================
function auth(req,res,next){
  const a=req.headers.authorization;
  if(!a||!a.startsWith('Bearer ')) return res.status(401).json({error:'Unauthorized'});
  try{
    req.user=jwt.verify(a.slice(7),SECRET);
    next();
  }catch{
    return res.status(401).json({error:'Invalid token'});
  }
}

// ================= TELEGRAM =================
async function tgSend(text, buttons){
  if(!TG_BOT || !TG_CHAT) return;
  const body = { chat_id: TG_CHAT, text, parse_mode:'HTML' };
  if(buttons) body.reply_markup = { inline_keyboard: buttons };
  await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  }).catch(()=>{});
}

// ================= DAILY EARNINGS (SAFE) =================
async function runDailyEarnings(){
  const users = await getUsers();
  const today = kenyaToday();

  for(const u of users){
    if(!u.lastPaid) u.lastPaid = today;
    if(u.lastPaid === today) continue;

    let earn = 0;
    for(const f of u.fridges){
      const fridge = FRIDGES.find(fr=>fr.id===f.id);
      if(fridge) earn += fridge.dailyEarn;
    }

    if(earn > 0){
      u.balance += earn;   // ✅ ONLY ADD
      u.lastPaid = today;  // ✅ LOCK DAY
    }
  }
  await saveUsers(users);
}

// ================= API =================

// Register
app.post('/api/register', async(req,res)=>{
  const { email,password,phone,ref } = req.body||{};
  if(!email||!password) return res.status(400).json({error:'Required'});
  if(await findUser(email)) return res.status(400).json({error:'Exists'});

  const hashed = await bcrypt.hash(password,10);
  const user = {
    email,
    password: hashed,
    phone: phone||null,
    balance: 0,
    fridges: [],
    referrals: [],
    withdrawPhone: null,
    referredBy: ref||null,
    createdAt: Date.now()
  };
  await saveUser(user);
  res.json({message:'Registered'});
});

// Login
app.post('/api/login', async(req,res)=>{
  const { email,password } = req.body||{};
  const u = await findUser(email);
  if(!u || !await bcrypt.compare(password,u.password))
    return res.status(400).json({error:'Invalid'});

  await runDailyEarnings(); // ✅ SAFE UPDATE

  const token = jwt.sign({email},SECRET,{expiresIn:'7d'});
  res.json({token, balance:u.balance});
});

// Profile
app.get('/api/me', auth, async(req,res)=>{
  await runDailyEarnings(); // ✅ SAFE UPDATE
  const u = await findUser(req.user.email);
  res.json({user:u});
});

// Deposit
app.post('/api/deposit', auth, async(req,res)=>{
  const { amount, mpesaCode, phone } = req.body||{};
  const u = await findUser(req.user.email);
  if(!u) return res.status(404).json({error:'User not found'});

  if(!u.withdrawPhone) u.withdrawPhone = phone;

  const deposits = await storage.getItem('deposits')||[];
  const d = { id:crypto.randomUUID(), email:u.email, phone, amount:+amount, mpesaCode, status:'PENDING', at:Date.now() };
  deposits.push(d);
  await storage.setItem('deposits',deposits);
  await saveUser(u);

  tgSend(`🟢 Deposit\n${u.email}\nKES ${amount}`,[
    [{text:'Approve',url:`${DOMAIN}/api/admin/deposits/${d.id}/approve?token=${ADMIN_PASS}`}]
  ]);

  res.json({message:'Deposit submitted'});
});

// Withdraw (Mon–Fri)
app.post('/api/withdraw', auth, async(req,res)=>{
  const { amount, phone } = req.body||{};
  const u = await findUser(req.user.email);

  if(!u.withdrawPhone) return res.status(400).json({error:'No deposit'});
  if(phone !== u.withdrawPhone) return res.status(400).json({error:'Wrong phone'});

  const day = new Date().toLocaleString('en-US',{weekday:'long',timeZone:'Africa/Nairobi'});
  if(day==='Saturday'||day==='Sunday')
    return res.status(400).json({error:'Withdraw Mon–Fri only'});

  if(u.balance < amount) return res.status(400).json({error:'Low balance'});

  const withdrawals = await storage.getItem('withdrawals')||[];
  const w = { id:crypto.randomUUID(), email:u.email, phone, amount:+amount, status:'PENDING', at:Date.now() };
  withdrawals.push(w);
  await storage.setItem('withdrawals',withdrawals);

  tgSend(`🔵 Withdraw\n${u.email}\nKES ${amount}`,[
    [{text:'Approve',url:`${DOMAIN}/api/admin/withdrawals/${w.id}/approve?token=${ADMIN_PASS}`}]
  ]);

  res.json({message:'Withdrawal submitted'});
});

// Buy fridge
app.post('/api/buy', auth, async(req,res)=>{
  const { fridgeId } = req.body||{};
  const u = await findUser(req.user.email);
  const f = FRIDGES.find(x=>x.id===fridgeId);

  if(!f) return res.status(400).json({error:'Invalid fridge'});
  if(u.balance < f.price) return res.status(400).json({error:'Low balance'});

  u.balance -= f.price;
  u.fridges.push({id:f.id,boughtAt:Date.now()});
  await saveUser(u);

  res.json({message:'Fridge bought'});
});

// Status
app.get('/api/status',(req,res)=>{
  res.json({status:'ok', time:Date.now(), till:MPESA_TILL, name:MPESA_NAME});
});

// Start
app.listen(PORT,()=>{
  console.log(`Bitfreeze running on ${PORT}`);
});
