// Ads: (1) a banner box that shows YOUR ad code (Adsterra etc.), (2) "Watch and earn" rewarded video.
//
// IMPORTANT RULES (read once):
//  - Adsterra does NOT allow incentivized traffic (paying users to view or click ads). So the
//    Adsterra banner is shown only as a normal banner. It is never connected to the coin reward.
//  - Rewarded video (watch -> get coins) is for Start.io. Start.io works inside a real Android/iOS app
//    (it is an app SDK, not a website script). So the button appears only when the Ethio Call app is
//    opened inside your Android wrapper app that offers window.EthioNative.showRewarded().
//    In the normal browser/PWA the button stays hidden.
//  - The server checks every reward: one open video at a time, a minimum watch time, a gap between
//    rewards and a daily limit. Numbers can be changed on Render (Environment).
const REWARD_COINS = parseInt(process.env.REWARD_COINS || '0', 10);          // coins for one video (0 = off)
const REWARD_DAILY_MAX = parseInt(process.env.REWARD_DAILY_MAX || '10', 10); // videos per person per day
const REWARD_MIN_SECONDS = parseInt(process.env.REWARD_MIN_SECONDS || '15', 10); // shortest real watch time
const REWARD_GAP_SECONDS = parseInt(process.env.REWARD_GAP_SECONDS || '30', 10); // wait between two rewards
const TODAY = "(now() at time zone 'Africa/Addis_Ababa')::date";
const DAYOF = (col) => `(${col} at time zone 'Africa/Addis_Ababa')::date`;

function setupAds(app, { pool, auth, changeCoins, adminOk }) {
  let cache = null, cacheAt = 0;

  async function settings() {
    if (cache && Date.now() - cacheAt < 30000) return cache;
    const r = await pool.query("select key, value from kv where key like 'ads_%' or key = 'reward_on'");
    const m = {};
    r.rows.forEach((x) => { m[x.key] = x.value; });
    cache = {
      ads_on: (m.ads_on || '1') === '1',
      banner: m.ads_banner || '',
      height: Math.max(50, Math.min(300, parseInt(m.ads_height || '100', 10) || 100)),
      reward_on: (m.reward_on || '1') === '1',
    };
    cacheAt = Date.now();
    return cache;
  }

  async function setKv(key, value) {
    await pool.query(
      'insert into kv(key, value) values($1,$2) on conflict(key) do update set value=excluded.value',
      [key, String(value)]
    );
  }

  async function init() {
    await pool.query(`
      create table if not exists kv(key text primary key, value text);
      create table if not exists ad_rewards(
        id serial primary key,
        user_id int not null references users(id) on delete cascade,
        status text not null default 'started',
        coins int not null default 0,
        started_at timestamptz default now(),
        claimed_at timestamptz
      );
      create index if not exists ad_rewards_user_idx on ad_rewards(user_id, id);`);
  }

  async function usedToday(userId) {
    const r = await pool.query(
      `select count(*)::int as n, max(claimed_at) as last from ad_rewards
       where user_id=$1 and status='claimed' and ${DAYOF('claimed_at')} = ${TODAY}`,
      [userId]
    );
    return r.rows[0];
  }

  // ---- what the app needs to show ads ----
  app.get('/ads/config', auth, async (req, res) => {
    try {
      const s = await settings();
      const u = await usedToday(req.user.id);
      const left = Math.max(0, REWARD_DAILY_MAX - u.n);
      res.json({
        banner: s.ads_on ? s.banner : '',
        height: s.height,
        reward: {
          on: REWARD_COINS > 0 && s.reward_on,
          coins: REWARD_COINS,
          left,
          min_seconds: REWARD_MIN_SECONDS,
        },
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- step 1: the phone is about to show a rewarded video ----
  app.post('/ads/reward/start', auth, async (req, res) => {
    try {
      const s = await settings();
      if (!(REWARD_COINS > 0 && s.reward_on)) return res.status(404).json({ error: 'Not available' });
      const u = await usedToday(req.user.id);
      if (u.n >= REWARD_DAILY_MAX) return res.status(429).json({ error: 'Come back tomorrow for more videos' });
      if (u.last && Date.now() - new Date(u.last).getTime() < REWARD_GAP_SECONDS * 1000)
        return res.status(429).json({ error: 'Please wait a little before the next video' });
      const hour = await pool.query(
        "select count(*)::int as n from ad_rewards where user_id=$1 and started_at > now() - interval '1 hour'",
        [req.user.id]
      );
      if (hour.rows[0].n >= 30) return res.status(429).json({ error: 'Too many tries. Wait a while.' });
      await pool.query("update ad_rewards set status='expired' where user_id=$1 and status='started'", [req.user.id]);
      const r = await pool.query('insert into ad_rewards(user_id) values($1) returning id', [req.user.id]);
      res.json({ ok: true, id: r.rows[0].id, min_seconds: REWARD_MIN_SECONDS });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- step 2: the video finished; the server decides if the reward is fair ----
  app.post('/ads/reward/claim', auth, async (req, res) => {
    try {
      const id = parseInt(req.body && req.body.id, 10);
      if (!id) return res.status(400).json({ error: 'Bad id' });
      const c = await pool.query(
        `update ad_rewards set status='claimed', claimed_at=now(), coins=$3
         where id=$1 and user_id=$2 and status='started'
           and started_at <= now() - make_interval(secs => $4::int)
           and started_at > now() - interval '10 minutes'
           and (select count(*) from ad_rewards x
                where x.user_id=$2 and x.status='claimed' and ${DAYOF('x.claimed_at')} = ${TODAY}) < $5::int
         returning id`,
        [id, req.user.id, REWARD_COINS, REWARD_MIN_SECONDS, REWARD_DAILY_MAX]
      );
      if (!c.rowCount) return res.status(409).json({ error: 'No reward this time. Watch the whole video.' });
      const bal = await changeCoins(req.user.id, REWARD_COINS, 'watch and earn');
      if (bal === null) {
        await pool.query("update ad_rewards set status='expired', claimed_at=null, coins=0 where id=$1", [id]);
        return res.status(500).json({ error: 'Could not add coins, try again' });
      }
      const u = await usedToday(req.user.id);
      res.json({ ok: true, coins: bal, added: REWARD_COINS, left: Math.max(0, REWARD_DAILY_MAX - u.n) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---------- admin: paste your banner code, switch things on/off ----------
  app.get('/admin/ads', async (req, res) => {
    if (!adminOk(req, res)) return;
    try {
      cache = null;
      const s = await settings();
      const t = await pool.query(
        `select count(*)::int as n, coalesce(sum(coins),0)::int as coins
         from ad_rewards where status='claimed' and ${DAYOF('claimed_at')} = ${TODAY}`
      );
      res.json({ ...s, rewards_today: t.rows[0].n, reward_coins_today: t.rows[0].coins });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/admin/ads', async (req, res) => {
    if (!adminOk(req, res)) return;
    try {
      const b = req.body || {};
      const banner = String(b.banner || '').trim();
      if (banner.length > 5000) return res.status(400).json({ error: 'Banner code is too long (max 5000 letters)' });
      const height = Math.max(50, Math.min(300, parseInt(b.height, 10) || 100));
      await setKv('ads_banner', banner);
      await setKv('ads_height', height);
      await setKv('ads_on', b.ads_on === false ? '0' : '1');
      await setKv('reward_on', b.reward_on === false ? '0' : '1');
      cache = null;
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return { init };
}

module.exports = { setupAds };
