// "Translate" button for chat messages (Oromo, Amharic, English).
// Two ways, set on Render (Environment):
//   GOOGLE_TRANSLATE_KEY = key from Google Cloud Translation (first 500,000 characters a month are free; needs a billing account)
//   TRANSLATE_EMAIL      = any email, uses the free MyMemory service (no key, small daily limit, quality can be weaker)
// If both are set, Google is used first.
const LANGS = { en: 'en', om: 'om', am: 'am' };

function setupTranslate(app, { auth }) {
  const KEY = process.env.GOOGLE_TRANSLATE_KEY || '';
  const EMAIL = process.env.TRANSLATE_EMAIL || '';
  const cache = new Map(); // "lang|text" -> { text, same }  (saves your free quota)
  const hits = new Map();  // userId -> times of requests

  async function viaGoogle(text, to) {
    const r = await fetch(
      'https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(KEY),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, target: to, format: 'text' }),
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!r.ok) throw new Error('google status ' + r.status);
    const t = (await r.json()).data.translations[0];
    return { text: t.translatedText, same: t.detectedSourceLanguage === to };
  }

  async function viaMyMemory(text, to) {
    const url =
      'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
      '&langpair=' + encodeURIComponent('autodetect|' + to) +
      '&de=' + encodeURIComponent(EMAIL);
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('mymemory status ' + r.status);
    const j = await r.json();
    const out = j.responseData && j.responseData.translatedText;
    if (!out) throw new Error('mymemory empty');
    if (/MYMEMORY WARNING/i.test(out)) { const e = new Error('limit'); e.limit = true; throw e; }
    if (/DISTINCT LANGUAGES/i.test(out)) return { text, same: true };
    return { text: out, same: out.trim().toLowerCase() === text.trim().toLowerCase() };
  }

  app.post('/translate', auth, async (req, res) => {
    if (!KEY && !EMAIL) return res.status(503).json({ error: 'Translation is not set up' });
    const text = String((req.body && req.body.text) || '').trim().slice(0, 1000);
    const to = LANGS[req.body && req.body.to];
    if (!text || !to) return res.status(400).json({ error: 'Bad request' });

    const now = Date.now();
    const list = (hits.get(req.user.id) || []).filter((t) => now - t < 60000);
    if (list.length >= 20) return res.status(429).json({ error: 'Too many translations. Wait a minute.' });
    list.push(now); hits.set(req.user.id, list);

    const ck = to + '|' + text;
    if (cache.has(ck)) return res.json({ ok: true, ...cache.get(ck), cached: true });
    try {
      const out = KEY ? await viaGoogle(text, to) : await viaMyMemory(text, to);
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      cache.set(ck, out);
      res.json({ ok: true, ...out });
    } catch (e) {
      console.error('translate failed:', e.message);
      res.status(e.limit ? 429 : 502).json({ error: e.limit ? 'Free translation limit reached for today' : 'Could not translate' });
    }
  });

  return { on: !!(KEY || EMAIL) };
}

module.exports = { setupTranslate };
