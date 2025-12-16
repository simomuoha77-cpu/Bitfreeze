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

// Referral rules
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

// Initialize storage
(async () => {
  await storage.init({ dir: path.join(__dirname, 'persist'), forgiveParseErrors: true });
  if (!await storage.getItem('users')) await storage.setItem('users', []);
  if (!await storage.getItem('deposits')) await storage.setItem('deposits', []);
  if (!await storage.getItem('withdrawals')) await storage.setItem('withdrawals', []);
  if (!await storage.getItem('referralRewards')) await storage.setItem('referralRewards', []);
  console.log('Storage initialized.');
})();

// Helpers
async function getUsers(){ return (await storage.getItem('users')) || []; }
async function saveUsers(u){ await storage.setItem('users', u); }
async function findUser(email){ return (await getUsers()).find(x=>x.email===email); }
async function saveUser(user){ 
  const u = await getUsers(); 
  const i = u.findIndex(x=>x.email===user.email); 
  if(i>-1) u[i]=user; else u.push(user); 
  await saveUsers(u); 
}
async function saveReferralReward(reward){
  const list = await storage.getItem('referralRewards') || [];
  list.push(reward);
  await storage.setItem('referralRewards', list);
}

function auth(req,res,next){ 
  const a = req.headers.authorization; 
  if(!a||!a.startsWith('Bearer ')) return res.status(401).json({error:'Unauthorized'}); 
  try{ req.user = jwt.verify(a.slice(7),SECRET); next(); } catch { return res.status(401).json({error:'Invalid token'}); }
}

async function tgSend(text, buttons){
  if(!TG_BOT || !TG_CHAT) return;
  const body = { chat_id: TG_CHAT, text, parse_mode:'HTML' };
  if(buttons){ body.reply_markup = { inline_keyboard: buttons }; }
  await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`,{
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  }).catch(e=>console.error('TG send error',e));
}

// Calculate referral reward based on deposit
function calculateReferralReward(amount){
  for(const rule of REFERRAL_RULES){
    if(amount >= rule.min) return rule.reward;
  }
  return 0;
}

// ========== API ==========

// Register
app.post('/api/register', async (req,res)=>{
  const { email,password,phone,ref } = req.body||{};
  if(!email||!password) return res.status(400).json({error:'Email & password required'});
  const users = await getUsers();
  if(users.find(u=>u.email===email)) return res.status(400).json({error:'User exists'});
  const hashed = await bcrypt.hash(password,10);
  const user = { email, password: hashed, phone: phone||null, balance:0, fridges:[], referrals:[], referrer: ref||null, createdAt:Date.now() };
  users.push(user); await saveUsers(users);
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
  const { amount, mpesaCode, phone } = req.body||{};
  if(!amount||!mpesaCode||!phone) return res.status(400).json({error:'amount, mpesaCode, phone required'});
  const u = await findUser(req.user.email); if(!u) return res.status(404).json({error:'User not found'});
  const deposits = (await storage.getItem('deposits'))||[];
  const d = { id: crypto.randomUUID(), email:u.email, phone, amount:Number(amount), mpesaCode, status:'PENDING', requestedAt:Date.now() };
  deposits.push(d); await storage.setItem('deposits',deposits);
  res.json({message:'Deposit submitted'});

  const text = `🟢 <b>New Deposit Request</b>\nEmail: ${u.email}\nPhone: ${phone}\nAmount: KES ${amount}\nDeposit ID: ${d.id}\nStatus: PENDING`;
  const buttons = [[
    { text:'✅ Approve', url:`${DOMAIN}/api/admin/deposits/${d.id}/approve?token=${ADMIN_PASS}` },
    { text:'❌ Reject', url:`${DOMAIN}/api/admin/deposits/${d.id}/reject?token=${ADMIN_PASS}` }
  ]];
  await tgSend(text, buttons);
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
    { text:'✅ Approve', url:`${DOMAIN}/api/admin/withdrawals/${w.id}/approve?token=${ADMIN_PASS}` },
    { text:'❌ Reject', url:`${DOMAIN}/api/admin/withdrawals/${w.id}/reject?token=${ADMIN_PASS}` }
  ]];
  await tgSend(text, buttons);
});

// Admin approve/reject deposit
app.get('/api/admin/deposits/:id/:action', async (req,res)=>{
  const { id, action } = req.params;
  const token = req.query.token;
  if(token!==ADMIN_PASS) return res.status(401).send('Unauthorized');
  const deposits = await storage.getItem('deposits')||[];
  const d = deposits.find(x=>x.id===id);
  if(!d) return res.status(404).send('Deposit not found');
  if(d.status!=='PENDING') return res.status(400).send('Deposit already processed');
  d.status = action.toUpperCase()==='APPROVE'?'APPROVED':'REJECTED';
  d.processedAt = Date.now();
  await storage.setItem('deposits',deposits);

  if(d.status==='APPROVED'){ 
    const u = await findUser(d.email); 
    if(u){ 
      u.balance += Number(d.amount); 
      await saveUser(u);

      // Referral reward
      if(u.referrer){
        const refUser = await findUser(u.referrer);
        if(refUser){
          const reward = calculateReferralReward(Number(d.amount));
          if(reward>0){
            refUser.balance += reward;
            await saveUser(refUser);
            await saveReferralReward({referrer: refUser.email, referred: u.email, amountDeposited: Number(d.amount), reward, date: Date.now(), depositId: d.id});
            await tgSend(`💰 Referral Reward\n${refUser.email} earned KES ${reward} from ${u.email}'s deposit of KES ${d.amount}`);
          }
        }
      }
    }
  }

  res.send(`Deposit ${d.status}`);
});

