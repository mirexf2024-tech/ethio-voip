// Reasons for people to prefer Ethio Call: invite friends, free daily coins, gift coins,
// and bigger packages that give bonus coins. All numbers can be changed on Render (Environment).
const crypto = require('crypto');

function setupGrowth(app, io, { pool, auth, changeCoins, normalizePhone, push }) {
  const REF_COINS = parseInt(process.env.REFERRAL_COINS || '5', 10);    // given to BOTH people
  const REF_MAX = parseInt(process.env.REFERRAL_MAX || '20', 10);       // most friends one person can bring
  const DAILY_COINS = parseInt(process.env.DAILY_COINS || '2', 10);     // free coins once a day (0 = off)
  const GIFT_MAX = parseInt(process.env.GIFT_MAX || '100', 10);         // most coins in one gift
  const GIFT_PER_DAY = parseInt(process.env.GIFT_PER_DAY || '5', 10);   // most gifts one person sends per day
  const TODAY = "(now() at time zone 'Africa/Addis_Ababa')::date";

  async function init() {
    await pool.query(`
      alter table users add column if not exists ref_code text;
      alter table users add column if not exists referred_by int;
      alter table users add column if not exists last_daily date;
      create unique index if not exists users_ref_code_unique on users(ref_code);`);
    // clearer names + bonus coins for bigger packages (only if you did not change them yourself)
    await pool.query("update packages set name='Small' where name='Daily' and coins=30 and price_etb=10");
    await pool.query("update packages set name='Medium', coins=165 where name='Weekly' and coins=150 and price_etb=50");
    await pool.query("update packages set name='Large', coins=540 where name='Monthly' and coins=500 and price_etb=150");
  }

  async function notify(userId, coins, added) {
    io.to('u' + userId).emit('wallet:update', { coins, added });
    try {
      const socks = await io.in('u' + userId).fetchSockets();
      if (!socks.length) push.sendPush(userId, { title: '🪙 +' + added, body: 'Ethio Call', tag: 'wallet' });
    } catch (e) { /* ignore */ }
  }

  async function ensureCode(userId) {
    for (let i = 0; i < 5; i++) {
      const cur = await pool.query('select ref_code from users where id=$1', [userId]);
      if (cur.rows[0] && cur.rows[0].ref_code) return cur.rows[0].ref_code;
      try {
        await pool.query('update users set ref_code=$2 where id=$1 and ref_code is null', [
          userId,
          crypto.randomBytes(4).toString('hex').toUpperCase(),
        ]);
      } catch (e) {
        if (e.code !== '23505') throw e; // same code exists: try another
      }
    }
    throw new Error('could not make invite code');
  }

  // called when a NEW account is made with an invite code. Returns the new person's coins (or null)
  async function applyReferral(newUserId, rawCode) {
    if (REF_COINS <= 0) return null;
    const code = String(rawCode || '').trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(code)) return null;
    const r = await pool.query('select id from users where ref_code=$1', [code]);
    if (!r.rowCount || r.rows[0].id === newUserId) return null;
    const referrer = r.rows[0].id;
    const n = await pool.query('select count(*)::int as n from users where referred_by=$1', [referrer]);
    if (n.rows[0].n >= REF_MAX) return null;
    const mark = await pool.query(
      'update users set referred_by=$2 where id=$1 and referred_by is null returning id',
      [newUserId, referrer]
    );
    if (!mark.rowCount) return null;
    const mine = await changeCoins(newUserId, REF_COINS, 'invite bonus');
    const theirs = await changeCoins(referrer, REF_COINS, 'friend joined');
    if (theirs !== null) notify(referrer, theirs, REF_COINS);
    return mine;
  }

  // ---- what the app shows on the wallet screen ----
  app.get('/bonus-info', auth, async (req, res) => {
    try {
      const code = await ensureCode(req.user.id);
      const d = await pool.query(
        `select (last_daily is null or last_daily < ${TODAY}) as can from users where id=$1`,
        [req.user.id]
      );
      const c = await pool.query('select count(*)::int as n from users where referred_by=$1', [req.user.id]);
      res.json({
        daily_coins: DAILY_COINS,
        daily_available: DAILY_COINS > 0 && !!(d.rows[0] && d.rows[0].can),
        ref_code: code,
        ref_coins: REF_COINS,
        ref_count: c.rows[0].n,
        ref_left: Math.max(0, REF_MAX - c.rows[0].n),
        link: `https://${req.hostname}/?ref=${code}`,
        gift_max: GIFT_MAX,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- free coins once a day ----
  app.post('/wallet/daily', auth, async (req, res) => {
    try {
      if (DAILY_COINS <= 0) return res.status(404).json({ error: 'Not available' });
      const u = await pool.query(
        `update users set last_daily=${TODAY}
         where id=$1 and (last_daily is null or last_daily < ${TODAY}) returning id`,
        [req.user.id]
      );
      if (!u.rowCount) return res.status(409).json({ error: 'Come back tomorrow' });
      const bal = await changeCoins(req.user.id, DAILY_COINS, 'daily free coins');
      res.json({ ok: true, coins: bal, added: DAILY_COINS });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- send coins to a friend ----
  app.post('/wallet/gift', auth, async (req, res) => {
    try {
      const b = req.body || {};
      const coins = parseInt(b.coins, 10);
      if (!coins || coins < 1 || coins > GIFT_MAX)
        return res.status(400).json({ error: `Send 1 to ${GIFT_MAX} coins` });
      const p = await pool.query('select id, phone from users where phone=$1', [normalizePhone(b.phone)]);
      if (!p.rowCount) return res.status(404).json({ error: 'User not found' });
      const to = p.rows[0];
      if (to.id === req.user.id) return res.status(400).json({ error: 'You cannot send coins to yourself' });
      const blocked = await pool.query(
        'select 1 from blocks where (user_id=$1 and blocked_id=$2) or (user_id=$2 and blocked_id=$1)',
        [req.user.id, to.id]
      );
      if (blocked.rowCount) return res.status(404).json({ error: 'User not found' });
      const today = await pool.query(
        "select count(*)::int as n from coin_tx where user_id=$1 and reason like 'gift to %' and created_at > now() - interval '24 hours'",
        [req.user.id]
      );
      if (today.rows[0].n >= GIFT_PER_DAY)
        return res.status(429).json({ error: `You can send ${GIFT_PER_DAY} gifts a day` });

      const left = await changeCoins(req.user.id, -coins, 'gift to ' + to.phone.slice(-4));
      if (left === null) return res.status(402).json({ error: 'Not enough coins' });
      let got = null;
      try {
        got = await changeCoins(to.id, coins, 'gift from ' + req.user.phone.slice(-4));
      } catch (e) { console.error(e); }
      if (got === null) {
        await changeCoins(req.user.id, coins, 'gift refund'); // never lose the sender's coins
        return res.status(500).json({ error: 'Could not send, coins returned' });
      }
      notify(to.id, got, coins);
      res.json({ ok: true, coins: left });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return { init, applyReferral };
}

module.exports = { setupGrowth };
