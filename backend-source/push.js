// Push notifications: browser Web Push plus native Android Firebase Cloud Messaging.
const webpush = require('web-push');
let firebaseMessaging = null;

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
    await pool.query(`create table if not exists fcm_tokens(
      id bigserial primary key,
      user_id int references users(id) on delete cascade,
      token text unique not null,
      platform text not null default 'android',
      created_at timestamptz default now(),
      updated_at timestamptz default now())`);

    // FCM remains optional until the Firebase service-account JSON is added to Render.
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        const admin = require('firebase-admin');
        if (!admin.apps.length) {
          const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
          admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        firebaseMessaging = admin.messaging();
        console.log('Firebase Cloud Messaging ready');
      } catch (e) {
        console.error('FCM configuration invalid:', e.message);
      }
    }

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
    console.log('Web Push ready');
  }

  async function hasSubs(userId) {
    const r = await pool.query(
      'select 1 from push_subs where user_id=$1 union all select 1 from fcm_tokens where user_id=$1 limit 1',
      [userId]
    );
    return r.rowCount > 0;
  }

  async function sendPush(userId, payload) {
    let sent = 0;
    try {
      const r = await pool.query(
        'select id, endpoint, p256dh, auth from push_subs where user_id=$1',
        [userId]
      );
      await Promise.all(r.rows.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload),
            { TTL: payload.call ? 45 : 3600, urgency: payload.call ? 'high' : 'normal' }
          );
          sent++;
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410)
            await pool.query('delete from push_subs where id=$1', [s.id]);
          else console.error('web push error', e.statusCode || e.message);
        }
      }));

      if (firebaseMessaging) {
        const tokens = await pool.query('select id, token from fcm_tokens where user_id=$1', [userId]);
        if (tokens.rowCount) {
          const response = await firebaseMessaging.sendEachForMulticast({
            tokens: tokens.rows.map(x => x.token),
            notification: {
              title: String(payload.title || 'Ethio Call').slice(0, 100),
              body: String(payload.body || '').slice(0, 300)
            },
            data: {
              tag: String(payload.tag || 'ethio'),
              call: payload.call ? 'true' : 'false'
            },
            android: {
              priority: payload.call ? 'high' : 'normal',
              ttl: payload.call ? 45000 : 3600000
            }
          });
          sent += response.successCount;
          const invalid = [];
          response.responses.forEach((item, i) => {
            if (!item.success && item.error &&
              ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(item.error.code)) {
              invalid.push(tokens.rows[i].id);
            }
          });
          if (invalid.length) await pool.query('delete from fcm_tokens where id = any($1::bigint[])', [invalid]);
        }
      }
    } catch (e) {
      console.error('push send error:', e.message);
    }
    return sent;
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

  app.post('/push/register-token', auth, async (req, res) => {
    try {
      const token = String(req.body && req.body.token || '').trim();
      if (token.length < 20 || token.length > 4096)
        return res.status(400).json({ error: 'Invalid device token' });
      await pool.query(
        `insert into fcm_tokens(user_id, token, platform) values($1,$2,'android')
         on conflict(token) do update set user_id=excluded.user_id, platform='android', updated_at=now()`,
        [req.user.id, token]
      );
      res.json({ ok: true, fcm: !!firebaseMessaging });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/push/unregister-token', auth, async (req, res) => {
    const token = String(req.body && req.body.token || '').trim();
    if (token) await pool.query('delete from fcm_tokens where token=$1 and user_id=$2', [token, req.user.id]);
    res.json({ ok: true });
  });

  app.post('/push/unsubscribe', auth, async (req, res) => {
    const ep = req.body && req.body.endpoint;
    if (ep) await pool.query('delete from push_subs where endpoint=$1 and user_id=$2', [ep, req.user.id]);
    res.json({ ok: true });
  });

  app.post('/push/test', auth, async (req, res) => {
    const sent = await sendPush(req.user.id, {
      title: 'Ethio Call',
      body: 'Notifications test',
      tag: 'test',
    });
    res.json({ ok: true, sent });
  });

  return { init, sendPush, hasSubs };
}

module.exports = { setupPush };
