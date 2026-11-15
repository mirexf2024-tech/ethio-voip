// Group chat like Telegram: public groups (username, search, anyone can join) and private groups
// (invite link only). Roles: owner > admin > moderator > member.
//
//   owner      everything: promote/demote admins, change group type/username, make someone owner, delete group
//   admin      edit group info + settings, add people, invite link, join requests, ban/unban,
//              promote/demote moderators, + moderator powers
//   moderator  delete members' messages, mute/unmute, remove (kick) members, pin; not limited by slow mode / permissions
//   member     read and write (unless muted or the group limits it)
//
// Nobody can act on a person of the same or higher rank.
// Messages: reply, edit, delete, reactions, pin, search, forward label, mentions, polls, "typing...".
// Group settings: slow mode, who can write / send media / make polls, join requests (admin approves).
const crypto = require('crypto');

const MAX_DATA = 1500000; // same limit as 1-to-1 chat (about 1 MB file)
const KINDS = ['text', 'image', 'voice', 'file'];
const MAX_MEMBERS = parseInt(process.env.GROUP_MAX_MEMBERS || '50', 10);
const MAX_OWNED = parseInt(process.env.GROUP_MAX_OWNED || '10', 10); // groups one person can make
const EDIT_HOURS = parseInt(process.env.MSG_EDIT_HOURS || '48', 10); // how long a text message can be edited
const SAFE_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a',
];
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const SLOW_CHOICES = [0, 10, 30, 60, 300, 900, 3600]; // seconds
const RANK = { owner: 4, admin: 3, mod: 2, member: 1 };
const rk = (role) => RANK[role] || 0;
const USERNAME = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/; // 5 to 32 letters, numbers or _
const newToken = () => crypto.randomBytes(12).toString('base64url');
const FOREVER_DAYS = 36500;

// one group message as the person with id $2 sees it (group id is $1)
const GSEL = `m.id, (m.from_id=$2) as mine, u.phone as from_phone, u.name as from_name,
  m.kind, m.body, m.media_name, m.media_size, m.duration, (m.media_url is not null) as has_media, m.created_at,
  m.edited_at, m.fwd_from, m.reply_to,
  r.kind as reply_kind, left(r.body, 100) as reply_body, r.media_name as reply_media_name, ru.name as reply_name, ru.phone as reply_phone,
  coalesce((select json_agg(json_build_object('e', x.emoji, 'p', xu.phone)) from group_msg_reactions x join users xu on xu.id=x.user_id where x.msg_id=m.id), '[]'::json) as reactions,
  coalesce((select json_agg(mu.phone) from users mu where mu.id = any(m.mentions)), '[]'::json) as mentions,
  (select json_build_object('id', p.id, 'multi', p.multi, 'closed', p.closed,
     'options', (select json_agg(json_build_object('t', o.text, 'n', (select count(*) from group_poll_votes v where v.poll_id=p.id and v.option_idx=o.idx)) order by o.idx) from group_poll_options o where o.poll_id=p.id),
     'mine', coalesce((select json_agg(v.option_idx) from group_poll_votes v where v.poll_id=p.id and v.user_id=$2), '[]'::json),
     'total', (select count(distinct v.user_id) from group_poll_votes v where v.poll_id=p.id))
   from group_polls p where p.message_id=m.id) as poll`;
const GFROM = `from group_messages m left join users u on u.id=m.from_id
  left join group_messages r on r.id=m.reply_to left join users ru on ru.id=r.from_id`;

