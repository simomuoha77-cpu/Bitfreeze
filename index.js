require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const mongoose = require('mongoose');
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

// Referral reward rules
const REFERRAL_RULES = [
  { min: 8000, reward: 500 },
  { min: 6000, reward: 350 },
  { min: 4000, reward: 250 },
  { min: 2000, reward: 150 },
  { min: 1000, reward: 100 },
  { min: 500,  reward: 50  },
];

app.use(bodyParser.json());
app.use(cors({ origin: DOMAIN }));
app.use(express.static(path.join(__dirname, 'public')));

// =================== MONGODB SETUP ===================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bitfreeze';
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=>console.log('MongoDB connected'))
  .catch(err=>console.error('MongoDB connection error:', err));

const userSchema = new mongoose.Schema({
  email: String,
  password: String,
  phone: String,
  balance: { type: Number, default: 0 },
  fridges: Array,
  referrals: Array,
  createdAt: Date,
  withdrawPhone: String,
  referredBy: String,
  lastPaid: String
});

const depositSchema = new mongoose.Schema({
  email: String,
  phone: String,
  amount: Number,
  mpesaCode: String,
  status: { type: String, default: 'PENDING' },
  requestedAt: Date,
  processedAt: Date
});

const withdrawalSchema = new mongoose.Schema({
  email: String,
  phone: String,
  amount: Number,
  status: { type: String, default: 'PENDING' },
  requestedAt: Date,
  processedAt: Date
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// =================== HELPERS ===================
async function getUsers(){ return await User.find(); }
async function findUser(email){ return await User.findOne({email}); }
async function saveUser(user){ await user.save(); }

// Auth middleware
function auth(req,res,next){
  const a=req.headers.authorization;
  if(!a||!a.startsWith('Bearer ')) return res.status(401).json({error:'Unauthorized'});
  try{ req.user=jwt.verify(a.slice(7),SECRET); next(); }catch{ return res.status(401).json({error:'Invalid token'});}
}

// Telegram helper
async function tgSend(text, buttons){
  if(!TG_BOT || !TG_CHAT) return;
  const body = { chat_id: TG_CHAT, text, parse_mode:'HTML' };
  if(buttons){ body.reply_markup = { inline_keyboard: buttons }; }
  await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`,{
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  }).catch(e=>console.error('TG send error',e));
}

// =================== API ROUTES ===================

// Register
app.post('/api/register', async (req,res)=>{
  const { email,password,phone,ref } = req.body||{};
  if(!email||!password) return res.status(400).json({error:'Email & password required'});
  const exists = await findUser(email);
  if(exists) return res.status(400).json({error:'User exists'});
  const hashed = await bcrypt.hash(password,10);
  const user = new User({ email, password: hashed, phone: phone||null, balance:0, fridges:[], referrals:[], createdAt:new Date(), withdrawPhone:null, referredBy:ref||null });
  await user.save();
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
app.post('/api/deposit', auth, async(req,res)=>{
  const { amount, mpesaCode, phone } = req.body||{};
  if(!amount || !mpesaCode || !phone) return res.status(400).json({error:'amount, mpesaCode, phone required'});
  const u = await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});

  const pending = await Deposit.findOne({email:u.email, status:'PENDING'});
  if(pending) return res.status(400).json({error:'You already have a pending deposit. Please wait for it to be approved/rejected.'});

  if(!u.withdrawPhone) u.withdrawPhone = phone;

  const d = new Deposit({ email:u.email, phone, amount:Number(amount), mpesaCode, requestedAt: new Date() });
  await d.save();
  await saveUser(u);
  res.json({message:'Deposit submitted'});

  const text = `🟢 <b>New Deposit Request</b>\nEmail: ${u.email}\nPhone: ${phone}\nAmount: KES ${amount}\nMPESA Code: <b>${mpesaCode}</b>\nDeposit ID: ${d._id}\nStatus: PENDING`;
  const buttons = [[
    { text:'✅ Approve', url:`${DOMAIN}/api/admin/deposits/${d._id}/approve?token=${ADMIN_PASS}` },
    { text:'❌ Reject', url:`${DOMAIN}/api/admin/deposits/${d._id}/reject?token=${ADMIN_PASS}` }
  ]];
  await tgSend(text,buttons);

  // Referral reward
  if(u.referredBy){
    const refUser = await findUser(u.referredBy);
    if(refUser){
      for(const rule of REFERRAL_RULES){
        if(Number(amount) >= rule.min){
          refUser.balance += rule.reward;
          await saveUser(refUser);
          break;
        }
      }
    }
  }
});

// Withdraw
app.post('/api/withdraw', auth, async(req,res)=>{
  const { amount, phone } = req.body||{};
  if(!amount || !phone) return res.status(400).json({error:'amount & phone required'});
  const u = await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});
  if(!u.withdrawPhone) return res.status(400).json({error:'Cannot withdraw before making a deposit'});
  if(phone !== u.withdrawPhone) return res.status(400).json({error:`Withdraw allowed only to original deposit phone ${u.withdrawPhone}`});

  const day = new Date().toLocaleString('en-US', { weekday:'long', timeZone:'Africa/Nairobi' });
  if(day==='Saturday' || day==='Sunday') return res.status(400).json({error:'Withdrawals are allowed only Monday to Friday'});
  if(u.balance < Number(amount)) return res.status(400).json({error:'Insufficient balance'});

  const pending = await Withdrawal.findOne({email:u.email, status:'PENDING'});
  if(pending) return res.status(400).json({error:'You already have a pending withdrawal. Please wait for it to be approved/rejected.'});

  const w = new Withdrawal({ email:u.email, phone, amount:Number(amount), requestedAt: new Date() });
  await w.save();

  res.json({message:'Withdrawal submitted'});

  const text = `🔵 <b>New Withdrawal Request</b>\nEmail: ${u.email}\nPhone: ${phone}\nAmount: KES ${amount}\nBalance: KES ${u.balance}\nWithdraw ID: ${w._id}\nStatus: PENDING`;
  const buttons = [[
    { text:'✅ Approve', url:`${DOMAIN}/api/admin/withdrawals/${w._id}/approve?token=${ADMIN_PASS}` },
    { text:'❌ Reject', url:`${DOMAIN}/api/admin/withdrawals/${w._id}/reject?token=${ADMIN_PASS}` }
  ]];
  await tgSend(text,buttons);
});

// Admin approve/reject deposit
app.get('/api/admin/deposits/:id/:action', async (req,res)=>{
  const { id, action } = req.params;
  const token = req.query.token;
  if(token!==ADMIN_PASS) return res.status(401).send('Unauthorized');
  const d = await Deposit.findById(id); if(!d) return res.status(404).send('Deposit not found');
  if(d.status!=='PENDING') return res.status(400).send('Deposit already processed');
  d.status = action.toUpperCase()==='APPROVE'?'APPROVED':'REJECTED';
  d.processedAt = new Date();
  await d.save();
  if(d.status==='APPROVED'){ const u = await findUser(d.email); if(u){ u.balance += d.amount; await saveUser(u);} }
  res.send(`Deposit ${d.status}`);
});

// Admin approve/reject withdrawal
app.get('/api/admin/withdrawals/:id/:action', async (req,res)=>{
  const { id, action } = req.params;
  const token = req.query.token;
  if(token!==ADMIN_PASS) return res.status(401).send('Unauthorized');
  const w = await Withdrawal.findById(id); if(!w) return res.status(404).send('Withdrawal not found');
  if(w.status!=='PENDING') return res.status(400).send('Withdrawal already processed');
  w.status = action.toUpperCase()==='APPROVE'?'APPROVED':'REJECTED';
  w.processedAt = new Date();
  await w.save();
  if(w.status==='APPROVED'){ const u = await findUser(w.email); if(u){ u.balance -= w.amount; await saveUser(u);} }
  res.send(`Withdrawal ${w.status}`);
});

// Buy fridge
app.post('/api/buy', auth, async (req,res)=>{
  const { fridgeId } = req.body||{};
  if(!fridgeId) return res.status(400).json({error:'fridgeId required'});
  const item=FRIDGES.find(f=>f.id===fridgeId); if(!item) return res.status(400).json({error:'Invalid fridge'});
  const u=await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});
  if(u.balance < item.price) return res.status(400).json({error:'Insufficient balance'});
  u.balance -= item.price; u.fridges.push({id:item.id,name:item.name,price:item.price,boughtAt:Date.now()});
  await saveUser(u);
  res.json({message:`Bought ${item.name}`, balance:u.balance});
});

// =================== DAILY EARNINGS ===================
async function runDailyEarnings(){
  const users = await User.find();
  const today = new Date().toLocaleDateString('en-GB', { timeZone:'Africa/Nairobi' });
  for(const u of users){
    if(u.lastPaid===today) continue;
    let earn=0;
    for(const f of u.fridges){
      const fridge = FRIDGES.find(fr=>fr.id===f.id);
      if(fridge) earn += fridge.dailyEarn;
    }
    if(earn>0){
      u.balance += earn;
      u.lastPaid = today;
      await saveUser(u);
      console.log(`User ${u.email} earned KES ${earn}. New balance: ${u.balance}`);
    }
  }
}

// Check every minute if it's 12:00 AM Nairobi
setInterval(async()=>{
  const now = new Date();
  const hours = Number(now.toLocaleString('en-US', { hour12:false, hour:'2-digit', timeZone:'Africa/Nairobi' }));
  const minutes = Number(now.toLocaleString('en-US', { minute:'2-digit', timeZone:'Africa/Nairobi' }));
  if(hours===0 && minutes===0) await runDailyEarnings();
}, 60_000);

// Status
app.get('/api/status',(req,res)=>res.json({status:'ok', time:Date.now(), till:MPESA_TILL, name:MPESA_NAME}));

// TEST ROUTE (optional, remove in production)
app.get('/api/test-daily', async (req,res) => {
  await runDailyEarnings();
  res.json({message:'Daily earnings processed (test run)'});
});

// Start server
app.listen(PORT,()=>console.log(`Bitfreeze running on ${PORT}`));
