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
const { setupChat } = require('./chat');
const { setupPush } = require('./push');
const { setupPayments } = require('./payments');
const { setupTelegram } = require('./telegram');

const app = express();
app.set('trust proxy', 1); // Render sits in front of us: needed to see the real visitor address
app.use(cors());
app.use(express.json({ limit: '3mb' }));

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
const WELCOME_COINS = parseInt(process.env.WELCOME_COINS || '0', 10); // free coins for new users (keep 0 until real SMS)

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


// ---- app icon made by the server itself (no icon files needed) ----
const zlib = require('zlib');
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makeIcon(size) {
  // green square, white circle, green phone handset (anti-aliased)
  const G = [15, 118, 110];
  const px = 1 / size;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const C = { x: 0.625, y: 0.375 }, r = 0.215, arcW = 0.042, padW = 0.05, padL = 0.06;
  const E1 = { x: C.x - r, y: C.y }; // ear end
  const E2 = { x: C.x, y: C.y + r }; // mouth end
  const segDist = (x, y, ax, ay, bx, by) => {
    const vx = bx - ax, vy = by - ay;
    const t = clamp(((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy));
    return Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
  };
  const glyph = (x, y) => {
    const dx = x - C.x, dy = y - C.y;
    const ang = Math.atan2(dy, dx);
    const d = ang >= Math.PI / 2 && ang <= Math.PI
      ? Math.abs(Math.hypot(dx, dy) - r) - arcW
      : Math.min(Math.hypot(x - E1.x, y - E1.y), Math.hypot(x - E2.x, y - E2.y)) - arcW;
    return Math.min(
      d,
      segDist(x, y, E1.x, E1.y, E1.x + padL, E1.y) - padW,
      segDist(x, y, E2.x, E2.y, E2.x, E2.y - padL) - padW
    );
  };
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let p = 0;
  for (let j = 0; j < size; j++) {
    raw[p++] = 0;
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / size, y = (j + 0.5) / size;
      const circ = clamp(0.5 - (Math.hypot(x - 0.5, y - 0.5) - 0.3) / px);
      const gl = clamp(0.5 - glyph(x, y) / px) * circ;
      for (let k = 0; k < 3; k++) {
        const base = G[k] + (255 - G[k]) * circ;
        raw[p++] = Math.round(base + (G[k] - base) * gl);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const ICONS = {};
const iconRoute = (size) => (_, res) => {
  ICONS[size] = ICONS[size] || makeIcon(size);
  res.set('Cache-Control', 'public, max-age=86400').type('png').send(ICONS[size]);
};

// ---- the app itself (PWA) ----
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'app.html')));
app.get('/icon-192.png', iconRoute(192));
app.get('/icon-512.png', iconRoute(512));
app.get('/manifest.json', (_, res) =>
  res.json({
    name: 'Ethio Call',
    short_name: 'Ethio Call',
    start_url: '/',
    display: 'standalone',
    background_color: '#0f766e',
    theme_color: '#0f766e',
    icons: [
      { src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  })
);
const SW_JS = `
self.addEventListener('fetch', function () {});
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  var closeCall = d.tag === 'missed'
    ? self.registration.getNotifications({ tag: 'call' }).then(function (l) { l.forEach(function (n) { n.close(); }); })
    : Promise.resolve();
  e.waitUntil(closeCall.then(function () {
    return self.registration.showNotification(d.title || 'Ethio Call', {
      body: d.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: d.tag || 'ethio',
      renotify: true,
      requireInteraction: !!d.call,
      vibrate: d.call ? [400, 150, 400, 150, 400] : [200],
      data: { url: '/' }
    });
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (l) {
    if (l.length) return l[0].focus();
    return clients.openWindow('/');
  }));
});
`;
app.get('/sw.js', (_, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript').send(SW_JS);
});
// Voice clips: upload files like offline-om.mp3, busy-am.m4a, ringback.mp3 next to index.js
app.get('/sounds/:file', (req, res) => {
  const f = req.params.file;
  if (!/^(ringback|[a-z_]+-(om|am|en))\.(mp3|m4a|ogg|wav)$/.test(f)) return res.status(404).end();
  res.sendFile(path.join(__dirname, f), { maxAge: '1h' }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});
app.get('/health', (_, res) => res.json({ ok: true, sms: SMS_ON, tg: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME && process.env.TELEGRAM_WEBHOOK_SECRET) }));

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
// ---- real SMS through YOUR phone's SIM (free TextBee gateway) ----
// Set TEXTBEE_API_KEY and TEXTBEE_DEVICE_ID on Render to turn it on.
const SMS_ON = !!(process.env.TEXTBEE_API_KEY && process.env.TEXTBEE_DEVICE_ID);
const SMS_DAILY_LIMIT = parseInt(process.env.SMS_DAILY_LIMIT || '200', 10); // protects your SIM and quota
let smsDay = new Date().toDateString(), smsToday = 0;
const otpByIp = new Map(); // ip -> times of code requests

async function sendSms(phone, text) {
  const r = await fetch(
    `https://api.textbee.dev/api/v1/gateway/devices/${process.env.TEXTBEE_DEVICE_ID}/send-sms`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.TEXTBEE_API_KEY },
      body: JSON.stringify({ recipients: [phone], message: text }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!r.ok) throw new Error('SMS gateway error ' + r.status);
}

app.post('/auth/request-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    if (!PHONE.test(phone))
      return res.status(400).json({
        error: 'Use +251 format',
        ...(DEV && { debug_body: req.body, debug_phone: phone }),
      });

    // limits: 1 code per minute and 5 per hour for a number, 8 per 10 minutes for one visitor
    const recent = await pool.query(
      "select count(*) filter (where created_at > now() - interval '60 seconds')::int as last_min, count(*)::int as last_hour from otps where phone=$1 and created_at > now() - interval '1 hour'",
      [phone]
    );
    if (recent.rows[0].last_min) return res.status(429).json({ error: 'Wait 60 seconds' });
    if (recent.rows[0].last_hour >= 5) return res.status(429).json({ error: 'Too many codes. Try again in an hour.' });
    const now = Date.now();
    const ipList = (otpByIp.get(req.ip) || []).filter((t) => now - t < 600000);
    if (ipList.length >= 8) return res.status(429).json({ error: 'Too many requests. Wait 10 minutes.' });
    ipList.push(now); otpByIp.set(req.ip, ipList);

    if (SMS_ON) {
      if (smsDay !== new Date().toDateString()) { smsDay = new Date().toDateString(); smsToday = 0; }
      if (smsToday >= SMS_DAILY_LIMIT) return res.status(503).json({ error: 'SMS limit for today is finished. Try tomorrow.' });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    await pool.query(
      "insert into otps(phone, code_hash, expires_at) values($1, $2, now() + interval '5 minutes')",
      [phone, sha(code)]
    );

    if (SMS_ON) {
      try {
        smsToday++;
        // last line lets Chrome on Android read the code by itself (WebOTP)
        await sendSms(phone, `Ethio Call code: ${code}\nDo not share this code.\n\n@${req.hostname} #${code}`);
      } catch (e) {
        console.error('SMS failed:', e.message);
        await pool.query('delete from otps where phone=$1 and code_hash=$2', [phone, sha(code)]);
        return res.status(502).json({ error: 'Could not send the SMS. Try again.' });
      }
      return res.json({ ok: true, sms: true });
    }

    // no SMS gateway yet: test mode only (anyone can read the code -> not safe for the public)
    console.log(`OTP for ${phone}: ${code}`);
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
  const { name, avatar_url, about } = req.body;
  if (String(avatar_url || '').length > 60000)
    return res.status(400).json({ error: 'Photo too large' });
  const r = await pool.query(
    'update users set name=$2, avatar_url=$3, about=$4 where id=$1 returning *',
    [req.user.id, String(name || '').slice(0, 60), avatar_url, String(about || '').slice(0, 140)]
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
  const testers = (process.env.TEST_PHONES || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (process.env.ALLOW_FREE_COINS !== 'true' || !testers.includes(req.user.phone))
    return res.status(403).json({ error: 'Disabled' });
  const p = await pool.query('select * from packages where id=$1', [req.body.package_id]);
  if (!p.rowCount) return res.status(404).json({ error: 'No package' });
  const bal = await changeCoins(req.user.id, p.rows[0].coins, `package:${p.rows[0].name}`);
  res.json({ coins: bal });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const push = setupPush(app, { pool, auth });
setupCalls(io, { pool, jwt, changeCoins, normalizePhone, push });
setupChat(app, io, { pool, auth, normalizePhone, push });
const telegram = setupTelegram(app, { pool, normalizePhone, PHONE, sha });
const payments = setupPayments(app, io, { pool, auth, changeCoins, normalizePhone, push });

init()
  .then(() => push.init())
  .then(() => payments.init())
  .then(() => telegram.init())
  .then(() => {
    server.listen(process.env.PORT || 3000, '0.0.0.0', () =>
      console.log('API running')
    );
  })
  .catch((e) => {
    console.error('Database init failed:', e.message);
    process.exit(1);
  });
