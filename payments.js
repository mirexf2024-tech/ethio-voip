// Coins are only added after a payment is confirmed by YOU (the admin).
// Flow: user pays by Telebirr -> sends the transaction ID in the app -> you check your
// Telebirr app -> you approve on /admin -> coins are added.
const crypto = require('crypto');
const path = require('path');

function setupPayments(app, io, { pool, auth, changeCoins, normalizePhone, push }) {
  const wrongTries = new Map(); // ip -> times of wrong admin keys

  async function init() {
    await pool.query(`
      create table if not exists purchases(
        id serial primary key,
        user_id int not null references users(id) on delete cascade,
        package_id int,
        package_name text,
        coins int not null,
        price_etb int,
        ref text not null,
        status text not null default 'pending',
        created_at timestamptz default now(),
        decided_at timestamptz
      );
      create unique index if not exists purchases_ref_unique
        on purchases(lower(ref)) where status <> 'rejected';`);
  }

  // ---------- user side ----------
  app.get('/pay-info', auth, (req, res) => {
    const testers = (process.env.TEST_PHONES || '').split(',').map((s) => s.trim()).filter(Boolean);
    res.json({
      method: process.env.PAY_METHOD || 'Telebirr',
      number: process.env.PAY_NUMBER || '',
      holder: process.env.PAY_NAME || '',
      // free test coins only for numbers you list in TEST_PHONES and only if ALLOW_FREE_COINS=true
      free: process.env.ALLOW_FREE_COINS === 'true' && testers.includes(req.user.phone),
    });
  });

  app.post('/wallet/request', auth, async (req, res) => {
    try {
      const body = req.body || {};
      const ref = String(body.ref || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6,30}$/.test(ref))
        return res.status(400).json({ error: 'Enter the transaction ID from your payment message' });
      const p = await pool.query('select * from packages where id=$1', [parseInt(body.package_id, 10)]);
      if (!p.rowCount) return res.status(404).json({ error: 'No package' });
      const pending = await pool.query(
        "select count(*)::int as n from purchases where user_id=$1 and status='pending'",
        [req.user.id]
      );
      if (pending.rows[0].n >= 3)
        return res.status(429).json({ error: 'You already have 3 requests waiting' });
      const pk = p.rows[0];
      try {
        const r = await pool.query(
          `insert into purchases(user_id, package_id, package_name, coins, price_etb, ref)
           values($1,$2,$3,$4,$5,$6) returning id`,
          [req.user.id, pk.id, pk.name, pk.coins, pk.price_etb, ref]
        );
        res.json({ ok: true, id: r.rows[0].id });
      } catch (e) {
        if (e.code === '23505')
          return res.status(409).json({ error: 'This transaction ID was already used' });
        throw e;
      }
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/wallet/requests', auth, async (req, res) => {
    const r = await pool.query(
      `select id, package_name, coins, price_etb, ref, status, created_at
       from purchases where user_id=$1 order by id desc limit 20`,
      [req.user.id]
    );
    res.json(r.rows);
  });

  // ---------- admin side (needs ADMIN_KEY set on Render) ----------
  function adminOk(req, res) {
    const key = process.env.ADMIN_KEY;
    if (!key) { res.status(503).json({ error: 'Admin is off. Set ADMIN_KEY on Render first.' }); return false; }
    const now = Date.now();
    const list = (wrongTries.get(req.ip) || []).filter((t) => now - t < 600000);
    if (list.length >= 10) { res.status(429).json({ error: 'Too many wrong keys. Wait 10 minutes.' }); return false; }
    const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
    if (!crypto.timingSafeEqual(hash(req.headers['x-admin-key'] || ''), hash(key))) {
      list.push(now); wrongTries.set(req.ip, list);
      res.status(401).json({ error: 'Wrong key' });
      return false;
    }
    return true;
  }

  async function notifyUser(userId, coins, added) {
    io.to('u' + userId).emit('wallet:update', { coins, added });
    try {
      const socks = await io.in('u' + userId).fetchSockets();
      if (!socks.length)
        push.sendPush(userId, { title: '🪙 +' + added, body: 'Payment confirmed', tag: 'wallet' });
    } catch (e) { /* ignore */ }
  }

  app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'admin.html')));

  app.get('/admin/requests', async (req, res) => {
    if (!adminOk(req, res)) return;
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const r = await pool.query(
      `select p.id, p.package_name, p.coins, p.price_etb, p.ref, p.status, p.created_at, u.phone, u.name
       from purchases p join users u on u.id=p.user_id
       where p.status=$1 order by p.id desc limit 50`,
      [status]
    );
    res.json(r.rows);
  });

  app.post('/admin/decide', async (req, res) => {
    if (!adminOk(req, res)) return;
    try {
      const id = parseInt(req.body && req.body.id, 10);
      if (!id) return res.status(400).json({ error: 'Bad id' });
      if (!(req.body && req.body.approve)) {
        const r = await pool.query(
          "update purchases set status='rejected', decided_at=now() where id=$1 and status='pending' returning id",
          [id]
        );
        return r.rowCount ? res.json({ ok: true }) : res.status(409).json({ error: 'Already decided' });
      }
      // claim it first so it can never be paid twice
      const c = await pool.query(
        "update purchases set status='approved', decided_at=now() where id=$1 and status='pending' returning *",
        [id]
      );
      if (!c.rowCount) return res.status(409).json({ error: 'Already decided' });
      const pu = c.rows[0];
      let bal = null;
      try { bal = await changeCoins(pu.user_id, pu.coins, 'purchase:' + pu.id); } catch (e) { console.error(e); }
      if (bal === null) {
        await pool.query("update purchases set status='pending', decided_at=null where id=$1", [pu.id]);
        return res.status(500).json({ error: 'Could not add coins, try again' });
      }
      notifyUser(pu.user_id, bal, pu.coins);
      res.json({ ok: true, coins: bal });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/admin/credit', async (req, res) => {
    if (!adminOk(req, res)) return;
    try {
      const b = req.body || {};
      const coins = parseInt(b.coins, 10);
      if (!coins || coins < 1 || coins > 100000) return res.status(400).json({ error: 'Coins must be 1 to 100000' });
      const u = await pool.query('select id from users where phone=$1', [normalizePhone(b.phone)]);
      if (!u.rowCount) return res.status(404).json({ error: 'User not found' });
      const note = String(b.note || 'manual').slice(0, 40);
      const bal = await changeCoins(u.rows[0].id, coins, 'admin:' + note);
      notifyUser(u.rows[0].id, bal, coins);
      res.json({ ok: true, coins: bal });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return { init };
}

module.exports = { setupPayments };
