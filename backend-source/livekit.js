// Group Live using LiveKit SFU. The LiveKit API secret stays on the server.
const crypto = require('crypto');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

function setupGroupLive(app, { pool, auth }) {
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
    try {
      const r = await pool.query(
        "insert into group_lives(group_id,host_id,room_name,status) values($1,$2,$3,'live') returning *",
        [gid, req.user.id, roomName]
      );
      live = r.rows[0];
      await pool.query(
        "insert into group_live_participants(live_id,user_id,role) values($1,$2,'host')",
        [live.id, req.user.id]
      );
    } catch (e) {
      await client.deleteRoom(roomName).catch(() => {});
      if (e.code === '23505') return fail(res, 409, 'A live is already running in this group');
      throw e;
    }
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
    const role = await participantState(live, req.user.id);
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
    if (!Number.isSafeInteger(targetId) || targetId < 1) return fail(res, 400, 'Invalid participant');
    if (!(await member(gid, targetId))) return fail(res, 404, 'Participant is not a member of this group');
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
    res.json({ ok: true, user_id: targetId, role: 'speaker', message: 'Participant promoted. They must refresh their live connection to publish.' });
  }));

  // Host can remove a speaker or audience member from the LiveKit room.
  app.post('/groups/:id/live/remove', auth, wrap(async (req, res) => {
    const gid = groupId(req);
    const live = gid ? await currentLive(gid) : null;
    if (!live) return fail(res, 404, 'No live is running in this group');
    if (live.host_id !== req.user.id) return fail(res, 403, 'Only the live host can remove participants');
    const targetId = Number.parseInt(req.body?.user_id, 10);
    if (!Number.isSafeInteger(targetId) || targetId < 1 || targetId === live.host_id)
      return fail(res, 400, 'Invalid participant');
    await pool.query('delete from group_live_participants where live_id=$1 and user_id=$2', [live.id, targetId]);
    await roomClient().removeParticipant(live.room_name, String(targetId)).catch((e) => {
      if (!/not found|participant/i.test(e.message)) throw e;
    });
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
    res.json({ ok: true, ended: true });
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
