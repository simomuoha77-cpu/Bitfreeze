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

// Telegram bot
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// MPESA
const MPESA_TILL = process.env.MPESA_TILL || '6992349';
const MPESA_NAME = process.env.MPESA_NAME || 'Bitfreeze';

// Fridges catalog
const FRIDGES = [
  { id: '2ft', name: '2 ft Fridge', price: 500, dailyEarn: 25, img: 'images/fridge2ft.jpg' },
  { id: '4ft', name: '4 ft Fridge', price: 1000, dailyEarn: 55, img: 'images/fridge4ft.jpg' },
  { id: '6ft', name: '6 ft Fridge', price: 2000, dailyEarn: 100, img: 'images/fridge6ft.jpg' },
  { id: '8ft', name: '8 ft Fridge', price: 4000, dailyEarn: 150, img: 'images/fridge8ft.jpg' },
  { id: '10ft', name: '10 ft Fridge', price: 6000, dailyEarn: 250, img: 'images/fridge10ft.jpg' },
  { id: '12ft', name: '12 ft Fridge', price: 8000, dailyEarn: 350, img: 'images/fridge12ft.jpg' },
];

// Referral rewards
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

// ================== STORAGE ==================
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist'), forgiveParseErrors: true });
  if (!await storage.getItem('users')) await storage.setItem('users', []);
  if (!await storage.getItem('deposits')) await storage.setItem('deposits', []);
  if (!await storage.getItem('withdrawals')) await storage.setItem('withdrawals', []);
  console.log('✓ Storage ready');
})();

// ================== HELPERS ==================
async function getUsers() { return (await storage.getItem('users')) || []; }
async function saveUsers(users) { await storage.setItem('users', users); }
async function findUser(email) { return (await getUsers()).find(u => u.email === email); }
async function saveUser(user) {
  const users = await getUsers();
  const i = users.findIndex(x => x.email === user.email);
  if (i > -1) users[i] = user;
  else users.push(user);
  await saveUsers(users);
}

// Auth middleware
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(h.slice(7), SECRET); next(); } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// Telegram helper
async function tgSend(text, buttons) {
  if (!TG_BOT || !TG_CHAT) return;
  const body = { chat_id: TG_CHAT, text, parse_mode:'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`,{
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  }).catch(e=>console.error('TG send error', e));
}

// ================== AUTH ==================
// Register
app.post('/api/register', async (req,res)=>{
  const { email,password,phone,ref } = req.body||{};
  if(!email||!password) return res.status(400).json({error:'Email & password required'});
  const users = await getUsers();
  if(users.find(u=>u.email===email)) return res.status(400).json({error:'User exists'});

  const hashed = await bcrypt.hash(password,10);
  const user = { email, password: hashed, phone: phone||null, balance:0, fridges:[], referrals:[], createdAt:Date.now() };
  users.push(user);
  await saveUsers(users);

  // Handle referral reward
  if(ref){
    const referrer = users.find(u => u.email === String(ref));
    if(referrer){
      referrer.referrals.push({email, createdAt:Date.now()});
      // Check last deposit amount of new user
      if(user.balance > 0){
        const rewardRule = REFERRAL_RULES.find(r => user.balance >= r.min);
        if(rewardRule){
          referrer.balance = (referrer.balance||0) + rewardRule.reward;
          await saveUser(referrer);
        }
      }
    }
  }

  res.json({message:'Registered', email});
});

// Login
app.post('/api/login', async (req,res)=>{
  const { email, password } = req.body||{};
  const user = await findUser(email); if(!user) return res.status(400).json({error:'Invalid'});
  const ok = await bcrypt.compare(password,user.password); if(!ok) return res.status(400).json({error:'Invalid'});
  const token = jwt.sign({email:user.email}, SECRET, {expiresIn:'7d'});
  res.json({ token, email:user.email, phone:user.phone, balance:user.balance });
});

// Fridges
app.get('/api/fridges',(req,res)=>res.json({fridges:FRIDGES}));

