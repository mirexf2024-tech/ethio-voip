const crypto = require('crypto');

const COINS_PER_MINUTE = parseInt(process.env.COINS_PER_MINUTE || '1', 10);
const RING_TIMEOUT_MS = 45000; // caller gives up after 45 seconds

function setupCalls(io, { pool, jwt, changeCoins, normalizePhone }) {
  const online = new Map();   // userId -> socket
  const calls = new Map();    // callId -> call object
  const userCall = new Map(); // userId -> callId (a user can only be in 1 call)

  const emitTo = (userId, event, data) => {
    const s = online.get(userId);
    if (s) s.emit(event, data);
  };

  // ---- end a call and tell both people ----
  function endCall(callId, reason) {
    const c = calls.get(callId);
    if (!c) return;
    calls.delete(callId);
    userCall.delete(c.callerId);
    userCall.delete(c.calleeId);
    clearTimeout(c.ringTimer);
    clearInterval(c.billTimer);
    const seconds = c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
    const payload = { callId, reason, seconds, coinsCharged: c.charged };
    emitTo(c.callerId, 'call:ended', payload);
    emitTo(c.calleeId, 'call:ended', payload);
  }

  // ---- charge the CALLER for one minute (server decides, phone cannot cheat) ----
  async function charge(c) {
    const bal = await changeCoins(c.callerId, -COINS_PER_MINUTE, `call:${c.id}`);
    if (bal === null) {
      endCall(c.id, 'no_coins');
      return false;
    }
    c.charged += COINS_PER_MINUTE;
    emitTo(c.callerId, 'call:charged', { balance: bal, charged: c.charged });
    if (bal < COINS_PER_MINUTE) emitTo(c.callerId, 'call:low_balance', { balance: bal });
    return true;
  }

  // ---- socket login using the same JWT token ----
  io.use((socket, next) => {
    try {
      const raw = String((socket.handshake.auth && socket.handshake.auth.token) || '');
      const t = raw.replace(/^Bearer\s+/i, '').replace(/["'\s]/g, '');
      socket.user = jwt.verify(t, process.env.JWT_SECRET);
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const uid = socket.user.id;

    // one device per account: kick the older connection
    const old = online.get(uid);
    if (old && old.id !== socket.id) old.disconnect(true);
    online.set(uid, socket);
    console.log(`online: ${socket.user.phone}`);

    // ---- caller starts a call ----
    socket.on('call:start', async (data) => {
      try {
        const { toPhone } = data || {};
        if (userCall.has(uid))
          return socket.emit('call:error', { message: 'You are already in a call' });

        const phone = normalizePhone(toPhone);
        const r = await pool.query('select id, phone, name from users where phone=$1', [phone]);
        if (!r.rowCount) return socket.emit('call:error', { message: 'User not found' });
        const callee = r.rows[0];
        if (callee.id === uid)
          return socket.emit('call:error', { message: 'You cannot call yourself' });

        const bl = await pool.query(
          'select 1 from blocks where (user_id=$1 and blocked_id=$2) or (user_id=$2 and blocked_id=$1)',
          [uid, callee.id]
        );
        if (bl.rowCount) return socket.emit('call:error', { message: 'User is unavailable' });

        const me = await pool.query('select coins, name from users where id=$1', [uid]);
        if (me.rows[0].coins < COINS_PER_MINUTE)
          return socket.emit('call:error', { message: 'Not enough coins' });
        if (!online.has(callee.id))
          return socket.emit('call:error', { message: 'User is offline' });
        if (userCall.has(callee.id))
          return socket.emit('call:error', { message: 'User is busy' });

        const id = crypto.randomUUID();
        const c = { id, callerId: uid, calleeId: callee.id, startedAt: null, charged: 0 };
        calls.set(id, c);
        userCall.set(uid, id);
        userCall.set(callee.id, id);
        c.ringTimer = setTimeout(() => endCall(id, 'no_answer'), RING_TIMEOUT_MS);

        socket.emit('call:ringing', { callId: id });
        emitTo(callee.id, 'call:incoming', {
          callId: id,
          from: { phone: socket.user.phone, name: me.rows[0].name },
        });
      } catch (e) {
        console.error(e);
        socket.emit('call:error', { message: 'Server error' });
      }
    });

    // ---- callee answers: first minute is charged now, then every 60s ----
    socket.on('call:accept', async (data) => {
      try {
        const c = calls.get(data && data.callId);
        if (!c || c.calleeId !== uid || c.startedAt || c.accepting) return;
        c.accepting = true;
        clearTimeout(c.ringTimer);

        const ok = await charge(c);
        if (!ok || !calls.has(c.id)) return;

        c.startedAt = Date.now();
        c.billTimer = setInterval(async () => {
          try {
            if (calls.has(c.id)) await charge(c);
          } catch (e) {
            console.error(e);
          }
        }, 60000);
        emitTo(c.callerId, 'call:accepted', { callId: c.id });
      } catch (e) {
        console.error(e);
      }
    });

    socket.on('call:reject', (data) => {
      const c = calls.get(data && data.callId);
      if (c && c.calleeId === uid && !c.startedAt) endCall(c.id, 'rejected');
    });

    socket.on('call:end', (data) => {
      const c = calls.get(data && data.callId);
      if (c && (c.callerId === uid || c.calleeId === uid)) endCall(c.id, 'hangup');
    });

    // ---- WebRTC messages: just pass them to the other person ----
    ['webrtc:offer', 'webrtc:answer', 'webrtc:ice'].forEach((event) => {
      socket.on(event, (data) => {
        const { callId, ...rest } = data || {};
        const c = calls.get(callId);
        if (!c) return;
        if (uid !== c.callerId && uid !== c.calleeId) return;
        const other = uid === c.callerId ? c.calleeId : c.callerId;
        emitTo(other, event, rest);
      });
    });

    socket.on('disconnect', () => {
      if (online.get(uid) !== socket) return; // replaced by a newer connection
      online.delete(uid);
      const cid = userCall.get(uid);
      if (cid) endCall(cid, 'disconnected');
    });
  });
}

module.exports = { setupCalls };
