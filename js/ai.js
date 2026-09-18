/* Photo / text analysis providers. Gemini (free tier) is the default. Claude is optional and paid. */
const AI = (() => {
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const CLAUDE_BASE = 'https://api.anthropic.com/v1';
  const OR_BASE = 'https://openrouter.ai/api/v1';

  const SYSTEM = `You are a nutrition estimator inside a calorie-tracking app.
Given a photo (or a text description) of food, identify each distinct food item, estimate its portion from visual cues (plate size, utensils, packaging), and estimate calories and macros per item.
Rules:
- Be realistic. Restaurant and takeaway portions are larger and oilier than home cooking.
- amount is a short human-readable portion, e.g. "1 cup (150 g)", "2 slices", "200 g".
- Numbers are for the portion shown, not per 100 g.
- health_score is 1-10: 10 = whole foods, high fiber/protein, low added sugar; 1 = deep-fried, sugary, ultra-processed.
- confidence reflects how sure you are about the portion size.
- notes: one short sentence about what drove the estimate or what to double-check. No markdown.
- If the image contains no food, set is_food=false, empty items, name "No food detected".
Return only the JSON object.`;

  const SCHEMA = {
    type: 'OBJECT',
    properties: {
      is_food: { type: 'BOOLEAN' },
      name: { type: 'STRING' },
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            amount: { type: 'STRING' },
            calories: { type: 'NUMBER' },
            protein_g: { type: 'NUMBER' },
            carbs_g: { type: 'NUMBER' },
            fat_g: { type: 'NUMBER' },
          },
          required: ['name', 'amount', 'calories', 'protein_g', 'carbs_g', 'fat_g'],
        },
      },
      health_score: { type: 'INTEGER' },
      confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
      notes: { type: 'STRING' },
    },
    required: ['is_food', 'name', 'items', 'health_score', 'confidence', 'notes'],
  };

  // ---------- image helpers ----------
  const MAX_DIM = 1280;
  // Cheap header parse for JPEG / PNG / WebP dimensions so huge photos can be decoded pre-scaled.
  async function headerDims(file) {
    try {
      const buf = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
      const dv = new DataView(buf.buffer);
      if (buf[0] === 0xFF && buf[1] === 0xD8) { // JPEG: walk segments to SOFn
        let i = 2;
        while (i + 9 < buf.length) {
          if (buf[i] !== 0xFF) { i++; continue; }
          const m = buf[i + 1];
          if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01 || m === 0xFF) { i += 2; continue; }
          const len = dv.getUint16(i + 2);
          if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5) };
          i += 2 + len;
        }
      } else if (buf[0] === 0x89 && buf[1] === 0x50 && buf.length > 24) {
        return { w: dv.getUint32(16), h: dv.getUint32(20) };
      } else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf.length > 30) { // WebP VP8/VP8L/VP8X
        const tag = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
        if (tag === 'VP8X') return { w: 1 + (buf[24] | buf[25] << 8 | buf[26] << 16), h: 1 + (buf[27] | buf[28] << 8 | buf[29] << 16) };
        if (tag === 'VP8 ') return { w: dv.getUint16(26, true) & 0x3FFF, h: dv.getUint16(28, true) & 0x3FFF };
        if (tag === 'VP8L') { const b = buf; return { w: 1 + ((b[21] | b[22] << 8) & 0x3FFF), h: 1 + (((b[22] >> 6) | b[23] << 2 | (b[24] & 0x0F) << 10) & 0x3FFF) }; }
      }
    } catch (e) {}
    return null;
  }
  function resizeOpts(dims) {
    if (!dims || !(dims.w > 0 && dims.h > 0)) return {};
    const scale = MAX_DIM / Math.max(dims.w, dims.h);
    if (scale >= 1) return {};
    return { resizeWidth: Math.round(dims.w * scale), resizeHeight: Math.round(dims.h * scale), resizeQuality: 'high' };
  }
  async function fileToBitmap(file) {
    const dims = await headerDims(file);
    const big = dims && dims.w * dims.h > 16e6; // over ~16 MP: decode pre-scaled to avoid mobile memory failures
    const attempts = [];
    if (big) attempts.push(() => createImageBitmap(file, Object.assign({ imageOrientation: 'from-image' }, resizeOpts(dims))));
    attempts.push(() => createImageBitmap(file, { imageOrientation: 'from-image' }));
    if (!big) attempts.push(() => createImageBitmap(file, Object.assign({ imageOrientation: 'from-image' }, resizeOpts(dims) || {})));
    attempts.push(() => createImageBitmap(file));
    attempts.push(() => createImageBitmap(file, { resizeWidth: MAX_DIM, resizeQuality: 'high' }));
    attempts.push(() => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img element decode failed')); };
      img.src = url;
    }));
    let last = null;
    for (const a of attempts) { try { return await a(); } catch (e) { last = e; } }
    throw last || new Error('decode failed');
  }
  function describeFile(file) {
    const mb = (file.size / 1048576).toFixed(1);
    return `${file.type || 'unknown type'}, ${mb} MB${file.name ? ', ' + file.name : ''}`;
  }
  function drawScaled(src, max, quality) {
    const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    const scale = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }
  // iPhone photos are often HEIC, which browsers cannot decode. Convert in-browser on demand.
  let heicLib = null;
  function loadHeicLib() {
    if (heicLib) return heicLib;
    heicLib = new Promise((resolve, reject) => {
      if (window.heic2any) return resolve(window.heic2any);
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
      sc.onload = () => window.heic2any ? resolve(window.heic2any) : reject(new Error('HEIC converter failed to load'));
      sc.onerror = () => reject(new Error('Could not download the HEIC converter. Check your connection.'));
      document.head.appendChild(sc);
    }).catch(e => { heicLib = null; throw e; });
    return heicLib;
  }
  function looksHeic(file) {
    return /hei[cf]/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || '') || !file.type;
  }
  async function decodeAny(file, onStatus) {
    try { return await fileToBitmap(file); }
    catch (first) {
      if (!looksHeic(file) && file.type) throw new Error('Could not read that image (' + describeFile(file) + '). Try the in-app camera, or a JPEG or PNG.');
      if (onStatus) onStatus('Converting HEIC photo…');
      const heic2any = await loadHeicLib();
      let blob;
      try { blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 }); }
      catch (e) { throw new Error('Could not read that image (' + describeFile(file) + '). If it is a HEIF/HEIC photo, switch the camera to JPEG in its settings, or use the in-app camera.'); }
      if (Array.isArray(blob)) blob = blob[0];
      return fileToBitmap(blob);
    }
  }
  // Returns { full: dataURL (<=1280px), thumb: dataURL (<=360px) }
  async function prepareImage(file, onStatus) {
    const bmp = await decodeAny(file, onStatus);
    const full = drawScaled(bmp, 1280, 0.85);
    const thumb = drawScaled(bmp, 360, 0.8);
    if (bmp.close) bmp.close();
    return { full, thumb };
  }
  function b64Of(dataUrl) { return dataUrl.split(',')[1]; }

  // ---------- prompt building ----------
  function userPrompt({ text, previous, correction }) {
    let p = '';
    if (text) p += `Food description from the user: "${text}"\n`;
    else p += 'Analyze the food in this photo.\n';
    if (previous && correction) {
      p += `\nYour previous estimate was:\n${JSON.stringify(previous)}\n`;
      p += `The user corrects it: "${correction}"\nRe-estimate applying the correction. Keep everything the user did not mention unless it must change to stay consistent.\n`;
    }
    p += 'Respond with the JSON object only.';
    return p;
  }

  function normalize(raw) {
    const items = Array.isArray(raw.items) ? raw.items.map(i => ({
      name: String(i.name || 'Item'),
      amount: String(i.amount || ''),
      calories: num(i.calories),
      protein: num(i.protein_g ?? i.protein),
      carbs: num(i.carbs_g ?? i.carbs),
      fat: num(i.fat_g ?? i.fat),
    })) : [];
    return {
      isFood: raw.is_food !== false,
      name: String(raw.name || 'Meal'),
      items,
      healthScore: Math.max(1, Math.min(10, Math.round(num(raw.health_score) || 5))),
      confidence: raw.confidence || 'medium',
      notes: String(raw.notes || ''),
    };
  }
  function num(v) { const n = Number(v); return isFinite(n) ? Math.max(0, Math.round(n * 10) / 10) : 0; }

  function parseJsonLoose(text) {
    if (!text) throw new Error('Empty response from model');
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    try { return JSON.parse(t); } catch (e) {}
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('Model returned something that is not JSON');
  }

  // ---------- Gemini ----------
  async function geminiListModels(key) {
    const r = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!r.ok) throw new Error(await geminiErr(r));
    const j = await r.json();
    return (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /gemini/i.test(n) && !/(tts|live|audio|image|embedding|robotics|computer-use)/i.test(n))
      .sort();
  }
  async function geminiErr(r) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch (e) {}
    if (r.status === 429) return 'Rate limit hit on the free tier. Wait a minute and try again, or pick a different model in Settings. (' + msg + ')';
    if (r.status === 400 && /API key/i.test(msg)) return 'Gemini rejected the API key. Check it in Settings. (' + msg + ')';
    if (r.status === 403) return 'Gemini permission denied (403): ' + msg;
    if (r.status === 404) return 'Model not found. Choose another model in Settings. (' + msg + ')';
    return `Gemini error ${r.status}: ${msg}`;
  }
  async function geminiAnalyze(cfg, { imageB64, text, previous, correction }) {
    const parts = [];
    if (imageB64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageB64 } });
    parts.push({ text: userPrompt({ text, previous, correction }) });
    const body = {
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
      },
    };
    const model = cfg.geminiModel || 'gemini-2.5-flash';
    const r = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await geminiErr(r));
    const j = await r.json();
    const cand = j.candidates && j.candidates[0];
    if (!cand) {
      const why = j.promptFeedback && j.promptFeedback.blockReason;
      throw new Error(why ? `Gemini blocked the request (${why}).` : 'Gemini returned no answer.');
    }
    const txt = (cand.content && cand.content.parts || []).map(p => p.text || '').join('');
    return normalize(parseJsonLoose(txt));
  }

  // ---------- OpenRouter (free models, no card) ----------
  async function openrouterListModels() {
    const r = await fetch(`${OR_BASE}/models`);
    if (!r.ok) throw new Error(`OpenRouter model list failed (HTTP ${r.status})`);
    const j = await r.json();
    const list = (j.data || [])
      .filter(m => (m.pricing || {}).prompt === '0' && (m.pricing || {}).completion === '0')
      .filter(m => ((m.architecture || {}).input_modalities || []).includes('image'))
      .filter(m => /:free$/.test(m.id) || m.id === 'openrouter/free')
      .filter(m => !/(safety|guard|lyria|tts|audio)/i.test(m.id))
      .map(m => m.id).sort();
    // Put the router and Google's Gemma first: they are the most reliable free picks.
    const pref = ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'openrouter/free'];
    return [...pref.filter(x => list.includes(x)), ...list.filter(x => !pref.includes(x))];
  }
  let orModelCache = null;
  async function orModels() {
    if (!orModelCache) { try { orModelCache = await openrouterListModels(); } catch (e) { orModelCache = []; } }
    return orModelCache;
  }
  function orError(status, msg) {
    const e = new Error(msg); e.retryable = false;
    if (status === 401) e.message = 'OpenRouter rejected the API key. Check it in Settings. (' + msg + ')';
    else if (status === 402) e.message = 'That model is not free. Pick a model ending in ":free" in Settings. (' + msg + ')';
    else if (status === 404 && /data policy|privacy/i.test(msg)) e.message = 'OpenRouter blocks free models until you allow them: open openrouter.ai/settings/privacy and turn on "Enable free endpoints that may train on inputs". (' + msg + ')';
    else if (status === 429 && /per-day|per day|daily/i.test(msg)) e.message = 'Your OpenRouter free allowance for today (50 requests) is used up. It resets at midnight UTC. (' + msg + ')';
    else if (status === 429 || status === 404 || status === 408 || status >= 500) { e.message = msg; e.retryable = true; }
    else e.message = `OpenRouter error ${status}: ${msg}`;
    return e;
  }
  async function orOnce(cfg, model, { imageB64, text, previous, correction }) {
    const content = [{ type: 'text', text: userPrompt({ text, previous, correction }) }];
    if (imageB64) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageB64 } });
    const body = {
      model, temperature: 0.2, max_tokens: 2000,
      messages: [
        { role: 'system', content: SYSTEM + '\nThe JSON must have exactly these keys: is_food (boolean), name (string), items (array of {name, amount, calories, protein_g, carbs_g, fat_g}), health_score (integer 1-10), confidence ("low"|"medium"|"high"), notes (string). No markdown, no code fences, no text before or after the JSON.' },
        { role: 'user', content },
      ],
    };
    const r = await fetch(`${OR_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.openrouterKey, 'HTTP-Referer': location.origin, 'X-OpenRouter-Title': 'Cal Photo' },
      body: JSON.stringify(body),
    });
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw orError(r.status, (j && j.error && j.error.message) || `HTTP ${r.status}`);
    if (j && j.error) throw orError(Number(j.error.code) || 500, j.error.message || 'unknown error');
    const choice = j && j.choices && j.choices[0];
    if (!choice || !choice.message) { const e = new Error('Model returned no answer'); e.retryable = true; throw e; }
    let txt = choice.message.content;
    if (Array.isArray(txt)) txt = txt.map(p => p.text || '').join('');
    try { return normalize(parseJsonLoose(txt || '')); }
    catch (e) { e.retryable = true; throw e; }
  }
  // Free models are shared and often busy. Try the chosen model, then walk down the free list.
  async function openrouterAnalyze(cfg, input) {
    const primary = cfg.openrouterModel || 'openrouter/free';
    const list = await orModels();
    const candidates = [primary, ...list.filter(m => m !== primary)].slice(0, 6);
    const errs = [];
    for (const model of candidates) {
      try { const res = await orOnce(cfg, model, input); res.model = model; return res; }
      catch (e) { if (!e.retryable) throw e; errs.push(model.replace(/:free$/, '') + ': ' + e.message); }
    }
    throw new Error(`All ${candidates.length} free models were busy or failed. Wait a minute and try again.\n` + errs.join('\n'));
  }

  // ---------- Claude (optional, paid) ----------
  async function claudeAnalyze(cfg, { imageB64, text, previous, correction }) {
    const content = [];
    if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } });
    content.push({ type: 'text', text: userPrompt({ text, previous, correction }) + '\nJSON shape: ' + JSON.stringify(SCHEMA) });
    const body = {
      model: cfg.claudeModel || 'claude-opus-5',
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content }],
    };
    const r = await fetch(`${CLAUDE_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.claudeKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch (e) {}
      throw new Error('Claude: ' + msg);
    }
    const j = await r.json();
    if (j.stop_reason === 'refusal') throw new Error('Claude declined to analyze this image.');
    const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return normalize(parseJsonLoose(txt));
  }

  // ---------- public ----------
  function ready(cfg) {
    if (cfg.provider === 'claude') return !!cfg.claudeKey;
    if (cfg.provider === 'openrouter') return !!cfg.openrouterKey;
    return !!cfg.geminiKey;
  }
  async function analyze(cfg, input) {
    if (!ready(cfg)) throw new Error('No API key set. Add one in Settings.');
    if (cfg.provider === 'claude') return claudeAnalyze(cfg, input);
    if (cfg.provider === 'openrouter') return openrouterAnalyze(cfg, input);
    return geminiAnalyze(cfg, input);
  }
  async function test(cfg) {
    const res = await analyze(cfg, { text: 'one medium banana' });
    return `OK. Test answer: ${res.name}, ${sum(res.items).calories} kcal` + (res.model ? ` (via ${res.model})` : '');
  }
  function sum(items) {
    return items.reduce((a, i) => ({
      calories: a.calories + i.calories, protein: a.protein + i.protein, carbs: a.carbs + i.carbs, fat: a.fat + i.fat,
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  }

  // ---------- Open Food Facts (free, no key) ----------
  async function barcodeLookup(code) {
    const fields = 'product_name,brands,nutriments,serving_size,serving_quantity,image_front_small_url';
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`);
    if (!r.ok) throw new Error('Open Food Facts lookup failed');
    const j = await r.json();
    if (j.status !== 1 || !j.product) throw new Error('Barcode not found in Open Food Facts');
    const p = j.product, n = p.nutriments || {};
    const per100 = {
      calories: Number(n['energy-kcal_100g'] ?? (n['energy_100g'] ? n['energy_100g'] / 4.184 : 0)) || 0,
      protein: Number(n['proteins_100g']) || 0,
      carbs: Number(n['carbohydrates_100g']) || 0,
      fat: Number(n['fat_100g']) || 0,
    };
    return {
      name: [p.brands, p.product_name].filter(Boolean).join(' ') || `Product ${code}`,
      servingSize: p.serving_size || '',
      servingGrams: Number(p.serving_quantity) || 0,
      per100,
      image: p.image_front_small_url || null,
    };
  }

  return { prepareImage, b64Of, analyze, test, sum, geminiListModels, openrouterListModels, barcodeLookup };
})();