function setupGroups(app, io, { pool, auth, normalizePhone, push }) {
  const room = (gid) => 'g' + gid;
  const uroom = (uid) => 'u' + uid;
  const sent = new Map();    // userId -> timestamps (message rate limit)
  const looked = new Map();  // userId -> timestamps (search rate limit)
  const typedAt = new Map(); // userId -> last "typing" time

  const within = (map, uid, max) => {
    const now = Date.now();
    const a = (map.get(uid) || []).filter((t) => now - t < 60000);
    if (a.length >= max) return false;
    a.push(now);
    map.set(uid, a);
    return true;
  };

  async function init() {
    await pool.query(`
      create table if not exists groups(
        id serial primary key,
        name text not null,
        owner_id int references users(id) on delete set null,
        created_at timestamptz default now()
      );
      alter table groups add column if not exists description text;
      alter table groups add column if not exists avatar_url text;
      alter table groups add column if not exists is_public boolean not null default false;
      alter table groups add column if not exists username text;
      alter table groups add column if not exists invite_token text;
      alter table groups add column if not exists slow_seconds int not null default 0;
      alter table groups add column if not exists can_write boolean not null default true;
      alter table groups add column if not exists can_media boolean not null default true;
      alter table groups add column if not exists can_poll boolean not null default true;
      alter table groups add column if not exists join_approval boolean not null default false;
      create unique index if not exists groups_username_unique on groups(lower(username)) where username is not null;
      create unique index if not exists groups_invite_unique on groups(invite_token) where invite_token is not null;
      create table if not exists group_members(
        group_id int not null references groups(id) on delete cascade,
        user_id int not null references users(id) on delete cascade,
        last_read_id int not null default 0,
        joined_at timestamptz default now(),
        primary key (group_id, user_id)
      );
      alter table group_members add column if not exists role text not null default 'member';
      alter table group_members add column if not exists muted_until timestamptz;
      alter table group_members add column if not exists notify_muted boolean not null default false;
      create index if not exists group_members_user_idx on group_members(user_id);
      create table if not exists group_bans(
        group_id int not null references groups(id) on delete cascade,
        user_id int not null references users(id) on delete cascade,
        banned_by int references users(id) on delete set null,
        created_at timestamptz default now(),
        primary key (group_id, user_id)
      );
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
      create index if not exists group_messages_idx on group_messages(group_id, id);
      alter table group_messages add column if not exists reply_to int references group_messages(id) on delete set null;
      alter table group_messages add column if not exists edited_at timestamptz;
      alter table group_messages add column if not exists fwd_from text;
      alter table group_messages add column if not exists mentions int[];
      alter table groups add column if not exists pinned_id int references group_messages(id) on delete set null;
      create table if not exists group_msg_reactions(
        msg_id int not null references group_messages(id) on delete cascade,
        user_id int not null references users(id) on delete cascade,
        emoji text not null,
        primary key (msg_id, user_id)
      );
      create table if not exists group_requests(
        group_id int not null references groups(id) on delete cascade,
        user_id int not null references users(id) on delete cascade,
        created_at timestamptz default now(),
        primary key (group_id, user_id)
      );
      create table if not exists group_polls(
        id serial primary key,
        message_id int not null unique references group_messages(id) on delete cascade,
        group_id int not null references groups(id) on delete cascade,
        question text not null,
        multi boolean not null default false,
        closed boolean not null default false,
        created_by int references users(id) on delete set null
      );
      create table if not exists group_poll_options(
        poll_id int not null references group_polls(id) on delete cascade,
        idx int not null,
        text text not null,
        primary key (poll_id, idx)
      );
      create table if not exists group_poll_votes(
        poll_id int not null,
        option_idx int not null,
        user_id int not null references users(id) on delete cascade,
        primary key (poll_id, option_idx, user_id),
        foreign key (poll_id, option_idx) references group_poll_options(poll_id, idx) on delete cascade
      );
      -- groups made before roles existed: their owner gets the owner role
      update group_members gm set role='owner' from groups g
        where g.id = gm.group_id and g.owner_id = gm.user_id and gm.role = 'member';`);
    const old = await pool.query('select id from groups where invite_token is null');
    for (const g of old.rows) await pool.query('update groups set invite_token=$2 where id=$1', [g.id, newToken()]);
  }

  // ---------- helpers ----------
  const parseId = (v) => { const n = parseInt(v, 10); return n > 0 ? n : 0; };
  const h = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    }
  };
  const fail = (res, status, error) => res.status(status).json({ error });
  const linkOf = (req, g) => `https://${req.hostname}/?join=${g.invite_token}`;
  const previewOf = (kind, body, name) =>
    kind === 'text' ? String(body || '').slice(0, 100)
    : kind === 'image' ? '📷 Photo'
    : kind === 'voice' ? '🎤 Voice message'
    : kind === 'poll' ? '📊 ' + String(body || '').slice(0, 80)
    : '📎 ' + (name || 'File');

  // the group + my role in it (null when I am not a member)
  async function ctx(gid, uid) {
    const r = await pool.query(
      `select g.id, g.name, g.description, g.avatar_url, g.is_public, g.username, g.invite_token,
              g.slow_seconds, g.can_write, g.can_media, g.can_poll, g.join_approval, g.pinned_id,
              m.role, m.notify_muted, (m.muted_until is not null and m.muted_until > now()) as muted, m.muted_until
       from group_members m join groups g on g.id = m.group_id
       where m.group_id=$1 and m.user_id=$2`,
      [gid, uid]
    );
    return r.rows[0] || null;
  }

  // loads the group for this request and checks the minimum role. Sends the error itself.
  async function guard(req, res, min) {
    const gid = parseId(req.params.id);
    const g = gid ? await ctx(gid, req.user.id) : null;
    if (!g) { fail(res, 404, 'Group not found'); return null; }
    if (rk(g.role) < RANK[min || 'member']) { fail(res, 403, 'You are not allowed to do this'); return null; }
    g.gid = gid;
    return g;
  }

  // a person who is a member of this group (by phone number)
  async function who(gid, phone) {
    const r = await pool.query(
      `select u.id, u.phone, u.name, m.role from users u
       join group_members m on m.user_id = u.id and m.group_id = $1
       where u.phone = $2`,
      [gid, normalizePhone(String(phone || ''))]
    );
    return r.rows[0] || null;
  }

  const memberCount = async (gid) =>
    (await pool.query('select count(*)::int as n from group_members where group_id=$1', [gid])).rows[0].n;

  async function blockedBetween(a, b) {
    const r = await pool.query(
      'select 1 from blocks where (user_id=$1 and blocked_id=$2) or (user_id=$2 and blocked_id=$1)',
      [a, b]
    );
    return r.rowCount > 0;
  }

  async function loadMsg(gid, viewer, mid) {
    const r = await pool.query(`select ${GSEL} ${GFROM} where m.group_id=$1 and m.id=$3`, [gid, viewer, mid]);
    return r.rows[0] || null;
  }

  async function pinnedOf(gid, pinnedId) {
    if (!pinnedId) return null;
    const r = await pool.query(
      `select m.id, m.kind, left(m.body, 100) as body, m.media_name, u.name as from_name
       from group_messages m left join users u on u.id=m.from_id where m.id=$1 and m.group_id=$2`,
      [pinnedId, gid]
    );
    return r.rows[0] || null;
  }

  // puts a person into a group (checks ban + size). Returns { ok } or { status, error }
  async function joinGroup(gid, uid) {
    const banned = await pool.query('select 1 from group_bans where group_id=$1 and user_id=$2', [gid, uid]);
    if (banned.rowCount) return { status: 403, error: 'You are banned from this group' };
    if ((await memberCount(gid)) >= MAX_MEMBERS) return { status: 400, error: `A group can have ${MAX_MEMBERS} people` };
    const ins = await pool.query(
      `insert into group_members(group_id, user_id, last_read_id)
       values($1,$2, coalesce((select max(id) from group_messages where group_id=$1),0))
       on conflict do nothing returning user_id`,
      [gid, uid]
    );
    if (!ins.rowCount) return { status: 409, error: 'Already in the group' };
    await pool.query('delete from group_requests where group_id=$1 and user_id=$2', [gid, uid]);
    io.in(uroom(uid)).socketsJoin(room(gid));
    io.to(room(gid)).emit('group:update', { id: gid });
    return { ok: true };
  }

  // a person asks to join a group that needs approval; the admins are told
  async function askToJoin(gid, groupName, uid, who) {
    const banned = await pool.query('select 1 from group_bans where group_id=$1 and user_id=$2', [gid, uid]);
    if (banned.rowCount) return { status: 403, error: 'You are banned from this group' };
    const ins = await pool.query(
      'insert into group_requests(group_id, user_id) values($1,$2) on conflict do nothing returning user_id',
      [gid, uid]
    );
    if (ins.rowCount) {
      const a = await pool.query("select user_id from group_members where group_id=$1 and role in ('owner','admin')", [gid]);
      a.rows.forEach((x) => {
        io.to(uroom(x.user_id)).emit('group:update', { id: gid });
        push.sendPush(x.user_id, { title: groupName, body: '👥 ' + who, tag: 'req-' + gid });
      });
    }
    return { ok: true, pending: true };
  }

  // takes a person out of the live room and tells their phone
  function dropFromRoom(uid, gid) {
    io.in(uroom(uid)).socketsLeave(room(gid));
    io.to(uroom(uid)).emit('group:gone', { id: gid });
    io.to(room(gid)).emit('group:update', { id: gid });
  }

  // every connected phone joins the rooms of its groups; "typing..."
  io.on('connection', async (socket) => {
    try {
      const r = await pool.query('select group_id from group_members where user_id=$1', [socket.user.id]);
      r.rows.forEach((x) => socket.join(room(x.group_id)));
      const nm = await pool.query('select name from users where id=$1', [socket.user.id]);
      const myName = nm.rows[0] ? nm.rows[0].name : null;
      socket.on('gtyping', (d) => {
        try {
          const gid = parseId(d && d.group_id);
          if (!gid || !socket.rooms.has(room(gid))) return;
          const now = Date.now();
          if (now - (typedAt.get(socket.user.id) || 0) < 1500) return;
          typedAt.set(socket.user.id, now);
          socket.to(room(gid)).emit('gtyping', { group_id: gid, phone: socket.user.phone, name: myName });
        } catch (e) { /* ignore */ }
      });
    } catch (e) {
      console.error(e);
    }
  });

  // ---------- my groups ----------
  app.get('/groups', auth, h(async (req, res) => {
    const r = await pool.query(
      `select g.id, g.name, g.avatar_url, g.is_public, g.username, gm.role, gm.notify_muted as notify_off,
         (select count(*) from group_members m2 where m2.group_id=g.id)::int as members,
         l.kind, l.body, l.media_name, l.created_at as last_at, lu.name as last_name, lu.phone as last_phone,
         (select count(*) from group_messages x
            where x.group_id=g.id and x.id > gm.last_read_id and x.from_id is distinct from $1)::int as unread,
         (select count(*) from group_messages x
            where x.group_id=g.id and x.id > gm.last_read_id and x.from_id is distinct from $1 and $1 = any(x.mentions))::int as mentions
       from group_members gm
       join groups g on g.id = gm.group_id
       left join lateral (select * from group_messages where group_id=g.id order by id desc limit 1) l on true
       left join users lu on lu.id = l.from_id
       where gm.user_id=$1
       order by coalesce(l.created_at, g.created_at) desc`,
      [req.user.id]
    );
    res.json(r.rows);
  }));

  // ---------- find public groups ----------
  app.get('/groups/search', auth, h(async (req, res) => {
    if (!within(looked, req.user.id, 20)) return fail(res, 429, 'Too many searches, wait a minute');
    const q = String(req.query.q || '').replace(/[%_\\@]/g, '').trim().slice(0, 40);
    if (q.length < 2) return res.json([]);
    const r = await pool.query(
      `select g.id, g.name, g.username, g.description, g.avatar_url,
         (select count(*) from group_members m where m.group_id=g.id)::int as members,
         exists(select 1 from group_members m where m.group_id=g.id and m.user_id=$2) as joined,
         exists(select 1 from group_requests q where q.group_id=g.id and q.user_id=$2) as requested
       from groups g
       where g.is_public and (lower(g.name) like '%' || lower($1) || '%' or lower(g.username) like '%' || lower($1) || '%')
       order by members desc, g.id limit 20`,
      [q, req.user.id]
    );
    res.json(r.rows);
  }));

  // ---------- make a group ----------
  app.post('/groups', auth, async (req, res) => {
    const c = await pool.connect();
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) return fail(res, 400, 'Write a group name');
      const description = String(b.description || '').trim().slice(0, 200);
      const isPublic = !!b.is_public;
      let username = null;
      if (isPublic) {
        username = String(b.username || '').replace(/^@/, '').trim();
        if (!USERNAME.test(username)) return fail(res, 400, 'Username: 5 to 32 letters, numbers or _ (start with a letter)');
      }
      const phones = Array.isArray(b.phones) ? b.phones.slice(0, MAX_MEMBERS * 2) : [];
      const owned = await pool.query('select count(*)::int as n from groups where owner_id=$1', [req.user.id]);
      if (owned.rows[0].n >= MAX_OWNED) return fail(res, 429, `You can make ${MAX_OWNED} groups`);

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
      const g = await c.query(
        'insert into groups(name, owner_id, description, is_public, username, invite_token) values($1,$2,$3,$4,$5,$6) returning id',
        [name, req.user.id, description || null, isPublic, username, newToken()]
      );
      const gid = g.rows[0].id;
      await c.query("insert into group_members(group_id, user_id, role) values($1,$2,'owner')", [gid, req.user.id]);
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
      if (e.code === '23505') return fail(res, 409, 'This username is already taken');
      console.error(e);
      if (!res.headersSent) fail(res, 500, 'Server error');
    } finally {
      c.release();
    }
  });

  // ---------- join ----------
  app.post('/groups/join-link', auth, h(async (req, res) => {
    const tok = String((req.body && req.body.token) || '').trim();
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(tok)) return fail(res, 400, 'This invite link is not valid');
    const r = await pool.query('select id, name, join_approval from groups where invite_token=$1', [tok]);
    if (!r.rowCount) return fail(res, 404, 'This invite link is not valid any more');
    const gid = r.rows[0].id;
    if (await ctx(gid, req.user.id)) return res.json({ ok: true, id: gid, already: true });
    if (r.rows[0].join_approval) {
      const a = await askToJoin(gid, r.rows[0].name, req.user.id, req.user.phone);
      if (!a.ok) return fail(res, a.status, a.error);
      return res.json({ ok: true, id: gid, pending: true });
    }
    const j = await joinGroup(gid, req.user.id);
    if (!j.ok) return fail(res, j.status, j.error);
    res.json({ ok: true, id: gid });
  }));

  app.post('/groups/:id/join', auth, h(async (req, res) => {
    const gid = parseId(req.params.id);
    const r = gid ? await pool.query('select name, is_public, join_approval from groups where id=$1', [gid]) : { rowCount: 0 };
    if (!r.rowCount || !r.rows[0].is_public) return fail(res, 404, 'Group not found'); // private groups need the invite link
    if (r.rows[0].join_approval) {
      if (await ctx(gid, req.user.id)) return fail(res, 409, 'Already in the group');
      const a = await askToJoin(gid, r.rows[0].name, req.user.id, req.user.phone);
      if (!a.ok) return fail(res, a.status, a.error);
      return res.json({ ok: true, id: gid, pending: true });
    }
    const j = await joinGroup(gid, req.user.id);
    if (!j.ok) return fail(res, j.status, j.error);
    res.json({ ok: true, id: gid });
  }));

  // ---------- join requests (admin) ----------
  app.get('/groups/:id/requests', auth, h(async (req, res) => {
    const g = await guard(req, res, 'admin');
    if (!g) return;
    const r = await pool.query(
      `select u.phone, u.name, q.created_at from group_requests q join users u on u.id=q.user_id
       where q.group_id=$1 order by q.created_at limit 100`,
      [g.gid]
    );
    res.json(r.rows);
  }));

  app.post('/groups/:id/requests/decide', auth, h(async (req, res) => {
    const g = await guard(req, res, 'admin');
    if (!g) return;
    const u = await pool.query(
      `select u.id from users u join group_requests q on q.user_id=u.id and q.group_id=$1 where u.phone=$2`,
      [g.gid, normalizePhone(String((req.body && req.body.phone) || ''))]
    );
    if (!u.rowCount) return fail(res, 404, 'Request not found');
    const uid = u.rows[0].id;
    await pool.query('delete from group_requests where group_id=$1 and user_id=$2', [g.gid, uid]);
    if (req.body && req.body.approve) {
      const j = await joinGroup(g.gid, uid);
      if (!j.ok) return fail(res, j.status, j.error);
      io.to(uroom(uid)).emit('group:new', { id: g.gid, name: g.name });
      push.sendPush(uid, { title: g.name, body: '✅ ' + 'You can join now', tag: 'req-' + g.gid });
    }
    io.to(room(g.gid)).emit('group:update', { id: g.gid });
    res.json({ ok: true });
  }));

  // ---------- open a group: info + people + last 100 messages (or 100 around ?around=ID); marks everything as read ----------
  app.get('/groups/:id', auth, h(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    const ppl = await pool.query(
      `select u.phone, u.name, u.avatar_url, m.role, (m.muted_until is not null and m.muted_until > now()) as muted
       from group_members m join users u on u.id = m.user_id
       where m.group_id=$1
       order by case m.role when 'owner' then 0 when 'admin' then 1 when 'mod' then 2 else 3 end, m.joined_at, u.id`,
      [g.gid]
    );
    const around = parseId(req.query.around);
    let rows;
    if (around) {
      rows = (await pool.query(
        `select * from (
           (select ${GSEL} ${GFROM} where m.group_id=$1 and m.id <= $3 order by m.id desc limit 50)
           union all
           (select ${GSEL} ${GFROM} where m.group_id=$1 and m.id > $3 order by m.id asc limit 50)) q order by id`,
        [g.gid, req.user.id, around]
      )).rows;
    } else {
      rows = (await pool.query(
        `select ${GSEL} ${GFROM} where m.group_id=$1 order by m.id desc limit 100`,
        [g.gid, req.user.id]
      )).rows.reverse();
    }
    await pool.query(
      `update group_members set last_read_id = greatest(last_read_id, coalesce((select max(id) from group_messages where group_id=$1), 0))
       where group_id=$1 and user_id=$2`,
      [g.gid, req.user.id]
    );
    let pending = 0;
    if (rk(g.role) >= RANK.admin)
      pending = (await pool.query('select count(*)::int as n from group_requests where group_id=$1', [g.gid])).rows[0].n;
    res.json({
      group: {
        id: g.gid, name: g.name, description: g.description, avatar_url: g.avatar_url,
        is_public: g.is_public, username: g.username, my_role: g.role, muted: g.muted, notify_off: g.notify_muted,
        slow_seconds: g.slow_seconds, can_write: g.can_write, can_media: g.can_media, can_poll: g.can_poll,
        join_approval: g.join_approval, pending_requests: pending,
        pinned: await pinnedOf(g.gid, g.pinned_id),
        link: rk(g.role) >= RANK.admin ? linkOf(req, g) : null,
        members: ppl.rows,
      },
      messages: rows,
    });
  }));

  // the open screen tells us it has seen new messages
  app.post('/groups/:id/read', auth, h(async (req, res) => {
    const gid = parseId(req.params.id);
    if (!gid) return fail(res, 400, 'Bad id');
    await pool.query(
      `update group_members set last_read_id = coalesce((select max(id) from group_messages where group_id=$1), 0)
       where group_id=$1 and user_id=$2`,
      [gid, req.user.id]
    );
    res.json({ ok: true });
  }));

  // notifications of this group on / off for me (mentions still come through)
  app.post('/groups/:id/notify', auth, h(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    const off = !!(req.body && req.body.muted);
    await pool.query('update group_members set notify_muted=$3 where group_id=$1 and user_id=$2', [g.gid, req.user.id, off]);
    res.json({ ok: true, notify_off: off });
  }));

  // ---------- change name, description, photo, settings (admin) and type/username (owner) ----------
  app.put('/groups/:id', auth, h(async (req, res) => {
    const g = await guard(req, res, 'admin');
    if (!g) return;
    const b = req.body || {};
    let name = g.name, description = g.description, avatar = g.avatar_url, isPublic = g.is_public, username = g.username;
    let slow = g.slow_seconds, canWrite = g.can_write, canMedia = g.can_media, canPoll = g.can_poll, approval = g.join_approval;
    if (b.name !== undefined) {
      name = String(b.name).trim().slice(0, 40);
      if (!name) return fail(res, 400, 'Write a group name');
    }
    if (b.description !== undefined) description = String(b.description).trim().slice(0, 200) || null;
    if (b.avatar_url !== undefined) {
      avatar = b.avatar_url ? String(b.avatar_url) : null;
      if (avatar && (avatar.length > 60000 || !avatar.startsWith('data:image/'))) return fail(res, 400, 'Photo too large');
    }
    if (b.slow_seconds !== undefined) {
      slow = parseInt(b.slow_seconds, 10);
      if (!SLOW_CHOICES.includes(slow)) return fail(res, 400, 'Bad slow mode time');
    }
    if (b.can_write !== undefined) canWrite = !!b.can_write;
    if (b.can_media !== undefined) canMedia = !!b.can_media;
    if (b.can_poll !== undefined) canPoll = !!b.can_poll;
    if (b.join_approval !== undefined) approval = !!b.join_approval;
    if (b.is_public !== undefined || b.username !== undefined) {
      if (g.role !== 'owner') return fail(res, 403, 'Only the owner can change the group type');
      if (b.is_public !== undefined) isPublic = !!b.is_public;
      if (b.username !== undefined) username = String(b.username).replace(/^@/, '').trim();
      if (isPublic) {
        if (!USERNAME.test(username || '')) return fail(res, 400, 'Username: 5 to 32 letters, numbers or _ (start with a letter)');
      } else username = null;
    }
    try {
      await pool.query(
        `update groups set name=$2, description=$3, avatar_url=$4, is_public=$5, username=$6,
           slow_seconds=$7, can_write=$8, can_media=$9, can_poll=$10, join_approval=$11 where id=$1`,
        [g.gid, name, description, avatar, isPublic, username, slow, canWrite, canMedia, canPoll, approval]
      );
    } catch (e) {
      if (e.code === '23505') return fail(res, 409, 'This username is already taken');
      throw e;
    }
    io.to(room(g.gid)).emit('group:update', { id: g.gid });
    res.json({ ok: true });
  }));

  // new invite link (the old one stops working)
  app.post('/groups/:id/invite/reset', auth, h(async (req, res) => {
    const g = await guard(req, res, 'admin');
    if (!g) return;
    g.invite_token = newToken();
    await pool.query('update groups set invite_token=$2 where id=$1', [g.gid, g.invite_token]);
    res.json({ ok: true, link: linkOf(req, g) });
  }));

  // ---------- roles ----------
  app.post('/groups/:id/role', auth, h(async (req, res) => {
    const g = await guard(req, res, 'admin');
    if (!g) return;
    const role = String((req.body && req.body.role) || '');
    if (!['admin', 'mod', 'member'].includes(role)) return fail(res, 400, 'Bad role');
    const t = await who(g.gid, req.body && req.body.phone);
    if (!t) return fail(res, 404, 'Not in the group');
    if (t.id === req.user.id || rk(t.role) >= rk(g.role)) return fail(res, 403, 'You are not allowed to do this');
    if (role === 'admin' && g.role !== 'owner') return fail(res, 403, 'Only the owner can make admins');
    await pool.query('update group_members set role=$3 where group_id=$1 and user_id=$2', [g.gid, t.id, role]);
    io.to(room(g.gid)).emit('group:update', { id: g.gid });
    res.json({ ok: true });
  }));

  // the owner gives the group to someone else (owner becomes admin)
  app.post('/groups/:id/transfer', auth, h(async (req, res) => {
    const g = await guard(req, res, 'owner');
    if (!g) return;
    const t = await who(g.gid, req.body && req.body.phone);
    if (!t || t.id === req.user.id) return fail(res, 404, 'Not in the group');
    await pool.query("update group_members set role='admin' where group_id=$1 and user_id=$2", [g.gid, req.user.id]);
    await pool.query("update group_members set role='owner' where group_id=$1 and user_id=$2", [g.gid, t.id]);
    await pool.query('update groups set owner_id=$2 where id=$1', [g.gid, t.id]);
    io.to(room(g.gid)).emit('group:update', { id: g.gid });
    res.json({ ok: true });
  }));

  // ---------- moderation ----------
  // minutes > 0 = mute for that long, forever = true, minutes 0 = unmute
  app.post('/groups/:id/mute', auth, h(async (req, res) => {
    const g = await guard(req, res, 'mod');
    if (!g) return;
    const b = req.body || {};
    const t = await who(g.gid, b.phone);
    if (!t) return fail(res, 404, 'Not in the group');
    if (rk(t.role) >= rk(g.role)) return fail(res, 403, 'You are not allowed to do this');
    const minutes = Math.min(parseInt(b.minutes, 10) || 0, 525600);
    if (b.forever) {
      await pool.query(`update group_members set muted_until = now() + interval '${FOREVER_DAYS} days' where group_id=$1 and user_id=$2`, [g.gid, t.id]);
    } else if (minutes > 0) {
      await pool.query("update group_members set muted_until = now() + make_interval(mins => $3::int) where group_id=$1 and user_id=$2", [g.gid, t.id, minutes]);
    } else {
      await pool.query('update group_members set muted_until = null where group_id=$1 and user_id=$2', [g.gid, t.id]);
    }
    io.to(room(g.gid)).emit('group:update', { id: g.gid });
    res.json({ ok: true });
  }));

  // remove a person (they can come back to a public group or with the link)
  app.post('/groups/:id/kick', auth, h(async (req, res) => {
    const g = await guard(req, res, 'mod');
    if (!g) return;
    const t = await who(g.gid, req.body && req.body.phone);
    if (!t) return fail(res, 404, 'Not in the group');
    if (rk(t.role) >= rk(g.role)) return fail(res, 403, 'You are not allowed to do this');
    await pool.query('delete from group_members where group_id=$1 and user_id=$2', [g.gid, t.id]);
    dropFromRoom(t.id, g.gid);
    res.json({ ok: true });
  }));

  // remove and block from coming back (even with the invite link)
  app.post('/groups/:id/ban', auth, h(async (req, res) => {
    const g = await guard(req, res, 'admin');
    if (!g) return;
    const t = await who(g.gid, req.body && req.body.phone);
    if (!t) return fail(res, 404, 'Not in the group');
    if (rk(t.role) >= rk(g.role)) return fail(res, 403, 'You are not allowed to do this');
    await pool.query('delete from group_members where group_id=$1 and user_id=$2', [g.gid, t.id]);
    await pool.query(
      'insert into group_bans(group_id, user_id, banned_by) values($1,$2,$3) on conflict do nothing',
      [g.gid, t.id, req.user.id]
    );
    dropFromRoom(t.id, g.gid);
    res.json({ ok: true });
  }));

  app.post('/groups/:id/unban', auth, h(async (req, res) => {
    const g = await guard(req, res, 'admin');
    if (!g) return;
    const u = await pool.query('select id from users where phone=$1', [normalizePhone(String((req.body && req.body.phone) || ''))]);
    if (!u.rowCount) return fail(res, 404, 'User not found');
    await pool.query('delete from group_bans where group_id=$1 and user_id=$2', [g.gid, u.rows[0].id]);
    res.json({ ok: true });
  }));

  app.get('/groups/:id/bans', auth, h(async (req, res) => {
    const g = await guard(req, res, 'admin');
    if (!g) return;
    const r = await pool.query(
      `select u.phone, u.name, b.created_at from group_bans b join users u on u.id=b.user_id
       where b.group_id=$1 order by b.created_at desc limit 100`,
      [g.gid]
    );
    res.json(r.rows);
  }));

  // ---------- add a person (admin; no approval needed) ----------
  app.post('/groups/:id/add', auth, h(async (req, res) => {
    const g = await guard(req, res, 'admin');
    if (!g) return;
    const p = await pool.query('select id from users where phone=$1', [normalizePhone(String((req.body && req.body.phone) || ''))]);
    if (!p.rowCount) return fail(res, 404, 'User not found');
    const uid = p.rows[0].id;
    if (await blockedBetween(req.user.id, uid)) return fail(res, 404, 'User not found');
    const j = await joinGroup(g.gid, uid);
    if (!j.ok) return fail(res, j.status === 403 ? 409 : j.status, j.status === 403 ? 'This person is banned. Unban first.' : j.error);
    io.to(uroom(uid)).emit('group:new', { id: g.gid, name: g.name });
    res.json({ ok: true });
  }));

  // ---------- leave / delete the group ----------
  app.post('/groups/:id/leave', auth, h(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    await pool.query('delete from group_members where group_id=$1 and user_id=$2', [g.gid, req.user.id]);
    io.in(uroom(req.user.id)).socketsLeave(room(g.gid));
    const next = await pool.query(
      `select user_id from group_members where group_id=$1
       order by case role when 'admin' then 0 when 'mod' then 1 else 2 end, joined_at, user_id limit 1`,
      [g.gid]
    );
    if (!next.rowCount) {
      await pool.query('delete from groups where id=$1', [g.gid]); // empty group goes away with its messages
    } else {
      if (g.role === 'owner') {
        await pool.query("update group_members set role='owner' where group_id=$1 and user_id=$2", [g.gid, next.rows[0].user_id]);
        await pool.query('update groups set owner_id=$2 where id=$1', [g.gid, next.rows[0].user_id]);
      }
      io.to(room(g.gid)).emit('group:update', { id: g.gid });
    }
    res.json({ ok: true });
  }));

  app.delete('/groups/:id', auth, h(async (req, res) => {
    const g = await guard(req, res, 'owner');
    if (!g) return;
    io.to(room(g.gid)).emit('group:gone', { id: g.gid });
    io.in(room(g.gid)).socketsLeave(room(g.gid));
    await pool.query('delete from groups where id=$1', [g.gid]);
    res.json({ ok: true });
  }));

  // ---------- sending: shared checks (muted, who may write, media, slow mode, rate limit) ----------
  // returns an error text + status, or null when this person may post now
  async function mayPost(g, uid, kind) {
    if (g.muted) return { status: 403, error: 'You are muted in this group' };
    const privileged = rk(g.role) >= RANK.mod;
    if (!privileged && !g.can_write) return { status: 403, error: 'Only admins can write in this group' };
    if (!privileged && kind !== 'text' && !g.can_media) return { status: 403, error: 'Members cannot send photos, voice or files here' };
    if (!privileged && g.slow_seconds > 0) {
      const l = await pool.query(
        `select extract(epoch from (now() - created_at))::int as ago from group_messages
         where group_id=$1 and from_id=$2 order by id desc limit 1`,
        [g.gid, uid]
      );
      if (l.rowCount && l.rows[0].ago < g.slow_seconds) {
        const wait = g.slow_seconds - l.rows[0].ago;
        return { status: 429, error: `Slow mode is on. Wait ${wait} seconds.`, wait };
      }
    }
    if (!within(sent, uid, 30)) return { status: 429, error: 'Too many messages, wait a minute' };
    return null;
  }

  // tells everybody in the group + push to the people whose app is closed
  async function announce(g, req, msgForOthers, preview, mentionIds) {
    const from = msgForOthers.from_name || req.user.phone;
    io.to(room(g.gid)).except(uroom(req.user.id)).emit('gmsg:new', { ...msgForOthers, group_id: g.gid });
    try {
      const ms = (await pool.query('select user_id, notify_muted from group_members where group_id=$1 and user_id <> $2', [g.gid, req.user.id])).rows;
      for (let i = 0; i < ms.length; i += 10) {
        await Promise.all(ms.slice(i, i + 10).map(async (x) => {
          const mentioned = mentionIds.includes(x.user_id);
          if (x.notify_muted && !mentioned) return;
          const socks = await io.in(uroom(x.user_id)).fetchSockets();
          if (!socks.length) push.sendPush(x.user_id, { title: g.name, body: (mentioned ? '@ ' : '') + from + ': ' + preview, tag: 'grp-' + g.gid });
        }));
      }
    } catch (e) { console.error(e); }
  }

  // ---------- messages ----------
  app.post('/groups/:id/send', auth, h(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    const b = req.body || {};
    const kind = KINDS.includes(b.kind) ? b.kind : 'text';
    let body = null, data = null, name = null, size = null, duration = null;
    if (kind === 'text') {
      body = String(b.body || '').trim().slice(0, 2000);
      if (!body) return fail(res, 400, 'Empty message');
    } else {
      data = String(b.data || '');
      if (!data.startsWith('data:') || data.length > MAX_DATA) return fail(res, 400, 'File too large (max 1 MB)');
      name = b.name ? String(b.name).slice(0, 100) : null;
      size = Math.min(parseInt(b.size, 10) || 0, 2000000);
      duration = kind === 'voice' ? Math.min(parseInt(b.duration, 10) || 0, 300) : null;
    }
    let replyTo = null;
    if (b.reply_to) {
      replyTo = parseId(b.reply_to);
      const ok = replyTo && (await pool.query('select 1 from group_messages where id=$1 and group_id=$2', [replyTo, g.gid])).rowCount;
      if (!ok) return fail(res, 400, 'The message you reply to was not found');
    }
    const fwd = b.fwd ? String(b.fwd).trim().slice(0, 60) || null : null;
    let mentionIds = [];
    if (Array.isArray(b.mentions) && b.mentions.length) {
      const phones = [...new Set(b.mentions.slice(0, 20).map((p) => normalizePhone(String(p))))];
      mentionIds = (await pool.query(
        `select u.id from users u join group_members m on m.user_id=u.id and m.group_id=$1 where u.phone = any($2::text[])`,
        [g.gid, phones]
      )).rows.map((x) => x.id);
    }
    const stop = await mayPost(g, req.user.id, kind);
    if (stop) return res.status(stop.status).json({ error: stop.error, wait: stop.wait });

    const r = await pool.query(
      `insert into group_messages(group_id, from_id, kind, body, media_url, media_name, media_size, duration, reply_to, fwd_from, mentions)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::int[]) returning id`,
      [g.gid, req.user.id, kind, body, data, name, size, duration, replyTo, fwd, mentionIds.length ? mentionIds : null]
    );
    const mid = r.rows[0].id;
    await pool.query('update group_members set last_read_id=$3 where group_id=$1 and user_id=$2 and last_read_id < $3', [g.gid, req.user.id, mid]);
    const msg = await loadMsg(g.gid, req.user.id, mid);
    const other = await loadMsg(g.gid, 0, mid);
    announce(g, req, other, previewOf(kind, body, name), mentionIds);
    res.json({ ok: true, msg });
  }));

  // edit my text message (for EDIT_HOURS hours)
  app.put('/groups/:id/messages/:mid', auth, h(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    const mid = parseId(req.params.mid);
    if (!mid) return fail(res, 400, 'Bad id');
    if (g.muted) return fail(res, 403, 'You are muted in this group');
    const body = String((req.body && req.body.body) || '').trim().slice(0, 2000);
    if (!body) return fail(res, 400, 'Empty message');
    const r = await pool.query(
      `update group_messages set body=$4, edited_at=now()
       where id=$1 and group_id=$2 and from_id=$3 and kind='text' and created_at > now() - make_interval(hours => $5::int)
       returning edited_at`,
      [mid, g.gid, req.user.id, body, EDIT_HOURS]
    );
    if (!r.rowCount) return fail(res, 403, 'You cannot edit this message');
    io.to(room(g.gid)).emit('gmsg:edit', { group_id: g.gid, id: mid, body, edited_at: r.rows[0].edited_at });
    res.json({ ok: true, body, edited_at: r.rows[0].edited_at });
  }));

  // delete a message: your own, or (moderator and up) one from someone of lower rank
  app.delete('/groups/:id/messages/:mid', auth, h(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    const mid = parseId(req.params.mid);
    if (!mid) return fail(res, 400, 'Bad id');
    const r = await pool.query(
      `select m.from_id, gm.role as author_role from group_messages m
       left join group_members gm on gm.group_id = m.group_id and gm.user_id = m.from_id
       where m.id=$1 and m.group_id=$2`,
      [mid, g.gid]
    );
    if (!r.rowCount) return fail(res, 404, 'Message not found');
    const own = r.rows[0].from_id === req.user.id;
    const canMod = rk(g.role) >= RANK.mod && rk(g.role) > rk(r.rows[0].author_role);
    if (!own && !canMod) return fail(res, 403, 'You are not allowed to do this');
    await pool.query('delete from group_messages where id=$1', [mid]);
    io.to(room(g.gid)).emit('gmsg:del', { group_id: g.gid, id: mid });
    if (g.pinned_id === mid) io.to(room(g.gid)).emit('group:update', { id: g.gid });
    res.json({ ok: true });
  }));

  // reaction: the same emoji again removes it, another emoji changes it
  app.post('/groups/:id/messages/:mid/react', auth, h(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    const mid = parseId(req.params.mid);
    const emoji = String((req.body && req.body.emoji) || '');
    if (!mid || !REACTIONS.includes(emoji)) return fail(res, 400, 'Bad reaction');
    if (g.muted) return fail(res, 403, 'You are muted in this group');
    const ex = await pool.query('select 1 from group_messages where id=$1 and group_id=$2', [mid, g.gid]);
    if (!ex.rowCount) return fail(res, 404, 'Message not found');
    const mine = await pool.query('select emoji from group_msg_reactions where msg_id=$1 and user_id=$2', [mid, req.user.id]);
    if (mine.rowCount && mine.rows[0].emoji === emoji)
      await pool.query('delete from group_msg_reactions where msg_id=$1 and user_id=$2', [mid, req.user.id]);
    else
      await pool.query(
        `insert into group_msg_reactions(msg_id, user_id, emoji) values($1,$2,$3)
         on conflict (msg_id, user_id) do update set emoji=excluded.emoji`,
        [mid, req.user.id, emoji]
      );
    const rx = await pool.query(
      `select coalesce(json_agg(json_build_object('e', x.emoji, 'p', u.phone)), '[]'::json) as reactions
       from group_msg_reactions x join users u on u.id=x.user_id where x.msg_id=$1`,
      [mid]
    );
    const reactions = rx.rows[0].reactions;
    io.to(room(g.gid)).emit('gmsg:react', { group_id: g.gid, id: mid, reactions });
    res.json({ ok: true, reactions });
  }));

  // pin one message (moderator and up) or unpin with { mid: null }
  app.post('/groups/:id/pin', auth, h(async (req, res) => {
    const g = await guard(req, res, 'mod');
    if (!g) return;
    const mid = req.body && req.body.mid ? parseId(req.body.mid) : 0;
    if (mid) {
      const ex = await pool.query('select 1 from group_messages where id=$1 and group_id=$2', [mid, g.gid]);
      if (!ex.rowCount) return fail(res, 404, 'Message not found');
    }
    await pool.query('update groups set pinned_id=$2 where id=$1', [g.gid, mid || null]);
    io.to(room(g.gid)).emit('group:update', { id: g.gid });
    res.json({ ok: true, pinned: await pinnedOf(g.gid, mid) });
  }));

  // search the text of this group
  app.get('/groups/:id/search', auth, h(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    if (!within(looked, req.user.id, 20)) return fail(res, 429, 'Too many searches, wait a minute');
    const q = String(req.query.q || '').replace(/[%_\\]/g, '').trim().slice(0, 40);
    if (q.length < 2) return res.json([]);
    const r = await pool.query(
      `select m.id, (m.from_id=$2) as mine, u.name as from_name, u.phone as from_phone, left(m.body, 120) as body, m.created_at
       from group_messages m left join users u on u.id=m.from_id
       where m.group_id=$1 and m.kind in ('text','poll') and m.body ilike '%' || $3 || '%' order by m.id desc limit 30`,
      [g.gid, req.user.id, q]
    );
    res.json(r.rows);
  }));

  // ---------- polls ----------
  app.post('/groups/:id/polls', auth, h(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    const b = req.body || {};
    const question = String(b.question || '').trim().slice(0, 200);
    const options = [...new Set((Array.isArray(b.options) ? b.options : []).map((o) => String(o || '').trim().slice(0, 80)).filter(Boolean))];
    if (!question) return fail(res, 400, 'Write the question');
    if (options.length < 2 || options.length > 10) return fail(res, 400, 'A poll needs 2 to 10 different answers');
    if (rk(g.role) < RANK.mod && !g.can_poll) return fail(res, 403, 'Members cannot make polls here');
    const stop = await mayPost(g, req.user.id, 'text');
    if (stop) return res.status(stop.status).json({ error: stop.error, wait: stop.wait });

    const c = await pool.connect();
    let mid;
    try {
      await c.query('begin');
      const m = await c.query("insert into group_messages(group_id, from_id, kind, body) values($1,$2,'poll',$3) returning id", [g.gid, req.user.id, question]);
      mid = m.rows[0].id;
      const p = await c.query('insert into group_polls(message_id, group_id, question, multi, created_by) values($1,$2,$3,$4,$5) returning id', [mid, g.gid, question, !!b.multi, req.user.id]);
      for (let i = 0; i < options.length; i++)
        await c.query('insert into group_poll_options(poll_id, idx, text) values($1,$2,$3)', [p.rows[0].id, i, options[i]]);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    await pool.query('update group_members set last_read_id=$3 where group_id=$1 and user_id=$2 and last_read_id < $3', [g.gid, req.user.id, mid]);
    const msg = await loadMsg(g.gid, req.user.id, mid);
    announce(g, req, await loadMsg(g.gid, 0, mid), previewOf('poll', question), []);
    res.json({ ok: true, msg });
  }));

  async function pollOf(g, pid) {
    const r = await pool.query('select id, message_id, closed, multi, created_by from group_polls where id=$1 and group_id=$2', [pid, g.gid]);
    return r.rows[0] || null;
  }

  // vote: options = list of answer numbers (empty list = take my vote back)
  app.post('/groups/:id/polls/:pid/vote', auth, h(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    if (g.muted) return fail(res, 403, 'You are muted in this group');
    const p = await pollOf(g, parseId(req.params.pid));
    if (!p) return fail(res, 404, 'Poll not found');
    if (p.closed) return fail(res, 409, 'This poll is closed');
    const picks = [...new Set((Array.isArray(req.body && req.body.options) ? req.body.options : []).map((x) => parseInt(x, 10)))];
    if (picks.some((x) => !(x >= 0 && x < 10))) return fail(res, 400, 'Bad answer');
    if (!p.multi && picks.length > 1) return fail(res, 400, 'Choose one answer');
    const valid = (await pool.query('select idx from group_poll_options where poll_id=$1', [p.id])).rows.map((x) => x.idx);
    if (picks.some((x) => !valid.includes(x))) return fail(res, 400, 'Bad answer');
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('delete from group_poll_votes where poll_id=$1 and user_id=$2', [p.id, req.user.id]);
      for (const x of picks) await c.query('insert into group_poll_votes(poll_id, option_idx, user_id) values($1,$2,$3)', [p.id, x, req.user.id]);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    const mine = await loadMsg(g.gid, req.user.id, p.message_id);
    const neutral = await loadMsg(g.gid, 0, p.message_id);
    io.to(room(g.gid)).emit('gpoll:update', { group_id: g.gid, id: p.message_id, poll: neutral.poll });
    res.json({ ok: true, poll: mine.poll });
  }));

  // close a poll (who made it, or admin and up)
  app.post('/groups/:id/polls/:pid/close', auth, h(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    const p = await pollOf(g, parseId(req.params.pid));
    if (!p) return fail(res, 404, 'Poll not found');
    if (p.created_by !== req.user.id && rk(g.role) < RANK.admin) return fail(res, 403, 'You are not allowed to do this');
    await pool.query('update group_polls set closed=true where id=$1', [p.id]);
    const neutral = await loadMsg(g.gid, 0, p.message_id);
    io.to(room(g.gid)).emit('gpoll:update', { group_id: g.gid, id: p.message_id, poll: neutral.poll });
    res.json({ ok: true });
  }));

  // ---------- photo / voice note / file of one group message (members only) ----------
  app.get('/groups/media/:id', auth, h(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 400, 'Bad id');
    const r = await pool.query(
      `select m.media_url from group_messages m
       join group_members gm on gm.group_id=m.group_id and gm.user_id=$2
       where m.id=$1 and m.media_url is not null`,
      [id, req.user.id]
    );
    if (!r.rowCount) return fail(res, 404, 'Not found');
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
  }));

  return { init };
}

module.exports = { setupGroups };
