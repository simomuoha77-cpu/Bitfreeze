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

// Telegram bots
const TG_DEPOSIT_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_DEPOSIT_CHAT = process.env.TELEGRAM_CHAT_ID;
const TG_WITHDRAW_BOT = process.env.TELEGRAM_WITHDRAW_BOT;
const TG_WITHDRAW_CHAT = process.env.TELEGRAM_WITHDRAW_CHAT;

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
async function getUsers(){ return (await storage.getItem('users')) || []; }
async function saveUsers(u){ await storage.setItem('users', u); }
async function findUser(email){ return (await getUsers()).find(x=>x.email===email); }
async function saveUser(user){ const u=await getUsers(); const i=u.findIndex(x=>x.email===user.email); if(i>-1) u[i]=user; else u.push(user); await saveUsers(u); }

function auth(req,res,next){ 
  const a=req.headers.authorization; 
  if(!a||!a.startsWith('Bearer ')) return res.status(401).json({error:'Unauthorized'}); 
  try{ req.user=jwt.verify(a.slice(7),SECRET); next(); }catch{ return res.status(401).json({error:'Invalid token'});} 
}

// Telegram helper
async function tgSend(bot, chat, text, buttons){
  if(!bot||!chat) return;
  const body = { chat_id: chat, text, parse_mode:'HTML' };
  if(buttons){ body.reply_markup = { inline_keyboard: buttons }; }
  await fetch(`https://api.telegram.org/bot${bot}/sendMessage`,{
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  }).catch(e=>console.error('TG send error',e));
}

// ========== API ==========

// Register
app.post('/api/register', async (req,res)=>{
  const { email,password,phone,ref } = req.body||{};
  if(!email||!password) return res.status(400).json({error:'Email & password required'});
  const users = await getUsers();
  if(users.find(u=>u.email===email)) return res.status(400).json({error:'User exists'});
  const hashed = await bcrypt.hash(password,10);
  const user = { email, password: hashed, phone: phone||null, balance:0, fridges:[], referrals:[], createdAt:Date.now() };
  users.push(user); await saveUsers(users);
  if(ref){ const inv=users.find(u=>u.email===String(ref)); if(inv){ inv.referrals.push({email,createdAt:Date.now()}); await saveUsers(users); } }
  res.json({message:'Registered'});
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
  const { amount, mpesaCode, phone } = req.body||{};
  if(!amount||!mpesaCode||!phone) return res.status(400).json({error:'amount, mpesaCode, phone required'});
  const u = await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});
  const deposits = (await storage.getItem('deposits'))||[];
  const d = { id: crypto.randomUUID(), email:u.email, phone, amount:Number(amount), mpesaCode, status:'PENDING', requestedAt:Date.now() };
  deposits.push(d); await storage.setItem('deposits',deposits);
  res.json({message:'Deposit submitted'});

  const text = `🟢 <b>New Deposit Request</b>\nEmail: ${u.email}\nPhone: ${phone}\nAmount: KES ${amount}\nMPESA Code: <b>${mpesaCode}</b>\nDeposit ID: ${d.id}\nStatus: PENDING`;
  const buttons = [[
    { text:'✅ Approve', callback_data:`dep_approve_${d.id}` },
    { text:'❌ Reject', callback_data:`dep_reject_${d.id}` }
  ]];
  await tgSend(TG_DEPOSIT_BOT, TG_DEPOSIT_CHAT, text, buttons);
});

// Withdraw
app.post('/api/withdraw', auth, async (req,res)=>{
  const { amount, phone } = req.body||{};
  if(!amount||!phone) return res.status(400).json({error:'amount & phone required'});
  if(Number(amount)<200) return res.status(400).json({error:'Minimum 200'});
  const u = await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});
  if(u.balance < Number(amount)) return res.status(400).json({error:'Insufficient balance'});
  const withdrawals = (await storage.getItem('withdrawals'))||[];
  const w = { id: crypto.randomUUID(), email:u.email, phone, amount:Number(amount), status:'PENDING', requestedAt:Date.now() };
  withdrawals.push(w); await storage.setItem('withdrawals',withdrawals);
  res.json({message:'Withdrawal submitted'});

  const text = `🔵 <b>New Withdrawal Request</b>\nEmail: ${u.email}\nPhone: ${phone}\nAmount: KES ${amount}\nBalance: KES ${u.balance}\nWithdraw ID: ${w.id}\nStatus: PENDING`;
  const buttons = [[
    { text:'✅ Approve', callback_data:`wd_approve_${w.id}` },
    { text:'❌ Reject', callback_data:`wd_reject_${w.id}` }
  ]];
  await tgSend(TG_WITHDRAW_BOT, TG_WITHDRAW_CHAT, text, buttons);
});

// Telegram callback endpoint
app.post('/api/telegram/webhook', async (req,res)=>{
  const cb = req.body.callback_query; if(!cb) return res.sendStatus(200);
  const data = cb.data||'';
  let botToken;

  // Determine bot for callback
  if(data.startsWith('dep_')) botToken = TG_DEPOSIT_BOT;
  else if(data.startsWith('wd_')) botToken = TG_WITHDRAW_BOT;
  else return res.sendStatus(200);

  const answer = async (text)=> fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`,{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({callback_query_id:cb.id,text})}).catch(()=>{});

  // Deposit callbacks
  if(data.startsWith('dep_')){
    const [_,action,id]=data.split('_');
    const deposits = (await storage.getItem('deposits'))||[];
    const d = deposits.find(x=>x.id===id); 
    if(!d||d.status!=='PENDING'){ await answer('Already processed'); return res.sendStatus(200);}
    if(action==='approve'){ d.status='APPROVED'; d.processedAt=Date.now(); const u=await findUser(d.email); if(u){ u.balance+=Number(d.amount); await saveUser(u);} }
    else { d.status='REJECTED'; d.processedAt=Date.now(); }
    await storage.setItem('deposits',deposits);
    await answer(`Deposit ${d.status}`);
  }

  // Withdraw callbacks
  if(data.startsWith('wd_')){
    const [_,action,id]=data.split('_');
    const withdrawals = (await storage.getItem('withdrawals'))||[];
    const w = withdrawals.find(x=>x.id===id);
    if(!w||w.status!=='PENDING'){ await answer('Already processed'); return res.sendStatus(200);}
    if(action==='approve'){ w.status='APPROVED'; w.processedAt=Date.now(); const u=await findUser(w.email); if(u){ u.balance-=Number(w.amount); await saveUser(u);} }
    else { w.status='REJECTED'; w.processedAt=Date.now(); }
    await storage.setItem('withdrawals',withdrawals);
    await answer(`Withdrawal ${w.status}`);
  }

  res.sendStatus(200);
});

// Buy fridge
app.post('/api/buy', auth, async (req,res)=>{
  const { fridgeId } = req.body||{}; if(!fridgeId) return res.status(400).json({error:'fridgeId required'});
  const item=FRIDGES.find(f=>f.id===fridgeId); if(!item) return res.status(400).json({error:'Invalid fridge'});
  const u=await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});
  if(u.balance < item.price) return res.status(400).json({error:'Insufficient balance'});
  u.balance -= item.price; u.fridges.push({id:item.id,name:item.name,price:item.price,boughtAt:Date.now()}); await saveUser(u);
  res.json({message:'Bought', balance:u.balance});
});

// Status
app.get('/api/status',(req,res)=>res.json({status:'ok', time:Date.now(), till:MPESA_TILL, name:MPESA_NAME}));

app.listen(PORT,()=>console.log(`Bitfreeze running on ${PORT}`));