// Admin approve/reject withdrawal
app.get('/api/admin/withdrawals/:id/:action', async (req,res)=>{
  const { id, action } = req.params;
  const token = req.query.token;
  if(token!==ADMIN_PASS) return res.status(401).send('Unauthorized');
  const withdrawals = await storage.getItem('withdrawals')||[];
  const w = withdrawals.find(x=>x.id===id);
  if(!w) return res.status(404).send('Withdrawal not found');
  if(w.status!=='PENDING') return res.status(400).send('Withdrawal already processed');
  w.status = action.toUpperCase()==='APPROVE'?'APPROVED':'REJECTED';
  w.processedAt = Date.now();
  await storage.setItem('withdrawals',withdrawals);
  if(w.status==='APPROVED'){ const u=await findUser(w.email); if(u){ u.balance-=Number(w.amount); await saveUser(u);} }
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

// Auto daily earnings at 12:00 AM Kenya Time
setInterval(async ()=>{
  const now = new Date();
  const kenyaOffset = 3 * 60; // UTC+3 in minutes
  const utcMinutes = now.getUTCMinutes() + now.getUTCHours()*60;
  const kenyaMinutes = utcMinutes + kenyaOffset;
  const hours = Math.floor(kenyaMinutes/60)%24;
  const minutes = kenyaMinutes%60;
  if(hours===0 && minutes<5){ // run once between 00:00-00:04
    const users = await getUsers();
    for(const u of users){
      let earnedToday = 0;
      for(const f of u.fridges){
        const fridge = FRIDGES.find(fr=>fr.id===f.id);
        if(fridge) earnedToday += fridge.dailyEarn;
      }
      if(earnedToday>0){
        u.balance += earnedToday;
        await saveUser(u);
      }
    }
    console.log('✅ Daily earnings updated (Kenya time)');
  }
}, 60*1000); // check every 1 minute

// Status
app.get('/api/status',(req,res)=>res.json({status:'ok', time:Date.now(), till:MPESA_TILL, name:MPESA_NAME}));

// Start server
app.listen(PORT,()=>console.log(`Bitfreeze running on ${PORT}`));
