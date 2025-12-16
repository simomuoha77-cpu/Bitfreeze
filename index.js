// Bitfreeze – STABLE index.js // Earnings credited once per day at 12:00 AM (server time) // Single Telegram bot, Railway-safe

require('dotenv').config(); const express = require('express'); const bcrypt = require('bcryptjs'); const jwt = require('jsonwebtoken'); const bodyParser = require('body-parser'); const cors = require('cors'); const storage = require('node-persist'); const path = require('path'); const crypto = require('crypto'); const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express(); const PORT = process.env.PORT ? Number(process.env.PORT) : 3000; const SECRET = process.env.BF_SECRET; const DOMAIN = process.env.DOMAIN || 'https://bitfreeze-production.up.railway.app'; const ADMIN_PASS = process.env.ADMIN_PASS;

// Telegram (single bot) const TG_BOT = process.env.TELEGRAM_BOT_TOKEN; const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// MPESA display only const MPESA_TILL = process.env.MPESA_TILL; const MPESA_NAME = process.env.MPESA_NAME;

// Fridges const FRIDGES = [ { id:'2ft',  name:'2 ft Fridge',  price:500,  dailyEarn:25 }, { id:'4ft',  name:'4 ft Fridge',  price:1000, dailyEarn:55 }, { id:'6ft',  name:'6 ft Fridge',  price:2000, dailyEarn:100 }, { id:'8ft',  name:'8 ft Fridge',  price:4000, dailyEarn:150 }, { id:'10ft', name:'10 ft Fridge', price:6000, dailyEarn:250 }, { id:'12ft', name:'12 ft Fridge', price:8000, dailyEarn:350 }, ];

app.use(bodyParser.json()); app.use(cors({ origin: DOMAIN })); app.use(express.static(path.join(__dirname,'public')));

// Init storage (async()=>{ await storage.init({ dir:path.join(__dirname,'persist'), forgiveParseErrors:true }); if(!await storage.getItem('users')) await storage.setItem('users',[]); if(!await storage.getItem('deposits')) await storage.setItem('deposits',[]); if(!await storage.getItem('withdrawals')) await storage.setItem('withdrawals',[]); console.log('Storage ready'); })();

// Helpers async function getUsers(){ return (await storage.getItem('users'))||[]; } async function saveUsers(u){ await storage.setItem('users',u); } async function findUser(email){ return (await getUsers()).find(x=>x.email===email); } async function saveUser(user){ const u=await getUsers(); const i=u.findIndex(x=>x.email===user.email); if(i>-1) u[i]=user; else u.push(user); await saveUsers(u); }

// Auth function auth(req,res,next){ const h=req.headers.authorization; if(!h||!h.startsWith('Bearer ')) return res.status(401).json({error:'Unauthorized'}); try{ req.user=jwt.verify(h.slice(7),SECRET); next(); } catch{ return res.status(401).json({error:'Invalid token'}); } }

// Telegram async function tgSend(text,buttons){ if(!TG_BOT||!TG_CHAT) return; const body={ chat_id:TG_CHAT, text, parse_mode:'HTML' }; if(buttons) body.reply_markup={ inline_keyboard:buttons }; await fetch(https://api.telegram.org/bot${TG_BOT}/sendMessage,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }).catch(()=>{}); }

// ===== AUTH =====

app.post('/api/register', async(req,res)=>{ const {email,password,phone}=req.body||{}; if(!email||!password) return res.status(400).json({error:'Missing'}); const users=await getUsers(); if(users.find(u=>u.email===email)) return res.status(400).json({error:'Exists'}); const hashed=await bcrypt.hash(password,10); users.push({ email,password:hashed,phone:phone||'',balance:0, fridges:[], lastEarningDay:null, createdAt:Date.now() }); await saveUsers(users); res.json({message:'Registered'}); });

app.post('/api/login', async(req,res)=>{ const {email,password}=req.body||{}; const u=await findUser(email); if(!u) return res.status(400).json({error:'Invalid'}); const ok=await bcrypt.compare(password,u.password); if(!ok) return res.status(400).json({error:'Invalid'}); const token=jwt.sign({email:u.email},SECRET,{expiresIn:'7d'}); res.json({token,email:u.email,balance:u.balance,phone:u.phone}); });

// ===== USER =====

app.get('/api/me',auth,async(req,res)=>{ const u=await findUser(req.user.email); res.json({user:u}); });

app.get('/api/fridges',(req,res)=>res.json({fridges:FRIDGES}));

