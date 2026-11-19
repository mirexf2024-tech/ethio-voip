// Group Live using LiveKit SFU. The LiveKit API secret stays on the server.
const crypto = require('crypto');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

function setupGroupLive(app, io, { pool, auth }) {
  const configured = () => !!(
    process.env.LIVEKIT_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  );
  const roomClient = () => {
    const url = String(process.env.LIVEKIT_URL || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    return new RoomServiceClient(url, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  };
  const fail = (res, status, error) => res.status(status).json({ error });
  const wrap = (fn) => async (req, res) => {
    try {
      if (!configured()) return fail(res, 503, 'Group Live is not configured yet');
      await fn(req, res);
    } catch (e) {
      console.error('Group Live error:', e.message);
      if (!res.headersSent) fail(res, 500, 'Group Live is temporarily unavailable');
    }
  };
  const groupId = (req) => {
    const id = Number.parseInt(req.params.id, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  };
  async function member(gid, uid) {
    const r = await pool.query(
      'select gm.role, g.name from group_members gm join groups g on g.id=gm.group_id where gm.group_id=$1 and gm.user_id=$2',
      [gid, uid]
    );
    return r.rows[0] || null;
  }
  async function currentLive(gid) {
    const r = await pool.query(
      "select * from group_lives where group_id=$1 and status='live' order by id desc limit 1",
      [gid]
    );
    return r.rows[0] || null;
  }
  async function makeToken(live, uid, role) {
    const active = role === 'host' || role === 'speaker';
    const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: String(uid),
      name: String(uid),
      ttl: '1h',
      metadata: JSON.stringify({ groupId: live.group_id, liveId: live.id, role })
    });
    token.addGrant({
      roomJoin: true,
      room: live.room_name,
      canPublish: active,
      canSubscribe: true,
      canPublishData: active
    });
    return token.toJwt();
  }
  async function participantState(live, uid) {
    const r = await pool.query(
      'select role from group_live_participants where live_id=$1 and user_id=$2',
      [live.id, uid]
    );
    return r.rows[0]?.role || 'audience';
  }

  async function init() {
    await pool.query(`
      create table if not exists group_lives (
        id bigserial primary key,
        group_id int not null references groups(id) on delete cascade,
        host_id int not null references users(id) on delete cascade,
        room_name text not null unique,
        status text not null default 'live' check (status in ('live','ended')),
        started_at timestamptz not null default now(),
        ended_at timestamptz
      );
      create unique index if not exists one_live_per_group
        on group_lives(group_id) where status='live';
      create table if not exists group_live_participants (
        live_id bigint not null references group_lives(id) on delete cascade,
        user_id int not null references users(id) on delete cascade,
        role text not null default 'audience' check (role in ('host','speaker','audience')),
        joined_at timestamptz not null default now(),
        primary key(live_id,user_id)
      );
      create index if not exists group_live_participants_role_idx
        on group_live_participants(live_id,role);
      create table if not exists group_live_removed (
        live_id bigint not null references group_lives(id) on delete cascade,
        user_id int not null references users(id) on delete cascade,
        removed_by int references users(id) on delete set null,
        created_at timestamptz not null default now(),
        primary key(live_id,user_id)
      );
      create table if not exists live_gift_catalog (
        code text primary key,
        title text not null,
        emoji text not null,
        coin_cost int not null check (coin_cost > 0),
        active boolean not null default true,
        sort_order int not null default 0
      );
      create table if not exists live_gifts (
        id bigserial primary key,
        live_id bigint not null references group_lives(id) on delete cascade,
        group_id int not null references groups(id) on delete cascade,
        sender_id int not null references users(id) on delete cascade,
        receiver_id int not null references users(id) on delete cascade,
        gift_code text not null references live_gift_catalog(code),
        quantity int not null check (quantity between 1 and 20),
        total_coins int not null check (total_coins > 0),
        created_at timestamptz not null default now(),
        check (sender_id <> receiver_id)
      );
      create index if not exists live_gifts_live_recent_idx on live_gifts(live_id,created_at desc);
      create table if not exists creator_earnings (
        id bigserial primary key,
        user_id int not null references users(id) on delete cascade,
        diamonds bigint not null check (diamonds > 0),
        source text not null,
        source_id bigint not null,
        created_at timestamptz not null default now(),
        unique(source,source_id)
      );
      create index if not exists creator_earnings_user_idx on creator_earnings(user_id,created_at desc);
      insert into live_gift_catalog(code,title,emoji,coin_cost,sort_order) values
        ('heart','Heart','💛',1,1),
        ('coffee','Coffee','☕',5,2),
        ('flower','Flower','🌻',10,3),
        ('crown','Crown','👑',25,4),
        ('diamond','Diamond','💎',50,5)
      on conflict(code) do nothing;
    `);
  }

  // Owner/admin starts a room. Host occupies one of the eight speaker slots.
  app.post('/groups/:id/live/start', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    const me = gid ? await member(gid, req.user.id) : null;
    if (!me) return fail(res, 404, 'Group not found');
    if (!['owner','admin'].includes(me.role)) return fail(res, 403, 'Only a group owner or admin can start a live');
    const existing = await currentLive(gid);
    if (existing) return fail(res, 409, 'A live is already running in this group');
    const roomName = 'ecg-' + gid + '-' + crypto.randomBytes(8).toString('hex');
    const client = roomClient();
    await client.createRoom({ name: roomName, emptyTimeout: 60, maxParticipants: 500 });
    let live;
    const db = await pool.connect();
    try {
      await db.query('begin');
      const r = await db.query(
        "insert into group_lives(group_id,host_id,room_name,status) values($1,$2,$3,'live') returning *",
        [gid, req.user.id, roomName]
      );
      live = r.rows[0];
      await db.query(
        "insert into group_live_participants(live_id,user_id,role) values($1,$2,'host')",
        [live.id, req.user.id]
      );
      await db.query('commit');
    } catch (e) {
      await db.query('rollback').catch(() => {});
      await client.deleteRoom(roomName).catch(() => {});
      if (e.code === '23505') return fail(res, 409, 'A live is already running in this group');
      throw e;
    } finally {
      db.release();
    }
    io.in('u'+req.user.id).socketsJoin('gl'+live.id);
    res.status(201).json({
      live: { id: live.id, group_id: gid, room_name: roomName, host_id: req.user.id, status: 'live' },
      token: await makeToken(live, req.user.id, 'host'),
      livekit_url: process.env.LIVEKIT_URL,
      role: 'host',
      speaker_limit: 8
    });
  }));

  // Group members receive audience-only credentials by default.
  app.post('/groups/:id/live/token', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    const me = gid ? await member(gid, req.user.id) : null;
    if (!me) return fail(res, 404, 'Group not found');
    const live = await currentLive(gid);
    if (!live) return fail(res, 404, 'No live is running in this group');
    const removed = await pool.query('select 1 from group_live_removed where live_id=$1 and user_id=$2',[live.id,req.user.id]);
    if (removed.rowCount) return fail(res,403,'You were removed from this live');
    await pool.query(
      "insert into group_live_participants(live_id,user_id,role) values($1,$2,'audience') on conflict(live_id,user_id) do nothing",
      [live.id,req.user.id]
    );
    const role = await participantState(live, req.user.id);
    io.in('u'+req.user.id).socketsJoin('gl'+live.id);
    io.to('gl'+live.id).emit('live:participants-changed',{group_id:gid});
    res.json({
      live: { id: live.id, group_id: gid, host_id: live.host_id, status: live.status },
      token: await makeToken(live, req.user.id, role),
      livekit_url: process.env.LIVEKIT_URL,
      role,
      can_publish: role === 'host' || role === 'speaker',
      speaker_limit: 8
    });
  }));

  // Only the host can promote an audience member; max eight publishers including host.
  app.post('/groups/:id/live/promote', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    const live = gid ? await currentLive(gid) : null;
    if (!live) return fail(res, 404, 'No live is running in this group');
    if (live.host_id !== req.user.id) return fail(res, 403, 'Only the live host can invite speakers');
    const targetId = Number.parseInt(req.body?.user_id, 10);
    if (!Number.isSafeInteger(targetId) || targetId < 1 || targetId === live.host_id)
      return fail(res, 400, 'Invalid participant');
    if (!(await member(gid, targetId))) return fail(res, 404, 'Participant is not a member of this group');
    const previousRole = await participantState(live, targetId);
    if (previousRole === 'speaker') return res.json({ ok: true, user_id: targetId, role: 'speaker', already_speaker: true });
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock($1)', [gid]);
      const active = await c.query(
        "select count(*)::int as n from group_live_participants where live_id=$1 and role in ('host','speaker')",
        [live.id]
      );
      if (active.rows[0].n >= 8) {
        await c.query('rollback');
        return fail(res, 409, 'All eight speaker slots are occupied');
      }
      await c.query(
        "insert into group_live_participants(live_id,user_id,role) values($1,$2,'speaker') on conflict(live_id,user_id) do update set role='speaker',joined_at=now()",
        [live.id, targetId]
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally { c.release(); }
    io.to('u'+targetId).emit('live:role-changed',{group_id:gid,live_id:live.id,role:'speaker'});
    res.json({ ok: true, user_id: targetId, role: 'speaker', message: 'Participant promoted.' });
  }));

  // Host can remove a speaker or audience member from the LiveKit room.
  app.post('/groups/:id/live/remove', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    const live = gid ? await currentLive(gid) : null;
    if (!live) return fail(res, 404, 'No live is running in this group');
    const actor = await member(gid,req.user.id);
    if (live.host_id !== req.user.id && !['owner','admin','mod'].includes(actor?.role))
      return fail(res,403,'Only the host or a group moderator can remove participants');
    const targetId = Number.parseInt(req.body?.user_id, 10);
    if (!Number.isSafeInteger(targetId) || targetId < 1 || targetId === live.host_id)
      return fail(res, 400, 'Invalid participant');
    await pool.query('delete from group_live_participants where live_id=$1 and user_id=$2', [live.id, targetId]);
    await pool.query('insert into group_live_removed(live_id,user_id,removed_by) values($1,$2,$3) on conflict(live_id,user_id) do update set removed_by=excluded.removed_by,created_at=now()', [live.id,targetId,req.user.id]);
    await roomClient().removeParticipant(live.room_name, String(targetId)).catch((e) => {
      if (!/not found|participant/i.test(e.message)) throw e;
    });
    io.to('u'+targetId).emit('live:removed',{group_id:gid,live_id:live.id});
    io.to('gl'+live.id).emit('live:participants-changed',{group_id:gid});
    res.json({ ok: true, user_id: targetId });
  }));

  // Host ends the room for everyone; no coin billing is attached to Group Live.
  app.post('/groups/:id/live/end', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    const live = gid ? await currentLive(gid) : null;
    if (!live) return fail(res, 404, 'No live is running in this group');
    if (live.host_id !== req.user.id) return fail(res, 403, 'Only the live host can end this live');
    await pool.query("update group_lives set status='ended',ended_at=now() where id=$1", [live.id]);
    await roomClient().deleteRoom(live.room_name).catch((e) => console.error('LiveKit room cleanup:', e.message));
    io.to('gl'+live.id).emit('live:ended',{group_id:gid,live_id:live.id});
    res.json({ ok: true, ended: true });
  }));

  // Available gifts for a live room. Costs are fixed server-side; clients cannot choose a price.
  app.get('/groups/:id/live/gifts', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    if (!gid || !(await member(gid, req.user.id))) return fail(res, 404, 'Group not found');
    const r = await pool.query('select code,title,emoji,coin_cost from live_gift_catalog where active=true order by sort_order,code');
    res.json({ gifts: r.rows });
  }));

  // Transfer coins atomically between sender and live host/participant and broadcast the gift.
  app.post('/groups/:id/live/gift', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    const me = gid ? await member(gid, req.user.id) : null;
    if (!me) return fail(res, 404, 'Group not found');
    const live = await currentLive(gid);
    if (!live) return fail(res, 404, 'No live is running in this group');
    const targetId = Number.parseInt(req.body?.to_user_id, 10);
    const code = String(req.body?.gift_code || '').trim().toLowerCase();
    const quantity = Number.parseInt(req.body?.quantity ?? 1, 10);
    if (!Number.isSafeInteger(targetId) || targetId < 1 || targetId === req.user.id)
      return fail(res, 400, 'Choose a valid recipient');
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20)
      return fail(res, 400, 'Gift quantity must be between 1 and 20');
    const recipient = await pool.query(
      'select u.id,u.name from users u join group_live_participants p on p.user_id=u.id where p.live_id=$1 and u.id=$2',
      [live.id, targetId]
    );
    if (!recipient.rowCount) return fail(res, 404, 'Recipient is not in this live');
    const gift = await pool.query('select code,title,emoji,coin_cost from live_gift_catalog where code=$1 and active=true', [code]);
    if (!gift.rowCount) return fail(res, 400, 'Gift is unavailable');
    const item = gift.rows[0];
    const total = item.coin_cost * quantity;
    if (!Number.isSafeInteger(total) || total > 1000) return fail(res, 400, 'Gift total is too large');
    const client = await pool.connect();
    let senderBalance = 0, giftRow;
    try {
      await client.query('begin');
      const recent = await client.query(
        "select count(*)::int as n from live_gifts where sender_id=$1 and created_at > now() - interval '1 minute'",
        [req.user.id]
      );
      if (recent.rows[0].n >= 10) {
        await client.query('rollback');
        return fail(res, 429, 'Please wait before sending another gift');
      }
      const locked = await client.query('select id,coins from users where id=$1 for update', [req.user.id]);
      if (!locked.rowCount) {
        await client.query('rollback');
        return fail(res, 404, 'Sender account not found');
      }
      const sender = locked.rows[0];
      if (sender.coins < total) {
        await client.query('rollback');
        return fail(res, 402, 'Not enough coins');
      }
      senderBalance = sender.coins - total;
      await client.query('update users set coins=$2 where id=$1', [req.user.id,senderBalance]);
      await client.query(
        'insert into coin_tx(user_id,amount,balance_after,reason) values($1,$2,$3,$4)',
        [req.user.id,-total,senderBalance,'live gift to '+targetId]
      );
      const saved = await client.query(
        'insert into live_gifts(live_id,group_id,sender_id,receiver_id,gift_code,quantity,total_coins) values($1,$2,$3,$4,$5,$6,$7) returning id,created_at',
        [live.id,gid,req.user.id,targetId,code,quantity,total]
      );
      giftRow = saved.rows[0];
      // Diamonds are creator reward points, separate from spendable Coins and ETB.
      await client.query(
        "insert into creator_earnings(user_id,diamonds,source,source_id) values($1,$2,'live_gift',$3) on conflict(source,source_id) do nothing",
        [targetId,total,giftRow.id]
      );
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally { client.release(); }
    const payload = {
      id: giftRow.id, live_id: live.id, group_id: gid,
      sender_id: req.user.id, receiver_id: targetId,
      sender_name: req.user.name || 'Member',
      receiver_name: recipient.rows[0].name || 'Member',
      gift_code: item.code, title: item.title, emoji: item.emoji,
      quantity, total_coins: total, created_at: giftRow.created_at
    };
    io.to('u'+req.user.id).emit('wallet:update',{coins:senderBalance,added:-total});
    io.to('u'+targetId).emit('creator:earnings:update',{diamonds_added:total,source:'live_gift'});
    io.to('gl'+live.id).emit('live:gift',payload);
    res.status(201).json({ok:true,gift:payload,coins:senderBalance});
  }));

  app.get('/groups/:id/live/history', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    if (!gid || !(await member(gid,req.user.id))) return fail(res,404,'Group not found');
    const live = await currentLive(gid);
    if (!live) return res.json({gifts:[]});
    const r = await pool.query(
      'select id,sender_id,receiver_id,gift_code,quantity,total_coins,created_at from live_gifts where live_id=$1 order by id desc limit 50',
      [live.id]
    );
    res.json({gifts:r.rows});
  }));

  // Participant roster for the in-app live room.
  app.get('/groups/:id/live/participants', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    if (!gid || !(await member(gid, req.user.id))) return fail(res, 404, 'Group not found');
    const live = await currentLive(gid);
    if (!live) return res.json({ participants: [] });
    const active = await roomClient().listParticipants(live.room_name);
    const ids = active.map((p) => Number(p.identity)).filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) return res.json({ participants: [], host_id: live.host_id, speaker_limit: 8 });
    const r = await pool.query(
      'select p.user_id,u.name,u.phone,p.role,p.joined_at from group_live_participants p join users u on u.id=p.user_id where p.live_id=$1 and p.user_id=any($2::int[]) order by case p.role when \'host\' then 0 when \'speaker\' then 1 else 2 end,p.joined_at',
      [live.id, ids]
    );
    res.json({ participants: r.rows, host_id: live.host_id, speaker_limit: 8 });
  }));

  // Leave the room without ending the live for all other group members.
  app.post('/groups/:id/live/leave', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    if (!gid || !(await member(gid, req.user.id))) return fail(res, 404, 'Group not found');
    const live = await currentLive(gid);
    if (!live) return res.json({ ok: true });
    if (live.host_id === req.user.id) return fail(res, 400, 'The host must end the live for everyone');
    await pool.query('delete from group_live_participants where live_id=$1 and user_id=$2', [live.id, req.user.id]);
    await roomClient().removeParticipant(live.room_name, String(req.user.id)).catch((e) => {
      if (!/not found|participant/i.test(e.message)) throw e;
    });
    io.to('gl'+live.id).emit('live:participants-changed',{group_id:gid});
    res.json({ ok: true });
  }));

  app.get('/groups/:id/live', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    const me = gid ? await member(gid, req.user.id) : null;
    if (!me) return fail(res, 404, 'Group not found');
    const live = await currentLive(gid);
    if (!live) return res.json({ live: null });
    let speakers = 0, audience = 0;
    try {
      const list = await roomClient().listParticipants(live.room_name);
      speakers = list.filter(p => {
        try { const m = JSON.parse(p.metadata || '{}'); return m.role === 'host' || m.role === 'speaker'; } catch (_) { return false; }
      }).length;
      audience = Math.max(0, list.length - speakers);
    } catch (e) { console.warn('LiveKit participant count unavailable:', e.message); }
    res.json({ live: { id: live.id, group_id: gid, host_id: live.host_id, status: live.status, started_at: live.started_at }, speakers, audience, speaker_limit: 8 });
  }));
  return { init };
}

module.exports = { setupGroupLive };
