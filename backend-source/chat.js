// Messaging: text, photos, voice notes, files. Also block list + delete account.
const MAX_DATA = 1500000; // max size of a file as base64 text (about 1 MB file)
const KINDS = ['text', 'image', 'voice', 'file'];
const SAFE_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a',
];

function setupChat(app, io, { pool, auth, normalizePhone, push }) {
  const room = (id) => 'u' + id;
  const sent = new Map(); // userId -> timestamps (simple rate limit)

  function rateOk(uid) {
    const now = Date.now();
    const a = (sent.get(uid) || []).filter((t) => now - t < 60000);
    if (a.length >= 30) return false; // max 30 messages per minute
    a.push(now);
    sent.set(uid, a);
    return true;
  }

  async function findUser(phone) {
    const r = await pool.query(
      'select id, phone, name, avatar_url, about from users where phone=$1',
      [normalizePhone(phone)]
    );
    return r.rows[0] || null;
  }

  async function isBlocked(a, b) {
    const r = await pool.query(
      'select 1 from blocks where (user_id=$1 and blocked_id=$2) or (user_id=$2 and blocked_id=$1)',
      [a, b]
    );
    return r.rowCount > 0;
  }

  // ---- realtime: every user joins a private room; read receipts ----
  io.on('connection', (socket) => {
    const uid = socket.user.id;
    socket.join(room(uid));

    socket.on('msg:read', async (d) => {
      try {
        const peer = await findUser(d && d.phone);
        if (!peer) return;
        const r = await pool.query(
          'update messages set read_at=now() where from_id=$1 and to_id=$2 and read_at is null returning id',
          [peer.id, uid]
        );
        if (r.rowCount) io.to(room(peer.id)).emit('msg:read', { phone: socket.user.phone });
      } catch (e) {
        console.error(e);
      }
    });
  });

  // ---- list of conversations ----
  app.get('/chats', auth, async (req, res) => {
    try {
      const r = await pool.query(
        `with m as (
           select id, from_id, to_id, kind, body, media_name, created_at,
                  case when from_id=$1 then to_id else from_id end as peer
           from messages where from_id=$1 or to_id=$1),
         last as (select distinct on (peer) * from m order by peer, id desc)
         select l.peer as id, u.phone, u.name, u.avatar_url, l.kind, l.body, l.media_name, l.created_at,
                (select count(*) from messages x
                   where x.from_id=l.peer and x.to_id=$1 and x.read_at is null)::int as unread
         from last l join users u on u.id=l.peer
         order by l.id desc`,
        [req.user.id]
      );
      res.json(r.rows);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- open a conversation (also marks received messages as read) ----
  app.get('/messages/:phone', auth, async (req, res) => {
    try {
      const peer = await findUser(req.params.phone);
      if (!peer) return res.status(404).json({ error: 'User not found' });
      const me = req.user.id;
      const m = await pool.query(
        `select id, (from_id=$1) as mine, kind, body, media_name, media_size, duration,
                (media_url is not null) as has_media, created_at, read_at
         from messages
         where (from_id=$1 and to_id=$2) or (from_id=$2 and to_id=$1)
         order by id desc limit 100`,
        [me, peer.id]
      );
      const r = await pool.query(
        'update messages set read_at=now() where from_id=$2 and to_id=$1 and read_at is null returning id',
        [me, peer.id]
      );
      if (r.rowCount) io.to(room(peer.id)).emit('msg:read', { phone: req.user.phone });
      res.json({
        peer: { phone: peer.phone, name: peer.name, avatar_url: peer.avatar_url, about: peer.about },
        messages: m.rows.reverse(),
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- send a message (text, image, voice, file) ----
  app.post('/messages/send', auth, async (req, res) => {
    try {
      const b = req.body || {};
      const kind = KINDS.includes(b.kind) ? b.kind : 'text';
      const peer = await findUser(b.to);
      if (!peer) return res.status(404).json({ error: 'User not found' });
      if (peer.id === req.user.id)
        return res.status(400).json({ error: 'You cannot message yourself' });
      if (await isBlocked(req.user.id, peer.id))
        return res.status(403).json({ error: 'User is unavailable' });
      if (!rateOk(req.user.id)) return res.status(429).json({ error: 'Too many messages, wait a minute' });

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
        `insert into messages(from_id, to_id, kind, body, media_url, media_name, media_size, duration)
         values($1,$2,$3,$4,$5,$6,$7,$8)
         returning id, kind, body, media_name, media_size, duration, created_at`,
        [req.user.id, peer.id, kind, body, data, name, size, duration]
      );
      const msg = { ...r.rows[0], has_media: kind !== 'text' };
      const me = await pool.query('select name from users where id=$1', [req.user.id]);
      io.to(room(peer.id)).emit('msg:new', {
        ...msg,
        from_phone: req.user.phone,
        from_name: me.rows[0] ? me.rows[0].name : null,
      });
      // receiver has the app closed -> send a push notification
      io.in(room(peer.id)).fetchSockets().then((socks) => {
        if (socks.length) return;
        const preview =
          kind === 'text' ? body.slice(0, 100)
          : kind === 'image' ? '📷 Photo'
          : kind === 'voice' ? '🎤 Voice message'
          : '📎 ' + (name || 'File');
        push.sendPush(peer.id, {
          title: (me.rows[0] && me.rows[0].name) || req.user.phone,
          body: preview,
          tag: 'msg-' + req.user.id,
        });
      }).catch((e) => console.error(e));
      res.json({ ok: true, msg });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- download the photo / voice note / file of one message ----
  app.get('/messages/media/:id', auth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Bad id' });
      const r = await pool.query(
        `select media_url from messages
         where id=$1 and media_url is not null and (from_id=$2 or to_id=$2)`,
        [id, req.user.id]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
      const url = r.rows[0].media_url;
      const i = url.indexOf(',');
      const head = url.slice(5, i); // e.g. image/jpeg;base64
      const payload = url.slice(i + 1);
      const buf = head.includes(';base64')
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload));
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

  // ---- block list ----
  app.get('/blocks', auth, async (req, res) => {
    const r = await pool.query(
      `select u.phone, u.name from blocks b join users u on u.id=b.blocked_id
       where b.user_id=$1 order by u.phone`,
      [req.user.id]
    );
    res.json(r.rows);
  });

  app.post('/block', auth, async (req, res) => {
    try {
      const peer = await findUser(req.body && req.body.phone);
      if (!peer) return res.status(404).json({ error: 'User not found' });
      if (req.body.block === false)
        await pool.query('delete from blocks where user_id=$1 and blocked_id=$2', [req.user.id, peer.id]);
      else
        await pool.query(
          'insert into blocks(user_id, blocked_id) values($1,$2) on conflict do nothing',
          [req.user.id, peer.id]
        );
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- delete my account and everything in it ----
  app.delete('/account', auth, async (req, res) => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('delete from coin_tx where user_id=$1', [req.user.id]);
      await c.query('delete from otps where phone=$1', [req.user.phone]);
      await c.query('delete from users where id=$1', [req.user.id]); // messages + blocks are removed too
      await c.query('commit');
      io.in(room(req.user.id)).disconnectSockets(true);
      res.json({ ok: true });
    } catch (e) {
      await c.query('rollback').catch(() => {});
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    } finally {
      c.release();
    }
  });
}

module.exports = { setupChat };