// Profile
app.get('/api/me', auth, async (req,res)=>{
  const u = await findUser(req.user.email); if(!u) return res.status(404).json({error:'Not found'});
  res.json({ user:{ email:u.email, phone:u.phone, balance:u.balance, fridges:u.fridges, referrals:u.referrals } });
});

// Deposit
app.post('/api/deposit', auth, async (req,res)=>{
  const { amount, phone, mpesaCode } = req.body||{};
  if(!amount||!phone||!mpesaCode) return res.status(400).json({error:'Missing fields'});
  const u = await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});

  // Update balance immediately
  u.balance = (u.balance||0) + Number(amount);
  await saveUser(u);

  // Record deposit
  const deposits = await storage.getItem('deposits') || [];
  deposits.push({ id: crypto.randomUUID(), email:u.email, phone, amount:Number(amount), mpesaCode, status:'APPROVED', requestedAt:Date.now() });
  await storage.setItem('deposits', deposits);

  res.json({message:'Deposit successful', balance:u.balance});
});

// Withdraw
app.post('/api/withdraw', auth, async (req,res)=>{
  const { amount, phone } = req.body||{};
  if(!amount||!phone) return res.status(400).json({error:'Missing fields'});
  const u = await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});

  // Allow withdrawal only to the phone used for deposit
  const deposits = await storage.getItem('deposits') || [];
  const firstDeposit = deposits.find(d => d.email===u.email);
  if(!firstDeposit) return res.status(400).json({error:'Cannot withdraw before deposit'});
  if(phone !== firstDeposit.phone) return res.status(400).json({error:'Withdraw only to the phone used for deposit'});

  if(u.balance < Number(amount)) return res.status(400).json({error:'Insufficient balance'});

  u.balance -= Number(amount);
  await saveUser(u);

  // Record withdrawal
  const withdrawals = await storage.getItem('withdrawals') || [];
  withdrawals.push({ id: crypto.randomUUID(), email:u.email, phone, amount:Number(amount), status:'APPROVED', requestedAt:Date.now() });
  await storage.setItem('withdrawals', withdrawals);

  res.json({message:'Withdrawal successful', balance:u.balance});
});

// Buy fridge
app.post('/api/buy', auth, async (req,res)=>{
  const { fridgeId } = req.body||{};
  const u = await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});
  const fridge = FRIDGES.find(f => f.id===fridgeId); if(!fridge) return res.status(400).json({error:'Invalid fridge'});
  if(u.balance < fridge.price) return res.status(400).json({error:'Insufficient balance'});

  u.balance -= fridge.price;
  u.fridges.push({ id: fridge.id, name: fridge.name, price: fridge.price, boughtAt:Date.now() });
  await saveUser(u);
  res.json({ message:`Bought ${fridge.name}`, balance:u.balance });
});

// ================== DAILY EARNINGS ==================
async function runDailyEarnings(){
  const users = await getUsers();
  const today = new Date().toLocaleDateString('en-GB', { timeZone:'Africa/Nairobi' });
  for(const u of users){
    if(u.lastPaid===today) continue;
    let earn = 0;
    for(const f of u.fridges){
      const fridge = FRIDGES.find(fr=>fr.id===f.id);
      if(fridge) earn += fridge.dailyEarn;
    }
    if(earn>0){
      u.balance += earn;
      u.lastPaid = today;
      await saveUser(u);
    }
  }
}
setInterval(async ()=>{
  const now = new Date();
  if(now.getHours()===0 && now.getMinutes()===0){ // 12:00 AM Nairobi
    await runDailyEarnings();
  }
}, 60*1000); // check every 1 minute

// Status
app.get('/api/status', (req,res)=>res.json({ status:'ok', time:Date.now(), till:MPESA_TILL, name:MPESA_NAME }));

// Start server
app.listen(PORT,()=>console.log(`Bitfreeze running on port ${PORT}`));
