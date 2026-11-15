// Group chat: text, photos, voice notes, files. Up to MAX_MEMBERS people in one group.
// The person who makes the group is the owner (can add and remove people). Anyone can leave.
const MAX_DATA = 1500000; // same limit as 1-to-1 chat (about 1 MB file)
const KINDS = ['text', 'image', 'voice', 'file'];
const MAX_MEMBERS = parseInt(process.env.GROUP_MAX_MEMBERS || '50', 10);
const MAX_OWNED = parseInt(process.env.GROUP_MAX_OWNED || '10', 10); // groups one person can make
const SAFE_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a',
];

function setupGroups(app, io, { pool, auth, normalizePhone, push }) {
  const room = (gid) => 'g' + gid;
  const uroom = (uid) => 'u' + uid;
  const sent = new Map(); // userId -> timestamps (rate limit)

  function rateOk(uid) {
    const now = Date.now();
    const a = (sent.get(uid) || []).filter((t) => now - t < 60000);
    if (a.length >= 30) return false;
    a.push(now);
    sent.set(uid, a);
    return true;
  }

  async function init() {
    await pool.query(`
      create table if not exists groups(
        id serial primary key,
        name text not null,
        owner_id int references users(id) on delete set null,
        created_at timestamptz default now()
      );
      create table if not exists group_members(
        group_id int not null references groups(id) on delete cascade,
        user_id int not null references users(id) on delete cascade,
        last_read_id int not null default 0,
        joined_at timestamptz default now(),
        primary key (group_id, user_id)
      );
      create index if not exists group_members_user_idx on group_members(user_id);
      create table if not exists group_messages(
        id serial primary key,
        group_id int not null references groups(id) on delete cascade,
        from_id int references users(id) on delete cascade,
        kind text not null default 'text',
        body text,
        media_url text,
        media_name text,
        media_size int,
        duration int,
        created_at timestamptz default now()
      );
      create index if not exists group_messages_idx on group_messages(group_id, id);`);
  }

  async function member(gid, uid) {
    const r = await pool.query(
      `select g.id, g.name, g.owner_id from group_members m join groups g on g.id=m.group_id
       where m.group_id=$1 and m.user_id=$2`,
      [gid, uid]
    );
    return r.rows[0] || null;
  }

  async function memberCount(gid) {
    const r = await pool.query('select count(*)::int as n from group_members where group_id=$1', [gid]);
    return r.rows[0].n;
  }

  async function blockedBetween(a, b) {
    const r = await pool.query(
      'select 1 from blocks where (user_id=$1 and blocked_id=$2) or (user_id=$2 and blocked_id=$1)',
      [a, b]
    );
    return r.rowCount > 0;
  }

  // every connected phone joins the rooms of its groups
  io.on('connection', async (socket) => {
    try {
      const r = await pool.query('select group_id from group_members where user_id=$1', [socket.user.id]);
      r.rows.forEach((x) => socket.join(room(x.group_id)));
    } catch (e) {
      console.error(e);
    }
  });

  // ---- my groups ----
  app.get('/groups', auth, async (req, res) => {
    try {
      const r = await pool.query(
        `select g.id, g.name,
           (select count(*) from group_members m2 where m2.group_id=g.id)::int as members,
           l.kind, l.body, l.media_name, l.created_at as last_at, lu.name as last_name, lu.phone as last_phone,
           (select count(*) from group_messages x
              where x.group_id=g.id and x.id > gm.last_read_id and x.from_id is distinct from $1)::int as unread
         from group_members gm
         join groups g on g.id = gm.group_id
         left join lateral (select * from group_messages where group_id=g.id order by id desc limit 1) l on true
         left join users lu on lu.id = l.from_id
         where gm.user_id=$1
         order by coalesce(l.created_at, g.created_at) desc`,
        [req.user.id]
      );
      res.json(r.rows);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- make a group ----
  app.post('/groups', auth, async (req, res) => {
    const c = await pool.connect();
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) return res.status(400).json({ error: 'Write a group name' });
      const phones = Array.isArray(b.phones) ? b.phones.slice(0, MAX_MEMBERS * 2) : [];
      const owned = await pool.query('select count(*)::int as n from groups where owner_id=$1', [req.user.id]);
      if (owned.rows[0].n >= MAX_OWNED) return res.status(429).json({ error: `You can make ${MAX_OWNED} groups` });

      const wanted = [...new Set(phones.map((p) => normalizePhone(String(p))).filter(Boolean))];
      const found = wanted.length
        ? (await pool.query('select id, phone from users where phone = any($1::text[]) and id <> $2', [wanted, req.user.id])).rows
        : [];
      const foundPhones = new Set(found.map((x) => x.phone));
      const missing = wanted.filter((p) => !foundPhones.has(p) && p !== req.user.phone);
      const people = [];
      for (const u of found) {
        if (people.length >= MAX_MEMBERS - 1) break;
        if (!(await blockedBetween(req.user.id, u.id))) people.push(u);
      }

      await c.query('begin');
      const g = await c.query('insert into groups(name, owner_id) values($1,$2) returning id', [name, req.user.id]);
      const gid = g.rows[0].id;
      await c.query('insert into group_members(group_id, user_id) values($1,$2)', [gid, req.user.id]);
      for (const u of people) await c.query('insert into group_members(group_id, user_id) values($1,$2)', [gid, u.id]);
      await c.query('commit');

      io.in(uroom(req.user.id)).socketsJoin(room(gid));
      for (const u of people) {
        io.in(uroom(u.id)).socketsJoin(room(gid));
        io.to(uroom(u.id)).emit('group:new', { id: gid, name });
      }
      res.json({ ok: true, id: gid, added: people.length, missing });
    } catch (e) {
      await c.query('rollback').catch(() => {});
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    } finally {
      c.release();
    }
  });

  // ---- open a group: people + last 100 messages (also marks everything as read) ----
  app.get('/groups/:id', auth, async (req, res) => {
    try {
      const gid = parseInt(req.params.id, 10);
      if (!gid) return res.status(400).json({ error: 'Bad id' });
      const g = await member(gid, req.user.id);
      if (!g) return res.status(404).json({ error: 'Group not found' });
      const ppl = await pool.query(
        `select u.phone, u.name, u.avatar_url, (u.id = $2) as owner
         from group_members m join users u on u.id=m.user_id
         where m.group_id=$1 order by m.joined_at, u.id`,
        [gid, g.owner_id]
      );
      const m = await pool.query(
        `select m.id, (m.from_id=$2) as mine, u.phone as from_phone, u.name as from_name,
                m.kind, m.body, m.media_name, m.media_size, m.duration,
                (m.media_url is not null) as has_media, m.created_at
         from group_messages m left join users u on u.id=m.from_id
         where m.group_id=$1 order by m.id desc limit 100`,
        [gid, req.user.id]
      );
      await pool.query(
        `update group_members set last_read_id = coalesce((select max(id) from group_messages where group_id=$1), 0)
         where group_id=$1 and user_id=$2`,
        [gid, req.user.id]
      );
      res.json({
        group: { id: gid, name: g.name, is_owner: g.owner_id === req.user.id, members: ppl.rows },
        messages: m.rows.reverse(),
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // the open screen tells us it has seen new messages
  app.post('/groups/:id/read', auth, async (req, res) => {
    try {
      const gid = parseInt(req.params.id, 10);
      if (!gid) return res.status(400).json({ error: 'Bad id' });
      await pool.query(
        `update group_members set last_read_id = coalesce((select max(id) from group_messages where group_id=$1), 0)
         where group_id=$1 and user_id=$2`,
        [gid, req.user.id]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- send a message to the group ----
  app.post('/groups/:id/send', auth, async (req, res) => {
    try {
      const gid = parseInt(req.params.id, 10);
      if (!gid) return res.status(400).json({ error: 'Bad id' });
      const g = await member(gid, req.user.id);
      if (!g) return res.status(404).json({ error: 'Group not found' });
      if (!rateOk(req.user.id)) return res.status(429).json({ error: 'Too many messages, wait a minute' });

      const b = req.body || {};
      const kind = KINDS.includes(b.kind) ? b.kind : 'text';
      let body = null, data = null, name = null, size = null, duration = null;
      if (kind === 'text') {
        body = String(b.body || '').trim().slice(0, 2000);
        if (!body) return res.status(400).json({ error: 'Empty message' });
      } else {
        data = String(b.data || '');
        if (!data.startsWith('data:') || data.length > MAX_DATA)
          return res.status(400).json({ error: 'File too large (max 1 MB)' });
        name = b.name ? String(b.name).slice(0, 100) : null;
        size = Math.min(parseInt(b.size, 10) || 0, 2000000);
        duration = kind === 'voice' ? Math.min(parseInt(b.duration, 10) || 0, 300) : null;
      }

      const r = await pool.query(
        `insert into group_messages(group_id, from_id, kind, body, media_url, media_name, media_size, duration)
         values($1,$2,$3,$4,$5,$6,$7,$8)
         returning id, kind, body, media_name, media_size, duration, created_at`,
        [gid, req.user.id, kind, body, data, name, size, duration]
      );
      const msg = { ...r.rows[0], has_media: kind !== 'text' };
      // my own read mark moves forward, so my messages never count as unread for me
      await pool.query('update group_members set last_read_id=$3 where group_id=$1 and user_id=$2 and last_read_id < $3', [
        gid, req.user.id, msg.id,
      ]);
      const me = await pool.query('select name from users where id=$1', [req.user.id]);
      const fromName = me.rows[0] ? me.rows[0].name : null;

      // everybody in the group except me (my other tabs are not needed: one device per account)
      io.to(room(gid)).except(uroom(req.user.id)).emit('gmsg:new', {
        ...msg,
        group_id: gid,
        from_phone: req.user.phone,
        from_name: fromName,
      });

      // members whose app is closed get a push notification
      (async () => {
        try {
          const ids = (await pool.query('select user_id from group_members where group_id=$1 and user_id <> $2', [gid, req.user.id])).rows.map((x) => x.user_id);
          const preview =
            kind === 'text' ? body.slice(0, 100)
            : kind === 'image' ? '📷 Photo'
            : kind === 'voice' ? '🎤 Voice message'
            : '📎 ' + (name || 'File');
          const who = fromName || req.user.phone;
          for (let i = 0; i < ids.length; i += 10) {
            await Promise.all(ids.slice(i, i + 10).map(async (id) => {
              const socks = await io.in(uroom(id)).fetchSockets();
              if (!socks.length) push.sendPush(id, { title: g.name, body: who + ': ' + preview, tag: 'grp-' + gid });
            }));
          }
        } catch (e) { console.error(e); }
      })();

      res.json({ ok: true, msg });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- photo / voice note / file of one group message (members only) ----
  app.get('/groups/media/:id', auth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Bad id' });
      const r = await pool.query(
        `select m.media_url from group_messages m
         join group_members gm on gm.group_id=m.group_id and gm.user_id=$2
         where m.id=$1 and m.media_url is not null`,
        [id, req.user.id]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
      const url = r.rows[0].media_url;
      const i = url.indexOf(',');
      const head = url.slice(5, i);
      const payload = url.slice(i + 1);
      const buf = head.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload));
      const mime = head.split(';')[0];
      res.set({
        'Content-Type': SAFE_MIME.includes(mime) ? mime : 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000',
      });
      res.send(buf);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- add a person (owner only; if the group has no owner any member can) ----
  app.post('/groups/:id/add', auth, async (req, res) => {
    try {
      const gid = parseInt(req.params.id, 10);
      const g = gid ? await member(gid, req.user.id) : null;
      if (!g) return res.status(404).json({ error: 'Group not found' });
      if (g.owner_id && g.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the group owner can add people' });
      const p = await pool.query('select id, phone, name from users where phone=$1', [normalizePhone(req.body && req.body.phone)]);
      if (!p.rowCount) return res.status(404).json({ error: 'User not found' });
      const u = p.rows[0];
      if (await blockedBetween(req.user.id, u.id)) return res.status(404).json({ error: 'User not found' });
      if ((await memberCount(gid)) >= MAX_MEMBERS) return res.status(400).json({ error: `A group can have ${MAX_MEMBERS} people` });
      const ins = await pool.query(
        'insert into group_members(group_id, user_id, last_read_id) values($1,$2, coalesce((select max(id) from group_messages where group_id=$1),0)) on conflict do nothing returning user_id',
        [gid, u.id]
      );
      if (!ins.rowCount) return res.status(409).json({ error: 'Already in the group' });
      io.in(uroom(u.id)).socketsJoin(room(gid));
      io.to(uroom(u.id)).emit('group:new', { id: gid, name: g.name });
      io.to(room(gid)).emit('group:update', { id: gid });
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- remove a person (owner only) ----
  app.post('/groups/:id/remove', auth, async (req, res) => {
    try {
      const gid = parseInt(req.params.id, 10);
      const g = gid ? await member(gid, req.user.id) : null;
      if (!g) return res.status(404).json({ error: 'Group not found' });
      if (g.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the group owner can remove people' });
      const p = await pool.query('select id from users where phone=$1', [normalizePhone(req.body && req.body.phone)]);
      if (!p.rowCount || p.rows[0].id === req.user.id) return res.status(404).json({ error: 'User not found' });
      const del = await pool.query('delete from group_members where group_id=$1 and user_id=$2 returning user_id', [gid, p.rows[0].id]);
      if (!del.rowCount) return res.status(404).json({ error: 'Not in the group' });
      io.in(uroom(p.rows[0].id)).socketsLeave(room(gid));
      io.to(uroom(p.rows[0].id)).emit('group:gone', { id: gid });
      io.to(room(gid)).emit('group:update', { id: gid });
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- leave the group (if the owner leaves, the person who joined first becomes owner) ----
  app.post('/groups/:id/leave', auth, async (req, res) => {
    try {
      const gid = parseInt(req.params.id, 10);
      const g = gid ? await member(gid, req.user.id) : null;
      if (!g) return res.status(404).json({ error: 'Group not found' });
      await pool.query('delete from group_members where group_id=$1 and user_id=$2', [gid, req.user.id]);
      io.in(uroom(req.user.id)).socketsLeave(room(gid));
      const left = await pool.query('select user_id from group_members where group_id=$1 order by joined_at, user_id limit 1', [gid]);
      if (!left.rowCount) {
        await pool.query('delete from groups where id=$1', [gid]); // empty group: remove it with its messages
      } else {
        if (g.owner_id === req.user.id) await pool.query('update groups set owner_id=$2 where id=$1', [gid, left.rows[0].user_id]);
        io.to(room(gid)).emit('group:update', { id: gid });
      }
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return { init };
}

module.exports = { setupGroups };