app.post('/api/buy',auth,async(req,res)=>{ const {fridgeId}=req.body||{}; const item=FRIDGES.find(f=>f.id===fridgeId); if(!item) return res.status(400).json({error:'Invalid'}); const u=await findUser(req.user.email); if(u.balance<item.price) return res.status(400).json({error:'Insufficient'}); u.balance-=item.price; u.fridges.push({ id:item.id, name:item.name, dailyEarn:item.dailyEarn, boughtAt:Date.now() }); await saveUser(u); res.json({message:'Purchased',balance:u.balance}); });

// ===== DEPOSIT =====

app.post('/api/deposit',auth,async(req,res)=>{ const {amount,mpesaCode,phone}=req.body||{}; if(!amount||!mpesaCode||!phone) return res.status(400).json({error:'Missing'}); const u=await findUser(req.user.email); const list=await storage.getItem('deposits')||[]; const d={ id:crypto.randomUUID(), email:u.email, phone, amount:Number(amount), mpesaCode, status:'PENDING' }; list.push(d); await storage.setItem('deposits',list); res.json({message:'Submitted'});

await tgSend( 🟢 <b>Deposit</b>\n${u.email}\nKES ${amount}\nMPESA: <b>${mpesaCode}</b>, [[ {text:'✅ Approve',url:${DOMAIN}/api/admin/deposits/${d.id}/approve?token=${ADMIN_PASS}}, {text:'❌ Reject', url:${DOMAIN}/api/admin/deposits/${d.id}/reject?token=${ADMIN_PASS}} ]] ); });

// ===== WITHDRAW =====

app.post('/api/withdraw',auth,async(req,res)=>{ const {amount,phone}=req.body||{}; const u=await findUser(req.user.email); if(u.balance<amount) return res.status(400).json({error:'Insufficient'}); const list=await storage.getItem('withdrawals')||[]; const w={ id:crypto.randomUUID(), email:u.email, phone, amount:Number(amount), status:'PENDING' }; list.push(w); await storage.setItem('withdrawals',list); res.json({message:'Requested'});

await tgSend( 🔵 <b>Withdraw</b>\n${u.email}\nPhone: ${phone}\nKES ${amount}\nBalance: ${u.balance}, [[ {text:'✅ Approve',url:${DOMAIN}/api/admin/withdrawals/${w.id}/approve?token=${ADMIN_PASS}}, {text:'❌ Reject', url:${DOMAIN}/api/admin/withdrawals/${w.id}/reject?token=${ADMIN_PASS}} ]] ); });

// ===== ADMIN =====

app.get('/api/admin/deposits/:id/:action',async(req,res)=>{ if(req.query.token!==ADMIN_PASS) return res.status(401).send('Unauthorized'); const list=await storage.getItem('deposits')||[]; const d=list.find(x=>x.id===req.params.id); if(!d||d.status!=='PENDING') return res.send('Ignored'); d.status=req.params.action==='approve'?'APPROVED':'REJECTED'; if(d.status==='APPROVED'){ const u=await findUser(d.email); u.balance+=d.amount; await saveUser(u); } await storage.setItem('deposits',list); res.send(d.status); });

app.get('/api/admin/withdrawals/:id/:action',async(req,res)=>{ if(req.query.token!==ADMIN_PASS) return res.status(401).send('Unauthorized'); const list=await storage.getItem('withdrawals')||[]; const w=list.find(x=>x.id===req.params.id); if(!w||w.status!=='PENDING') return res.send('Ignored'); w.status=req.params.action==='approve'?'APPROVED':'REJECTED'; if(w.status==='APPROVED'){ const u=await findUser(w.email); u.balance-=w.amount; await saveUser(u); } await storage.setItem('withdrawals',list); res.send(w.status); });

// ===== DAILY EARNINGS @ 12:00 AM =====

async function runMidnightEarnings(){ const users=await getUsers(); const today=new Date().toISOString().slice(0,10); let changed=false; for(const u of users){ if(u.lastEarningDay===today) continue; let total=0; for(const f of u.fridges){ total+=f.dailyEarn; } if(total>0){ u.balance+=total; u.lastEarningDay=today; changed=true; } } if(changed) await saveUsers(users); }

setInterval(async()=>{ const now=new Date(); if(now.getHours()===0 && now.getMinutes()<5){ await runMidnightEarnings(); } },5601000);

// ===== STATUS =====

app.get('/api/status',(req,res)=>res.json({ok:true,time:Date.now(),till:MPESA_TILL,name:MPESA_NAME}));

app.listen(PORT,()=>console.log('Bitfreeze running on',PORT));
