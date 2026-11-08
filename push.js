// Push notifications (free, built into the browser). Keys are made once and kept in the database.
const webpush = require('web-push');

function setupPush(app, { pool, auth }) {
  let publicKey = null;

  async function init() {
    await pool.query('create table if not exists kv(key text primary key, value text)');
    await pool.query(`create table if not exists push_subs(
      id serial primary key,
      user_id int references users(id) on delete cascade,
      endpoint text unique not null,
      p256dh text not null,
      auth text not null,
      created_at timestamptz default now())`);

    let r = await pool.query("select value from kv where key='vapid'");
    if (!r.rowCount) {
      await pool.query("insert into kv(key, value) values('vapid', $1) on conflict do nothing", [
        JSON.stringify(webpush.generateVAPIDKeys()),
      ]);
      r = await pool.query("select value from kv where key='vapid'");
    }
    const keys = JSON.parse(r.rows[0].value);
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || 'https://ethio-voip.onrender.com',
      keys.publicKey,
      keys.privateKey
    );
    publicKey = keys.publicKey;
    console.log('push ready');
  }

  async function hasSubs(userId) {
    const r = await pool.query('select 1 from push_subs where user_id=$1 limit 1', [userId]);
    return r.rowCount > 0;
  }

  // send a notification to every device of one user; returns how many were accepted
  async function sendPush(userId, payload) {
    try {
      if (!publicKey) return 0;
      const r = await pool.query(
        'select id, endpoint, p256dh, auth from push_subs where user_id=$1',
        [userId]
      );
      let n = 0;
      await Promise.all(
        r.rows.map(async (s) => {
          try {
            await webpush.sendNotification(
              { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
              JSON.stringify(payload),
              { TTL: payload.call ? 45 : 3600, urgency: payload.call ? 'high' : 'normal' }
            );
            n++;
          } catch (e) {
            if (e.statusCode === 404 || e.statusCode === 410)
              await pool.query('delete from push_subs where id=$1', [s.id]); // device is gone
            else console.error('push error', e.statusCode || e.message);
          }
        })
      );
      return n;
    } catch (e) {
      console.error(e);
      return 0;
    }
  }

  app.get('/push/key', (_, res) => res.json({ key: publicKey }));

  app.post('/push/subscribe', auth, async (req, res) => {
    try {
      const s = req.body && req.body.subscription;
      if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth)
        return res.status(400).json({ error: 'Bad subscription' });
      await pool.query(
        `insert into push_subs(user_id, endpoint, p256dh, auth) values($1,$2,$3,$4)
         on conflict(endpoint) do update
           set user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`,
        [req.user.id, s.endpoint, s.keys.p256dh, s.keys.auth]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/push/unsubscribe', auth, async (req, res) => {
    const ep = req.body && req.body.endpoint;
    if (ep) await pool.query('delete from push_subs where endpoint=$1 and user_id=$2', [ep, req.user.id]);
    res.json({ ok: true });
  });

  app.post('/push/test', auth, async (req, res) => {
    const sent = await sendPush(req.user.id, {
      title: 'Ethio Call',
      body: '✅ Notifications work',
      tag: 'test',
    });
    res.json({ ok: true, sent });
  });

  return { init, sendPush, hasSubs };
}

module.exports = { setupPush };
