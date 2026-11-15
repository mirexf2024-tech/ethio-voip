// Free login codes through a Telegram bot (no SMS, no SIM credit).
// Flow: user types phone in the app -> taps "Telegram" -> bot asks to share the phone number
// -> bot checks it is the SAME number and sends the code inside Telegram -> user types it in the app.
// The code itself is checked by the normal /auth/verify-otp, so nobody can log in as someone else.
const crypto = require('crypto');

function setupTelegram(app, { pool, normalizePhone, PHONE, sha }) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  const USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace('@', '');
  const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  const on = !!(BOT_TOKEN && USERNAME && SECRET);
  const byIp = new Map(); // ip -> times of link requests

  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const sameSecret = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));

  async function init() {
    await pool.query(`
      create table if not exists tg_logins(
        token text primary key,
        phone text not null,
        chat_id bigint,
        used boolean not null default false,
        created_at timestamptz default now(),
        expires_at timestamptz not null
      );`);
  }

  async function send(chat, text, extra) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, ...extra }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      console.error('telegram send failed:', e.message);
    }
  }

  // ---- app asks for a link to the bot ----
  app.post('/auth/tg/start', async (req, res) => {
    try {
      if (!on) return res.status(503).json({ error: 'Telegram login is not set up' });
      const phone = normalizePhone(req.body && req.body.phone);
      if (!PHONE.test(phone)) return res.status(400).json({ error: 'Use +251 format' });
      const now = Date.now();
      const list = (byIp.get(req.ip) || []).filter((t) => now - t < 600000);
      if (list.length >= 10) return res.status(429).json({ error: 'Too many requests. Wait 10 minutes.' });
      list.push(now); byIp.set(req.ip, list);

      const token = crypto.randomBytes(18).toString('base64url');
      await pool.query(
        "insert into tg_logins(token, phone, expires_at) values($1,$2, now() + interval '10 minutes')",
        [token, phone]
      );
      res.json({ ok: true, link: `https://t.me/${USERNAME}?start=${token}` });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- Telegram calls this when someone writes to the bot ----
  app.post('/telegram/webhook', async (req, res) => {
    if (!on || !sameSecret(req.headers['x-telegram-bot-api-secret-token'] || '', SECRET))
      return res.status(401).end();
    res.json({ ok: true }); // answer Telegram quickly, then work
    try {
      const m = req.body && req.body.message;
      if (!m || !m.chat || m.chat.type !== 'private') return;
      const chat = m.chat.id;

      if (typeof m.text === 'string' && m.text.startsWith('/start')) {
        const tok = m.text.split(' ')[1] || '';
        const r = await pool.query(
          'update tg_logins set chat_id=$2 where token=$1 and not used and expires_at > now() returning phone',
          [tok, chat]
        );
        if (!r.rowCount)
          return send(chat, 'This link is old. Please go back to the Ethio Call app and tap Telegram again.');
        return send(
          chat,
          `To get your Ethio Call code for ${r.rows[0].phone}, tap the button below and share your phone number.`,
          { reply_markup: { keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
        );
      }

      if (m.contact) {
        const rm = { reply_markup: { remove_keyboard: true } };
        // must be the sender's OWN contact, not a forwarded one
        if (!m.from || m.contact.user_id !== m.from.id)
          return send(chat, 'Please share YOUR OWN number using the button.', rm);
        const r = await pool.query(
          'select token, phone from tg_logins where chat_id=$1 and not used and expires_at > now() order by created_at desc limit 1',
          [chat]
        );
        if (!r.rowCount)
          return send(chat, 'Please open the link from the Ethio Call app again.', rm);
        const phone = normalizePhone(m.contact.phone_number);
        if (!PHONE.test(phone))
          return send(chat, 'Ethio Call works only with Ethio telecom and Safaricom Ethiopia numbers (+251).', rm);
        if (phone !== r.rows[0].phone)
          return send(chat, 'This number is not the same as the number you typed in the app.', rm);

        const recent = await pool.query(
          "select count(*) filter (where created_at > now() - interval '60 seconds')::int as last_min, count(*)::int as last_hour from otps where phone=$1 and created_at > now() - interval '1 hour'",
          [phone]
        );
        if (recent.rows[0].last_min || recent.rows[0].last_hour >= 5)
          return send(chat, 'Too many codes. Please wait a few minutes.', rm);

        const code = String(crypto.randomInt(100000, 1000000));
        await pool.query(
          "insert into otps(phone, code_hash, expires_at) values($1, $2, now() + interval '5 minutes')",
          [phone, sha(code)]
        );
        await pool.query('update tg_logins set used=true where token=$1', [r.rows[0].token]);
        return send(chat, `Your Ethio Call code: ${code}\nIt works for 5 minutes. Do not share it with anyone.`, rm);
      }
    } catch (e) {
      console.error('telegram error:', e.message);
    }
  });

  return { init, on };
}

module.exports = { setupTelegram };
