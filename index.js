require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { pool, init } = require('./db');
const { setupCalls } = require('./calls');

const app = express();
app.use(cors());
app.use(express.json({ limit: '300kb' }));

const PHONE = /^\+251[79]\d{8}$/; // Ethio telecom 9..., Safaricom 7...
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Cleans the phone: removes spaces/hidden characters, accepts 09..., 07..., 251..., +251...
function normalizePhone(p) {
  if (typeof p !== 'string') return '';
  const s = p.replace(/[^\d+]/g, '');
  if (s.startsWith('+')) return s;
  if (s.startsWith('251')) return '+' + s;
  if (s.startsWith('0')) return '+251' + s.slice(1);
  if (/^[79]\d{8}$/.test(s)) return '+251' + s;
  return s;
}
// Set NODE_ENV=production on Render to disable dev-only features
const DEV = process.env.NODE_ENV !== 'production';
const WELCOME_COINS = parseInt(process.env.WELCOME_COINS || '5', 10); // free coins for new users

const auth = (req, res, next) => {
  const raw = req.headers.authorization || '';
  // remove "Bearer", quotes, spaces and line breaks that phones sometimes add
  const t = raw.replace(/^Bearer\s+/i, '').replace(/["'\s]/g, '');
  try {
    req.user = jwt.verify(t, process.env.JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({
      error: 'Unauthorized',
      ...(DEV && { reason: e.message, header_length: raw.length, token_length: t.length }),
    });
  }
};

// Atomic coin change (balance can never go below 0)
async function changeCoins(userId, delta, reason) {
  const r = await pool.query(
    `with u as (
       update users set coins = coins + $2::int
       where id = $1 and coins + $2::int >= 0
       returning id, coins)
     insert into coin_tx(user_id, amount, balance_after, reason)
     select id, $2::int, coins, $3 from u
     returning balance_after`,
    [userId, delta, reason]
  );
  return r.rowCount ? r.rows[0].balance_after : null;
}

// ---- the app itself (PWA) ----
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'app.html')));
app.get('/icon-192.png', (_, res) => res.sendFile(path.join(__dirname, 'icon-192.png')));
app.get('/icon-512.png', (_, res) => res.sendFile(path.join(__dirname, 'icon-512.png')));
app.get('/manifest.json', (_, res) =>
  res.json({
    name: 'Ethio Call',
    short_name: 'Ethio Call',
    start_url: '/',
    display: 'standalone',
    background_color: '#0f766e',
    theme_color: '#0f766e',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  })
);
app.get('/sw.js', (_, res) => {
  res.type('application/javascript').send("self.addEventListener('fetch', function () {});");
});
app.get('/health', (_, res) => res.json({ ok: true }));

// Browser test page for calls (open /test on two phones)
app.get('/test', (_, res) => res.sendFile(path.join(__dirname, 'test.html')));

// STUN/TURN servers for calls. Add a TURN server later via ICE_SERVERS env (JSON)
app.get('/ice', auth, (_, res) => {
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  try {
    if (process.env.ICE_SERVERS) iceServers = JSON.parse(process.env.ICE_SERVERS);
  } catch (e) {
    console.error('ICE_SERVERS is not valid JSON');
  }
  res.json({ iceServers });
});

// ---------- AUTH ----------
app.post('/auth/request-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    if (!PHONE.test(phone))
      return res.status(400).json({
        error: 'Use +251 format',
        ...(DEV && { debug_body: req.body, debug_phone: phone }),
      });

    const recent = await pool.query(
      "select 1 from otps where phone=$1 and created_at > now() - interval '60 seconds'",
      [phone]
    );
    if (recent.rowCount)
      return res.status(429).json({ error: 'Wait 60 seconds' });

    const code = String(crypto.randomInt(100000, 1000000));
    await pool.query(
      "insert into otps(phone, code_hash, expires_at) values($1, $2, now() + interval '5 minutes')",
      [phone, sha(code)]
    );
    console.log(`OTP for ${phone}: ${code}`);
    // TODO: send real SMS here
    res.json({ ok: true, ...(DEV && { devCode: code }) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/verify-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    const code = req.body && req.body.code;
    const r = await pool.query(
      `select * from otps
       where phone=$1 and used=false and expires_at > now()
       order by created_at desc limit 1`,
      [phone]
    );
    const o = r.rows[0];
    if (!o) return res.status(400).json({ error: 'Code expired' });
    if (o.attempts >= 5)
      return res.status(429).json({ error: 'Too many attempts' });
    if (o.code_hash !== sha(String(code))) {
      await pool.query('update otps set attempts = attempts + 1 where id=$1', [o.id]);
      return res.status(400).json({ error: 'Wrong code' });
    }
    await pool.query('update otps set used=true where id=$1', [o.id]);

    const u = await pool.query(
      `insert into users(phone) values($1)
       on conflict(phone) do update set phone = excluded.phone
       returning *, (xmax = 0) as inserted`,
      [phone]
    );
    const user = u.rows[0];
    if (user.inserted && WELCOME_COINS > 0) {
      const bal = await changeCoins(user.id, WELCOME_COINS, 'welcome bonus');
      if (bal !== null) user.coins = bal;
    }
    delete user.inserted;
    const token = jwt.sign({ id: user.id, phone }, process.env.JWT_SECRET, {
      expiresIn: '30d',
    });
    res.json({ token, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- PROFILE ----------
app.get('/me', auth, async (req, res) => {
  const r = await pool.query('select * from users where id=$1', [req.user.id]);
  res.json(r.rows[0]);
});

app.put('/profile', auth, async (req, res) => {
  const { name, avatar_url } = req.body;
  const r = await pool.query(
    'update users set name=$2, avatar_url=$3 where id=$1 returning *',
    [req.user.id, name, avatar_url]
  );
  res.json(r.rows[0]);
});

// ---------- WALLET ----------
app.get('/wallet', auth, async (req, res) => {
  const b = await pool.query('select coins from users where id=$1', [req.user.id]);
  const tx = await pool.query(
    `select amount, balance_after, reason, created_at
     from coin_tx where user_id=$1 order by id desc limit 30`,
    [req.user.id]
  );
  res.json({ coins: b.rows[0].coins, history: tx.rows });
});

app.get('/packages', auth, async (_, res) => {
  res.json((await pool.query('select * from packages order by id')).rows);
});

// DEV ONLY: free top-up until real payment is added
app.post('/wallet/dev-buy', auth, async (req, res) => {
  if (!DEV) return res.status(403).json({ error: 'Disabled' });
  const p = await pool.query('select * from packages where id=$1', [req.body.package_id]);
  if (!p.rowCount) return res.status(404).json({ error: 'No package' });
  const bal = await changeCoins(req.user.id, p.rows[0].coins, `package:${p.rows[0].name}`);
  res.json({ coins: bal });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
setupCalls(io, { pool, jwt, changeCoins, normalizePhone });

init()
  .then(() => {
    server.listen(process.env.PORT || 3000, '0.0.0.0', () =>
      console.log('API running')
    );
  })
  .catch((e) => {
    console.error('Database init failed:', e.message);
    process.exit(1);
  });
