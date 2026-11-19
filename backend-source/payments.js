// Coins are only added after a payment is confirmed by YOU (the admin).
// Flow: user pays by Telebirr -> sends the transaction ID in the app -> you check your
// Telebirr app -> you approve on /admin -> coins are added.
const crypto = require('crypto');
const path = require('path');

function setupPayments(app, io, { pool, auth, changeCoins, normalizePhone, push }) {
  const wrongTries = new Map(); // ip -> times of wrong admin keys
  const bannedIds = new Set();  // suspended users (kept in memory so every request stays fast)
  let lastBroadcast = 0;

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
        on purchases(lower(ref)) where status <> 'rejected';
      alter table users add column if not exists banned boolean not null default false;
      create table if not exists creator_withdrawals (
        id bigserial primary key,
        user_id int not null references users(id) on delete cascade,
        diamonds bigint not null check (diamonds > 0),
        amount_etb numeric(12,2),
        payout_method text,
        payout_account text,
        payout_reference text,
        status text not null default 'pending' check (status in ('pending','approved','paid','rejected')),
        admin_note text,
        created_at timestamptz not null default now(),
        decided_at timestamptz
      );
      create index if not exists creator_withdrawals_user_idx on creator_withdrawals(user_id,created_at desc);`);
    const b = await pool.query('select id from users where banned');
    b.rows.forEach((r) => bannedIds.add(r.id));
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

  // Creator Diamonds are earned from gifts; they are not cash until a payout is confirmed.
  app.get('/wallet/creator', auth, async (req,res) => {
    try {
      const [earned,pending,closed,history,requests] = await Promise.all([
        pool.query('select coalesce(sum(diamonds),0)::bigint n from creator_earnings where user_id=$1',[req.user.id]),
        pool.query("select coalesce(sum(diamonds),0)::bigint n from creator_withdrawals where user_id=$1 and status='pending'",[req.user.id]),
        pool.query("select coalesce(sum(diamonds),0)::bigint n from creator_withdrawals where user_id=$1 and status in ('approved','paid')",[req.user.id]),
        pool.query('select id,diamonds,source,source_id,created_at from creator_earnings where user_id=$1 order by id desc limit 30',[req.user.id]),
        pool.query('select id,diamonds,amount_etb,payout_method,status,admin_note,created_at,decided_at from creator_withdrawals where user_id=$1 order by id desc limit 20',[req.user.id])
      ]);
      const reserved=Number(pending.rows[0].n)+Number(closed.rows[0].n);
      res.json({diamonds:Math.max(0,Number(earned.rows[0].n)-reserved),earned:Number(earned.rows[0].n),pending:Number(pending.rows[0].n),withdrawn:Number(closed.rows[0].n),cashout_enabled:process.env.CREATOR_CASHOUT_ENABLED==='true',history:history.rows,requests:requests.rows});
    } catch(e) { console.error(e); res.status(500).json({error:'Could not load creator balance'}); }
  });

  app.post('/wallet/creator/withdraw', auth, async (req,res) => {
    try {
      if(process.env.CREATOR_CASHOUT_ENABLED!=='true') return res.status(503).json({error:'Creator withdrawals are not open yet'});
      const diamonds=Number(req.body?.diamonds), method=String(req.body?.payout_method||'').trim().toLowerCase(), account=String(req.body?.payout_account||'').trim();
      if(!Number.isSafeInteger(diamonds)||diamonds<1||diamonds>100000000) return res.status(400).json({error:'Enter a valid Diamond amount'});
      if(!['telebirr','bank'].includes(method)||account.length<6||account.length>80) return res.status(400).json({error:'Enter a valid Telebirr or bank payout account'});
      const c=await pool.connect(); let request;
      try {
        await c.query('begin');
        await c.query('select id from users where id=$1 for update',[req.user.id]);
        const earned=await c.query('select coalesce(sum(diamonds),0)::bigint n from creator_earnings where user_id=$1',[req.user.id]);
        const reserved=await c.query("select coalesce(sum(diamonds),0)::bigint n from creator_withdrawals where user_id=$1 and status in ('pending','approved','paid')",[req.user.id]);
        if(diamonds>Number(earned.rows[0].n)-Number(reserved.rows[0].n)){await c.query('rollback');return res.status(409).json({error:'Not enough available Diamonds'});}
        const saved=await c.query("insert into creator_withdrawals(user_id,diamonds,payout_method,payout_account) values($1,$2,$3,$4) returning id,diamonds,status,created_at",[req.user.id,diamonds,method,account]);
        request=saved.rows[0]; await c.query('commit');
      } catch(e){await c.query('rollback').catch(()=>{});throw e;} finally{c.release();}
      res.status(201).json({ok:true,request,message:'Withdrawal request submitted. The actual ETB amount is confirmed before payout.'});
    } catch(e){console.error(e);res.status(500).json({error:'Could not submit withdrawal request'});}
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

  // ---------- admin v2: numbers, people, notices, prices ----------
  const DAY = "(now() at time zone 'Africa/Addis_Ababa')::date";
  const dayOf = (col) => `(${col} at time zone 'Africa/Addis_Ababa')::date`;

  app.get('/admin/stats', async (req, res) => {
    if (!adminOk(req, res)) return;
    try {
      const one = async (sql) => (await pool.query(sql)).rows[0];
      const users = await one(`select count(*)::int as total,
        count(*) filter (where ${dayOf('created_at')} = ${DAY})::int as today,
        count(*) filter (where created_at > now() - interval '7 days')::int as week,
        count(*) filter (where banned)::int as banned,
        coalesce(sum(coins),0)::int as coins_held from users`);
      const calls = await one(`select count(distinct reason)::int as calls, count(*)::int as minutes
        from coin_tx where reason like 'call:%' and amount < 0 and ${dayOf('created_at')} = ${DAY}`);
      const msgs = await one(`select count(*)::int as today from messages where ${dayOf('created_at')} = ${DAY}`);
      const sold = await one(`select count(*)::int as n, coalesce(sum(price_etb),0)::int as etb, coalesce(sum(coins),0)::int as coins,
        count(*) filter (where ${dayOf('decided_at')} = ${DAY})::int as n_today,
        coalesce(sum(price_etb) filter (where ${dayOf('decided_at')} = ${DAY}),0)::int as etb_today
        from purchases where status='approved'`);
      const pending = await one("select count(*)::int as n from purchases where status='pending'");
      const push_users = await one('select count(distinct user_id)::int as n from push_subs');
      const online = (await io.fetchSockets()).length;
      res.json({ users, calls, messages: msgs.today, sold, pending: pending.n, push_users: push_users.n, online });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/admin/users', async (req, res) => {
    if (!adminOk(req, res)) return;
    const q = String(req.query.q || '').replace(/[%_\\]/g, '').trim().slice(0, 30);
    const r = await pool.query(
      `select id, phone, name, coins, banned, created_at from users
       where $1 = '' or phone like '%' || $1 || '%' or lower(coalesce(name,'')) like '%' || lower($1) || '%'
       order by id desc limit 50`,
      [q]
    );
    res.json(r.rows);
  });

  app.post('/admin/ban', async (req, res) => {
    if (!adminOk(req, res)) return;
    try {
      const b = req.body || {};
      const u = await pool.query('select id from users where phone=$1', [normalizePhone(b.phone)]);
      if (!u.rowCount) return res.status(404).json({ error: 'User not found' });
      const id = u.rows[0].id;
      const ban = b.ban !== false;
      await pool.query('update users set banned=$2 where id=$1', [id, ban]);
      if (ban) {
        bannedIds.add(id);
        io.in('u' + id).disconnectSockets(true); // kick out right now
      } else bannedIds.delete(id);
      res.json({ ok: true, banned: ban });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // one message to every phone that allowed notifications (max one every 10 minutes)
  app.post('/admin/broadcast', async (req, res) => {
    if (!adminOk(req, res)) return;
    try {
      if (Date.now() - lastBroadcast < 600000)
        return res.status(429).json({ error: 'Wait 10 minutes between notices' });
      const title = String((req.body && req.body.title) || '').trim().slice(0, 60);
      const body = String((req.body && req.body.body) || '').trim().slice(0, 200);
      if (!title || !body) return res.status(400).json({ error: 'Write a title and a message' });
      lastBroadcast = Date.now();
      const r = await pool.query('select distinct user_id from push_subs');
      const ids = r.rows.map((x) => x.user_id).filter((id) => !bannedIds.has(id));
      for (let i = 0; i < ids.length; i += 20)
        await Promise.all(ids.slice(i, i + 20).map((id) => push.sendPush(id, { title, body, tag: 'notice' })));
      res.json({ ok: true, sent_to: ids.length });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---------- abuse report moderation queue ----------
  app.get('/admin/reports', async (req, res) => {
    if (!adminOk(req, res)) return;
    try {
      const status = ['pending', 'reviewed', 'actioned', 'dismissed'].includes(req.query.status) ? req.query.status : 'pending';
      const r = await pool.query(
        `select ar.id, ar.reason, ar.details, ar.status, ar.admin_note, ar.created_at, ar.reviewed_at,
                reporter.phone as reporter_phone, target.phone as target_phone, target.name as target_name,
                ar.message_id, left(m.body, 240) as message_excerpt
         from abuse_reports ar
         join users reporter on reporter.id=ar.reporter_id
         join users target on target.id=ar.target_id
         left join messages m on m.id=ar.message_id
         where ar.status=$1 order by ar.created_at desc limit 100`,
        [status]
      );
      res.json(r.rows);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/admin/report/decision', async (req, res) => {
    if (!adminOk(req, res)) return;
    try {
      const id = parseInt(req.body && req.body.id, 10);
      const status = String(req.body && req.body.status || '');
      const note = String(req.body && req.body.note || '').trim().slice(0, 500);
      if (!id || !['reviewed', 'actioned', 'dismissed'].includes(status))
        return res.status(400).json({ error: 'Choose a valid report decision' });
      const r = await pool.query(
        "update abuse_reports set status=$2, admin_note=$3, reviewed_at=now() where id=$1 and status='pending' returning id",
        [id, status, note || null]
      );
      if (!r.rowCount) return res.status(409).json({ error: 'Report already reviewed or not found' });
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/admin/creator-withdrawals', async(req,res)=>{
    if(!adminOk(req,res)) return;
    try {
      const status=['pending','approved','paid','rejected'].includes(req.query.status)?req.query.status:'pending';
      const r=await pool.query(`select w.id,w.user_id,w.diamonds,w.amount_etb,w.payout_method,w.payout_account,w.payout_reference,w.status,w.admin_note,w.created_at,u.name,u.phone from creator_withdrawals w join users u on u.id=w.user_id where w.status=$1 order by w.id asc limit 100`,[status]);
      res.json(r.rows);
    } catch(e){console.error(e);res.status(500).json({error:'Could not load withdrawal requests'});}
  });

  app.post('/admin/creator-withdrawal/decide',async(req,res)=>{
    if(!adminOk(req,res)) return;
    try {
      const id=Number(req.body?.id), action=String(req.body?.action||''), note=String(req.body?.note||'').slice(0,240);
      if(!Number.isSafeInteger(id)||id<1) return res.status(400).json({error:'Invalid request'});
      if(action==='reject'){
        const r=await pool.query("update creator_withdrawals set status='rejected',admin_note=$2,decided_at=now() where id=$1 and status='pending' returning id",[id,note]);
        return r.rowCount?res.json({ok:true}):res.status(409).json({error:'Request already decided'});
      }
      const amount=Number(req.body?.amount_etb), reference=String(req.body?.payout_reference||'').trim().slice(0,100);
      if(action!=='paid'||!Number.isFinite(amount)||amount<=0||amount>10000000||reference.length<5) return res.status(400).json({error:'Enter actual ETB amount and payout transaction reference after sending payment'});
      const r=await pool.query("update creator_withdrawals set status='paid',amount_etb=$2,payout_reference=$3,admin_note=$4,decided_at=now() where id=$1 and status='pending' returning id,user_id,diamonds,amount_etb,status",[id,amount,reference,note]);
      if(!r.rowCount) return res.status(409).json({error:'Request already decided'});
      io.to('u'+r.rows[0].user_id).emit('creator:withdrawal:update',{id,status:'paid',amount_etb:r.rows[0].amount_etb});
      res.json({ok:true,withdrawal:r.rows[0]});
    } catch(e){console.error(e);res.status(500).json({error:'Could not update withdrawal'});}
  });

  app.get('/admin/packages', async (req, res) => {
    if (!adminOk(req, res)) return;
    res.json((await pool.query('select id, name, coins, price_etb from packages order by id')).rows);
  });

  app.post('/admin/package', async (req, res) => {
    if (!adminOk(req, res)) return;
    try {
      const b = req.body || {};
      const id = parseInt(b.id, 10), coins = parseInt(b.coins, 10), price = parseInt(b.price_etb, 10);
      const name = String(b.name || '').trim().slice(0, 20);
      if (!id || !name || !(coins > 0 && coins <= 1000000) || !(price > 0 && price <= 1000000))
        return res.status(400).json({ error: 'Check name, coins and price' });
      const r = await pool.query('update packages set name=$2, coins=$3, price_etb=$4 where id=$1 returning id', [id, name, coins, price]);
      r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'No package' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return { init, isBanned: (id) => bannedIds.has(id), adminOk };
}

module.exports = { setupPayments };
