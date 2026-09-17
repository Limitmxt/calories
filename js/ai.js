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
  async function fileToBitmap(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
        img.src = url;
      });
    }
  }
  function drawScaled(src, max, quality) {
    const w = src.width, h = src.height;
    const scale = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }
  // Returns { full: dataURL (<=1280px), thumb: dataURL (<=360px) }
  async function prepareImage(file) {
    const bmp = await fileToBitmap(file);
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
  async function openrouterAnalyze(cfg, { imageB64, text, previous, correction }) {
    const content = [{ type: 'text', text: userPrompt({ text, previous, correction }) }];
    if (imageB64) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageB64 } });
    const body = {
      model: cfg.openrouterModel || 'openrouter/free',
      temperature: 0.2,
      max_tokens: 2000,
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
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch (e) {}
      if (r.status === 401) throw new Error('OpenRouter rejected the API key. Check it in Settings. (' + msg + ')');
      if (r.status === 402) throw new Error('That model is not free. Pick a model ending in ":free" in Settings. (' + msg + ')');
      if (r.status === 429) throw new Error('OpenRouter free limit hit (20 per minute, 50 per day). Wait and retry, or pick another free model. (' + msg + ')');
      if (r.status === 404) throw new Error('Model not available right now. Pick another free model in Settings. (' + msg + ')');
      throw new Error(`OpenRouter error ${r.status}: ${msg}`);
    }
    const j = await r.json();
    const choice = j.choices && j.choices[0];
    if (!choice || !choice.message) throw new Error('OpenRouter returned no answer.' + (j.error ? ' ' + j.error.message : ''));
    let txt = choice.message.content;
    if (Array.isArray(txt)) txt = txt.map(p => p.text || '').join('');
    return normalize(parseJsonLoose(txt || ''));
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
    return `OK. Test answer: ${res.name}, ${sum(res.items).calories} kcal`;
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
