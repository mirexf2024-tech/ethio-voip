// "Translate" button for chat messages.
// - If GOOGLE_TRANSLATE_KEY is set on Render: Google Cloud Translation (auto-detects the language).
// - Otherwise: free MyMemory. Set TRANSLATE_EMAIL on Render to get 50,000 characters/day (instead of 5,000).
const GOOGLE_KEY = process.env.GOOGLE_TRANSLATE_KEY || '';
const EMAIL = process.env.TRANSLATE_EMAIL || '';
const LANGS = ['om', 'am', 'en', 'ti', 'so'];
const ENGLISH_WORDS = /\b(the|is|are|you|your|and|to|of|in|it|that|for|with|hello|hi|thanks|thank|please|how|what|where|when|ok|okay|yes|no|good|morning|call|me|i|we|my|have|can|will)\b/gi;

function setupTranslate(app, { auth }) {
  const cache = new Map(); // "to|text" -> result (saves your daily quota)
  const used = new Map();  // userId -> times of requests

  const enabled = !!(GOOGLE_KEY || EMAIL);

  function guessSource(text) {
    if (/[\u1200-\u137F]/.test(text)) return 'am'; // Ethiopic letters (Amharic; Tigrinya also uses them)
    const hits = (text.match(ENGLISH_WORDS) || []).length;
    const words = text.trim().split(/\s+/).length;
    return hits / words >= 0.25 ? 'en' : 'om';
  }

  function chunks(text) {
    // MyMemory accepts at most 500 bytes at a time
    const parts = text.split(/(?<=[.!?።\n])\s+/);
    const out = [];
    let cur = '';
    for (const p of parts) {
      if (Buffer.byteLength(cur + ' ' + p) > 450 && cur) { out.push(cur); cur = p; }
      else cur = cur ? cur + ' ' + p : p;
    }
    if (cur) out.push(cur);
    return out.flatMap((c) => {
      if (Buffer.byteLength(c) <= 450) return [c];
      const cut = [];
      for (let i = 0; i < c.length; i += 120) cut.push(c.slice(i, i + 120));
      return cut;
    });
  }

  async function viaGoogle(text, to) {
    const r = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, target: to, format: 'text' }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error('google ' + r.status);
    const t = (await r.json()).data.translations[0];
    return { text: t.translatedText, from: t.detectedSourceLanguage };
  }

  async function viaMyMemory(text, to) {
    const from = guessSource(text);
    if (from === to) return { text, from, same: true };
    const out = [];
    for (const part of chunks(text)) {
      const q = new URLSearchParams({ q: part, langpair: `${from}|${to}` });
      if (EMAIL) q.set('de', EMAIL);
      const r = await fetch('https://api.mymemory.translated.net/get?' + q, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('mymemory ' + r.status);
      const j = await r.json();
      const tt = j && j.responseData && j.responseData.translatedText;
      if (!tt || Number(j.responseStatus) !== 200 || /MYMEMORY WARNING/i.test(tt)) throw new Error('mymemory quota or error');
      out.push(tt);
    }
    return { text: out.join(' '), from };
  }

  app.post('/translate', auth, async (req, res) => {
    try {
      if (!enabled) return res.status(503).json({ error: 'Translation is not set up' });
      const text = String((req.body && req.body.text) || '').trim().slice(0, 1000);
      const to = String((req.body && req.body.to) || '');
      if (!text || !LANGS.includes(to)) return res.status(400).json({ error: 'Bad request' });

      const now = Date.now();
      const list = (used.get(req.user.id) || []).filter((t) => now - t < 60000);
      if (list.length >= 20) return res.status(429).json({ error: 'Too many translations. Wait a minute.' });
      list.push(now); used.set(req.user.id, list);

      const key = to + '|' + text;
      if (cache.has(key)) return res.json({ ok: true, ...cache.get(key) });
      const result = GOOGLE_KEY ? await viaGoogle(text, to) : await viaMyMemory(text, to);
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      cache.set(key, result);
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('translate failed:', e.message);
      res.status(502).json({ error: 'Could not translate now' });
    }
  });

  return { enabled };
}

module.exports = { setupTranslate };
