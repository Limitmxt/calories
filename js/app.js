/* Cal Photo - app logic. No framework, no build step. */
(() => {
  const $ = (id) => document.getElementById(id);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('cp.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { localStorage.setItem('cp.' + k, JSON.stringify(v)); },
    del(k) { localStorage.removeItem('cp.' + k); },
  };
  const VERSION = '1.1.0';
  const BUILD = '2026-09-18.5';

  const S = {
    profile: LS.get('profile', null),
    goals: LS.get('goals', null),
    settings: LS.get('settings', { provider: 'gemini', geminiKey: '', geminiModel: 'gemini-2.5-flash', openrouterKey: '', openrouterModel: 'openrouter/free', claudeKey: '', claudeModel: 'claude-opus-5' }),
    weights: LS.get('weights', []),
    selectedDate: ymd(new Date()),
    cur: null,       // meal being viewed/edited on the result screen
    curIsNew: false,
    screen: 'home',
  };

  // ---------- utils ----------
  function ymd(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function fromYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function fmtDateLong(s) { const d = fromYmd(s); const t = ymd(new Date()); if (s === t) return 'Today'; if (s === ymd(addDays(new Date(), -1))) return 'Yesterday'; return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function r0(n) { return Math.round(n); }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  let toastT;
  function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms); }
  function loading(on, text) { $('loading').classList.toggle('hidden', !on); if (text) $('loading-text').textContent = text; }

  function modal(html) {
    const m = $('modal'), b = $('modal-body');
    b.innerHTML = html; m.classList.remove('hidden');
    return b;
  }
  function closeModal() { $('modal').classList.add('hidden'); $('modal-body').innerHTML = ''; }
  function confirmDlg(title, text, okLabel = 'Confirm', danger = false) {
    return new Promise(resolve => {
      const b = modal(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p><div class="row-btns"><button class="btn-secondary" id="m-cancel">Cancel</button><button class="${danger ? 'btn-danger' : 'btn-primary'}" id="m-ok" style="margin-top:0">${esc(okLabel)}</button></div>`);
      b.querySelector('#m-cancel').onclick = () => { closeModal(); resolve(false); };
      b.querySelector('#m-ok').onclick = () => { closeModal(); resolve(true); };
    });
  }

  // ---------- screens ----------
  function showScreen(name) {
    ['onboarding', 'home', 'analytics', 'settings', 'result'].forEach(s => $('screen-' + s).classList.toggle('hidden', s !== name));
    const navVisible = ['home', 'analytics', 'settings'].includes(name);
    $('nav').classList.toggle('hidden', !navVisible);
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
    S.screen = name;
    window.scrollTo(0, 0);
    if (name === 'home') renderHome();
    if (name === 'analytics') renderAnalytics();
    if (name === 'settings') renderSettings();
  }

  // ---------- onboarding ----------
  const OB = { page: 0, data: { units: 'metric', gender: null, activity: null, goal: null, rate: 0.5, provider: 'gemini' } };
  const OB_PAGES = 7;
  function obRender() {
    document.querySelectorAll('.ob-page').forEach(p => p.classList.toggle('active', Number(p.dataset.page) === OB.page));
    $('ob-bar').style.width = `${((OB.page + 1) / OB_PAGES) * 100}%`;
    $('ob-back').style.visibility = OB.page === 0 ? 'hidden' : 'visible';
    $('ob-next').textContent = OB.page === 0 ? 'Get started' : OB.page === OB_PAGES - 1 ? "Let's go" : OB.page === 5 ? 'Continue' : 'Next';
    if (OB.page === 6) {
      const t = Nutrition.targets(obProfile());
      $('plan-cal').textContent = t.calories; $('plan-pro').textContent = t.protein + 'g';
      $('plan-carb').textContent = t.carbs + 'g'; $('plan-fat').textContent = t.fat + 'g';
    }
  }
  function obProfile() {
    const d = OB.data;
    let heightCm, weightKg;
    if (d.units === 'imperial') {
      heightCm = Nutrition.cmFromFtIn($('ob-height-ft').value, $('ob-height-in').value);
      weightKg = Nutrition.kgFromLb($('ob-weight-lb').value);
    } else {
      heightCm = Number($('ob-height-cm').value); weightKg = Number($('ob-weight-kg').value);
    }
    return { gender: d.gender, age: Number($('ob-age').value), heightCm, weightKg, activity: d.activity, goal: d.goal, rate: d.rate, units: d.units };
  }
  function obValidate() {
    const d = OB.data;
    if (OB.page === 1 && !d.gender) return 'Pick one to continue.';
    if (OB.page === 2) { const p = obProfile(); if (!(p.heightCm > 100 && p.heightCm < 250)) return 'Enter a realistic height.'; if (!(p.weightKg > 30 && p.weightKg < 300)) return 'Enter a realistic weight.'; if (!(p.age >= 13 && p.age < 100)) return 'Enter your age.'; }
    if (OB.page === 3 && !d.activity) return 'Pick your activity level.';
    if (OB.page === 4 && !d.goal) return 'Pick a goal.';
    return null;
  }
  async function obFinish() {
    const p = obProfile();
    S.profile = p; LS.set('profile', p);
    S.goals = Nutrition.targets(p); LS.set('goals', S.goals);
    S.weights = [{ date: ymd(new Date()), kg: p.weightKg }]; LS.set('weights', S.weights);
    const gKey = $('ob-gemini-key').value.trim(), oKey = $('ob-or-key').value.trim();
    if (OB.data.provider === 'openrouter' && oKey) {
      S.settings.openrouterKey = oKey; S.settings.provider = 'openrouter';
      try { const list = await AI.openrouterListModels(); if (list.length) S.settings.openrouterModel = list[0]; } catch (e) {}
    } else if (gKey) { S.settings.geminiKey = gKey; S.settings.provider = 'gemini'; }
    LS.set('settings', S.settings);
    showScreen('home');
  }
  function bindOnboarding() {
    $('ob-next').onclick = () => {
      const err = obValidate(); if (err) return toast(err);
      if (OB.page === OB_PAGES - 1) return obFinish();
      OB.page++; obRender();
    };
    $('ob-back').onclick = () => { if (OB.page > 0) { OB.page--; obRender(); } };
    document.querySelectorAll('.choice-list').forEach(list => {
      list.querySelectorAll('.choice').forEach(btn => btn.onclick = () => {
        list.querySelectorAll('.choice').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        OB.data[list.dataset.field] = btn.dataset.value;
        if (list.dataset.field === 'goal') $('ob-rate-wrap').classList.toggle('hidden', btn.dataset.value === 'maintain');
      });
    });
    document.querySelectorAll('.seg[data-field=units] .seg-btn').forEach(btn => btn.onclick = () => {
      document.querySelectorAll('.seg[data-field=units] .seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active'); OB.data.units = btn.dataset.value;
      $('metric-fields').classList.toggle('hidden', OB.data.units !== 'metric');
      $('imperial-fields').classList.toggle('hidden', OB.data.units !== 'imperial');
    });
    document.querySelectorAll('.seg[data-field=provider] .seg-btn').forEach(btn => btn.onclick = () => {
      document.querySelectorAll('.seg[data-field=provider] .seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active'); OB.data.provider = btn.dataset.value;
      $('ob-prov-gemini').classList.toggle('hidden', OB.data.provider !== 'gemini');
      $('ob-prov-openrouter').classList.toggle('hidden', OB.data.provider !== 'openrouter');
      $('ob-key-status').textContent = '';
    });
    $('ob-rate').oninput = (e) => { OB.data.rate = Number(e.target.value); $('ob-rate-label').textContent = `${OB.data.rate.toFixed(1)} kg / week`; };
    $('ob-test-key').onclick = async () => {
      const st = $('ob-key-status'); st.style.color = '';
      if (OB.data.provider === 'openrouter') {
        const key = $('ob-or-key').value.trim(); if (!key) return toast('Paste a key first.');
        st.textContent = 'Testing… (one real request)';
        try {
          let model = 'openrouter/free';
          try { const list = await AI.openrouterListModels(); if (list.length) model = list[0]; } catch (e) {}
          st.textContent = await AI.test({ provider: 'openrouter', openrouterKey: key, openrouterModel: model }); st.style.color = 'var(--ok)';
        } catch (e) { st.textContent = e.message; st.style.color = 'var(--danger)'; }
        return;
      }
      const key = $('ob-gemini-key').value.trim();
      if (!key) return toast('Paste a key first.');
      st.textContent = 'Testing…';
      try { const models = await AI.geminiListModels(key); st.textContent = `Key works. ${models.length} models available.`; st.style.color = 'var(--ok)'; }
      catch (e) { st.textContent = e.message; st.style.color = 'var(--danger)'; }
    };
  }

  // ---------- home ----------
  async function renderHome() {
    const today = new Date();
    const from = ymd(addDays(today, -6));
    const meals = await DB.range(from, ymd(today));
    const byDate = {};
    meals.forEach(m => { (byDate[m.date] = byDate[m.date] || []).push(m); });

    // week strip
    const strip = $('week-strip'); strip.innerHTML = '';
    for (let i = 6; i >= 0; i--) {
      const d = addDays(today, -i); const key = ymd(d);
      const b = document.createElement('button');
      b.className = 'day' + (key === S.selectedDate ? ' active' : '') + (byDate[key] ? ' logged' : '');
      b.innerHTML = `<small>${d.toLocaleDateString([], { weekday: 'short' }).slice(0, 2)}</small><b>${d.getDate()}</b><i class="dot"></i>`;
      b.onclick = () => { S.selectedDate = key; renderHome(); };
      strip.appendChild(b);
    }

    // totals
    let dayMeals = byDate[S.selectedDate];
    if (!dayMeals && (S.selectedDate < from)) dayMeals = await DB.byDate(S.selectedDate);
    dayMeals = (dayMeals || []).sort((a, b) => b.time.localeCompare(a.time));
    const tot = dayMeals.reduce((a, m) => { const t = mealTotals(m); a.calories += t.calories; a.protein += t.protein; a.carbs += t.carbs; a.fat += t.fat; return a; }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
    const g = S.goals;
    const left = g.calories - tot.calories;
    $('cal-left').textContent = r0(Math.abs(left));
    $('cal-left-label').textContent = left >= 0 ? 'Calories left' : 'Calories over';
    setRing('ring-cal', tot.calories, g.calories, 52);
    setLeft('pro-left', 'Protein', tot.protein, g.protein); setRing('ring-pro', tot.protein, g.protein, 24);
    setLeft('carb-left', 'Carbs', tot.carbs, g.carbs); setRing('ring-carb', tot.carbs, g.carbs, 24);
    setLeft('fat-left', 'Fat', tot.fat, g.fat); setRing('ring-fat', tot.fat, g.fat, 24);

    // list
    const list = $('meal-list'); list.innerHTML = '';
    $('meal-empty').classList.toggle('hidden', dayMeals.length > 0);
    document.querySelector('.section-title').textContent = S.selectedDate === ymd(today) ? 'Recently logged' : `Logged ${fmtDateLong(S.selectedDate)}`;
    dayMeals.forEach(m => {
      const t = mealTotals(m);
      const b = document.createElement('button'); b.className = 'meal';
      b.innerHTML = `${m.imageThumb ? `<img src="${m.imageThumb}" alt="">` : `<div class="meal-ph">${sourceIcon(m.source)}</div>`}
        <div class="meal-info"><div class="meal-name">${esc(m.name)}</div><div class="meal-cal">🔥 ${r0(t.calories)} kcal</div>
        <div class="meal-macros"><span>🥩 ${r0(t.protein)}g</span><span>🌾 ${r0(t.carbs)}g</span><span>🥑 ${r0(t.fat)}g</span></div></div>
        <div class="meal-time">${fmtTime(m.time)}</div>`;
      b.onclick = () => openResult(m, false);
      list.appendChild(b);
    });

    $('streak').textContent = '🔥 ' + await streak();
  }
  function sourceIcon(src) { return { text: '💬', barcode: '🏷️', manual: '✏️' }[src] || '🍽️'; }
  function setLeft(id, name, eaten, goal) { const l = goal - eaten; $(id).textContent = `${r0(Math.abs(l))}g`; $(id).parentElement.nextElementSibling.textContent = `${name} ${l >= 0 ? 'left' : 'over'}`; }
  function setRing(id, val, goal, r) {
    const el = $(id); const c = 2 * Math.PI * r; const frac = goal > 0 ? Math.min(1, val / goal) : 0;
    el.style.strokeDasharray = c; el.style.strokeDashoffset = c * (1 - frac);
    el.classList.toggle('over', val > goal);
  }
  function mealTotals(m) { const s = AI.sum(m.items || []); const k = m.servings || 1; return { calories: s.calories * k, protein: s.protein * k, carbs: s.carbs * k, fat: s.fat * k }; }
  async function streak() {
    const all = await DB.all(); const days = new Set(all.map(m => m.date));
    let d = new Date(); if (!days.has(ymd(d))) d = addDays(d, -1);
    let n = 0; while (days.has(ymd(d))) { n++; d = addDays(d, -1); }
    return n;
  }

  // ---------- add flows ----------
  function openSheet(on) { $('sheet').classList.toggle('hidden', !on); }
  function bindAdd() {
    $('add-btn').onclick = () => openSheet(true);
    document.querySelector('.sheet-bg').onclick = () => openSheet(false);
    $('opt-camera').onclick = () => { openSheet(false); $('file-camera').click(); };
    $('opt-gallery').onclick = () => { openSheet(false); $('file-gallery').click(); };
    $('file-camera').onchange = (e) => { if (e.target.files[0]) handlePhoto(e.target.files[0]); e.target.value = ''; };
    $('file-gallery').onchange = (e) => { if (e.target.files[0]) handlePhoto(e.target.files[0]); e.target.value = ''; };
    $('opt-describe').onclick = () => { openSheet(false); describeFlow(); };
    $('opt-barcode').onclick = () => { openSheet(false); barcodeFlow(); };
    $('opt-manual').onclick = () => { openSheet(false); manualFlow(); };
  }
  function hasKey() { const s = S.settings; return !!(s.provider === 'claude' ? s.claudeKey : s.provider === 'openrouter' ? s.openrouterKey : s.geminiKey); }
  function newMeal(extra) {
    const now = new Date();
    const time = S.selectedDate === ymd(now) ? now.toISOString() : new Date(fromYmd(S.selectedDate).setHours(now.getHours(), now.getMinutes())).toISOString();
    return Object.assign({ id: uid(), date: S.selectedDate, time, name: 'Meal', items: [], servings: 1, healthScore: null, notes: '', confidence: null, imageThumb: null, imageFull: null, source: 'photo', text: null }, extra);
  }
  async function handlePhoto(file) {
    if (!hasKey()) { toast('Add your Gemini API key in Settings first.'); return; }
    loading(true, 'Preparing photo…');
    Diag.log(`--- photo picked (${S.settings.provider}) build ${BUILD}`);
    try {
      const img = await AI.prepareImage(file, (t) => loading(true, t));
      loading(true, 'Analyzing…');
      const res = await AI.analyze(S.settings, { imageB64: AI.b64Of(img.full) });
      Diag.log(`analysis ok: ${res.name}, ${res.items.length} items`);
      loading(false);
      if (!res.isFood || !res.items.length) toast('No food detected. You can add items by hand or tap Fix results.');
      openResult(newMeal({ name: res.name, items: res.items, healthScore: res.healthScore, notes: res.notes, confidence: res.confidence, imageThumb: img.thumb, imageFull: img.full, source: 'photo' }), true);
    } catch (e) { loading(false); Diag.log('FAILED: ' + e.message); failDialog(e.message); }
  }
  function diagText() {
    return `Cal Photo build ${BUILD}\n${navigator.userAgent}\nprovider=${S.settings.provider} model=${S.settings.provider === 'openrouter' ? S.settings.openrouterModel : S.settings.geminiModel}\n\n${Diag.text()}`;
  }
  async function copyDiag() {
    try { await navigator.clipboard.writeText(diagText()); toast('Copied. Paste it in the chat.'); return true; }
    catch (e) { return false; }
  }
  function failDialog(msg) {
    const b = modal(`<h3>That did not work</h3><p class="muted small">${esc(msg)}</p><div class="row-btns"><button class="btn-secondary" id="m-cancel">Close</button><button class="btn-primary" id="m-copy" style="margin-top:0">Copy details</button></div><textarea id="m-diag" class="hidden" readonly style="margin-top:10px;min-height:140px;font-size:11px;font-family:monospace"></textarea>`);
    b.querySelector('#m-cancel').onclick = closeModal;
    b.querySelector('#m-copy').onclick = async () => {
      if (await copyDiag()) return;
      const ta = b.querySelector('#m-diag'); ta.classList.remove('hidden'); ta.value = diagText(); ta.focus(); ta.select();
      toast('Long-press the text, Select all, Copy.');
    };
  }
  function describeFlow() {
    if (!hasKey()) { toast('Add your Gemini API key in Settings first.'); return; }
    const b = modal(`<h3>Describe your meal</h3><label>What did you eat?<textarea id="m-text" placeholder="e.g. 2 scrambled eggs on 1 slice of sourdough with butter, and a flat white"></textarea></label><div class="row-btns"><button class="btn-secondary" id="m-cancel">Cancel</button><button class="btn-primary" id="m-ok" style="margin-top:0">Analyze</button></div>`);
    b.querySelector('#m-cancel').onclick = closeModal;
    b.querySelector('#m-text').focus();
    b.querySelector('#m-ok').onclick = async () => {
      const text = b.querySelector('#m-text').value.trim(); if (!text) return;
      closeModal(); loading(true, 'Analyzing…');
      try {
        const res = await AI.analyze(S.settings, { text });
        loading(false);
        openResult(newMeal({ name: res.name, items: res.items, healthScore: res.healthScore, notes: res.notes, confidence: res.confidence, source: 'text', text }), true);
      } catch (e) { loading(false); toast(e.message, 5000); }
    };
  }
  function manualFlow() {
    const b = modal(`<h3>Manual entry</h3>
      <label>Name<input type="text" id="m-name" placeholder="Chicken salad"></label>
      <div class="field-row"><label>Calories<input type="number" id="m-cal" inputmode="numeric"></label><label>Protein (g)<input type="number" id="m-pro" inputmode="decimal"></label><label>Carbs (g)<input type="number" id="m-carb" inputmode="decimal"></label><label>Fat (g)<input type="number" id="m-fat" inputmode="decimal"></label></div>
      <div class="row-btns"><button class="btn-secondary" id="m-cancel">Cancel</button><button class="btn-primary" id="m-ok" style="margin-top:0">Add</button></div>`);
    b.querySelector('#m-cancel').onclick = closeModal;
    b.querySelector('#m-ok').onclick = () => {
      const name = b.querySelector('#m-name').value.trim() || 'Meal';
      const item = { name, amount: '1 serving', calories: Number(b.querySelector('#m-cal').value) || 0, protein: Number(b.querySelector('#m-pro').value) || 0, carbs: Number(b.querySelector('#m-carb').value) || 0, fat: Number(b.querySelector('#m-fat').value) || 0 };
      closeModal();
      openResult(newMeal({ name, items: [item], source: 'manual' }), true);
    };
  }
  function barcodeFlow() {
    const canScan = 'BarcodeDetector' in window;
    const b = modal(`<h3>Barcode lookup</h3><p class="muted small">Uses the free Open Food Facts database. Coverage is good for supermarket products, patchy for everything else.</p>
      ${canScan ? '<button class="btn-secondary" id="m-scan">📷 Scan barcode with camera</button><input type="file" id="m-scan-file" accept="image/*" capture="environment" class="hidden"><p class="center muted small" style="margin:8px 0">or</p>' : ''}
      <label>Barcode number<input type="text" id="m-code" inputmode="numeric" placeholder="e.g. 5000159484695"></label>
      <div class="row-btns"><button class="btn-secondary" id="m-cancel">Cancel</button><button class="btn-primary" id="m-ok" style="margin-top:0">Look up</button></div>`);
    b.querySelector('#m-cancel').onclick = closeModal;
    if (canScan) {
      b.querySelector('#m-scan').onclick = () => b.querySelector('#m-scan-file').click();
      b.querySelector('#m-scan-file').onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const bmp = await createImageBitmap(f);
          const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
          const codes = await det.detect(bmp);
          if (!codes.length) return toast('No barcode found in that photo. Try closer and well lit.');
          b.querySelector('#m-code').value = codes[0].rawValue;
        } catch (err) { toast('Barcode scan failed: ' + err.message); }
      };
    }
    b.querySelector('#m-ok').onclick = async () => {
      const code = b.querySelector('#m-code').value.replace(/\D/g, ''); if (!code) return;
      closeModal(); loading(true, 'Looking up…');
      try { const p = await AI.barcodeLookup(code); loading(false); barcodeAmount(p); }
      catch (e) { loading(false); toast(e.message, 4000); }
    };
  }
  function barcodeAmount(p) {
    const def = p.servingGrams || 100;
    const b = modal(`<h3>${esc(p.name)}</h3><p class="muted small">Per 100 g: ${r0(p.per100.calories)} kcal · P ${r0(p.per100.protein)} · C ${r0(p.per100.carbs)} · F ${r0(p.per100.fat)}${p.servingSize ? `<br>Serving size on pack: ${esc(p.servingSize)}` : ''}</p>
      <label>How much did you eat? (grams or ml)<input type="number" id="m-g" inputmode="decimal" value="${def}"></label>
      <div class="row-btns"><button class="btn-secondary" id="m-cancel">Cancel</button><button class="btn-primary" id="m-ok" style="margin-top:0">Add</button></div>`);
    b.querySelector('#m-cancel').onclick = closeModal;
    b.querySelector('#m-ok').onclick = () => {
      const g = Number(b.querySelector('#m-g').value) || def; const k = g / 100;
      const item = { name: p.name, amount: `${g} g`, calories: r0(p.per100.calories * k), protein: Math.round(p.per100.protein * k * 10) / 10, carbs: Math.round(p.per100.carbs * k * 10) / 10, fat: Math.round(p.per100.fat * k * 10) / 10 };
      closeModal();
      openResult(newMeal({ name: p.name, items: [item], source: 'barcode' }), true);
    };
  }

  // ---------- result screen ----------
  function openResult(meal, isNew) {
    S.cur = JSON.parse(JSON.stringify(meal)); S.curIsNew = isNew;
    $('result-img').src = meal.imageFull || meal.imageThumb || '';
    $('result-img').classList.toggle('hidden', !(meal.imageFull || meal.imageThumb));
    $('result-img-placeholder').classList.toggle('hidden', !!(meal.imageFull || meal.imageThumb));
    $('result-img-placeholder').textContent = sourceIcon(meal.source);
    $('result-name').value = meal.name;
    $('result-time').textContent = `${fmtDateLong(meal.date)} · ${fmtTime(meal.time)}${meal.confidence ? ` · ${meal.confidence} confidence` : ''}`;
    $('delete-meal').classList.toggle('hidden', isNew);
    $('save-meal').textContent = isNew ? 'Done' : 'Save changes';
    $('fix-btn').classList.toggle('hidden', meal.source === 'barcode' || meal.source === 'manual');
    renderResult();
    showScreen('result');
  }
  function renderResult() {
    const m = S.cur; const t = mealTotals(m);
    $('serv-val').textContent = m.servings;
    $('r-cal').textContent = r0(t.calories);
    $('r-pro').textContent = r0(t.protein) + 'g'; $('r-carb').textContent = r0(t.carbs) + 'g'; $('r-fat').textContent = r0(t.fat) + 'g';
    $('r-health').textContent = m.healthScore ? `${m.healthScore}/10` : '–/10';
    $('r-health-bar').style.width = `${(m.healthScore || 0) * 10}%`;
    $('r-health-bar').style.background = !m.healthScore ? '#ccc' : m.healthScore >= 7 ? 'var(--ok)' : m.healthScore >= 4 ? 'var(--carb)' : 'var(--danger)';
    $('r-notes').textContent = m.notes || '';
    const list = $('r-items'); list.innerHTML = '';
    if (!m.items.length) list.innerHTML = '<p class="muted small">No items. Tap + Add or Fix results.</p>';
    m.items.forEach((it, idx) => {
      const b = document.createElement('button'); b.className = 'item';
      b.innerHTML = `<div><div class="i-name">${esc(it.name)}</div><div class="i-amt">${esc(it.amount)}</div></div><div><div class="i-cal">${r0(it.calories)} kcal</div><div class="i-macros">P ${it.protein}g · C ${it.carbs}g · F ${it.fat}g</div></div>`;
      b.onclick = () => editItem(idx);
      list.appendChild(b);
    });
  }
  function editItem(idx) {
    const it = idx >= 0 ? S.cur.items[idx] : { name: '', amount: '', calories: 0, protein: 0, carbs: 0, fat: 0 };
    const b = modal(`<h3>${idx >= 0 ? 'Edit item' : 'Add item'}</h3>
      <label>Name<input type="text" id="m-name" value="${esc(it.name)}"></label>
      <label>Amount<input type="text" id="m-amt" value="${esc(it.amount)}" placeholder="e.g. 150 g"></label>
      <div class="field-row"><label>Calories<input type="number" id="m-cal" inputmode="decimal" value="${it.calories}"></label><label>Protein (g)<input type="number" id="m-pro" inputmode="decimal" value="${it.protein}"></label><label>Carbs (g)<input type="number" id="m-carb" inputmode="decimal" value="${it.carbs}"></label><label>Fat (g)<input type="number" id="m-fat" inputmode="decimal" value="${it.fat}"></label></div>
      <div class="row-btns"><button class="btn-secondary" id="m-cancel">Cancel</button><button class="btn-primary" id="m-ok" style="margin-top:0">Save</button></div>
      ${idx >= 0 ? '<button class="btn-danger" id="m-del">Remove item</button>' : ''}`);
    b.querySelector('#m-cancel').onclick = closeModal;
    b.querySelector('#m-ok').onclick = () => {
      const n = { name: b.querySelector('#m-name').value.trim() || 'Item', amount: b.querySelector('#m-amt').value.trim(), calories: Number(b.querySelector('#m-cal').value) || 0, protein: Number(b.querySelector('#m-pro').value) || 0, carbs: Number(b.querySelector('#m-carb').value) || 0, fat: Number(b.querySelector('#m-fat').value) || 0 };
      if (idx >= 0) S.cur.items[idx] = n; else S.cur.items.push(n);
      closeModal(); renderResult();
    };
    if (idx >= 0) b.querySelector('#m-del').onclick = () => { S.cur.items.splice(idx, 1); closeModal(); renderResult(); };
  }
  function fixFlow() {
    const b = modal(`<h3>Fix results</h3><p class="muted small">Tell the AI what it got wrong and it will re-estimate.</p><label>Correction<textarea id="m-text" placeholder="e.g. that's brown rice not white, and the portion is about half of what you think"></textarea></label><div class="row-btns"><button class="btn-secondary" id="m-cancel">Cancel</button><button class="btn-primary" id="m-ok" style="margin-top:0">Re-analyze</button></div>`);
    b.querySelector('#m-cancel').onclick = closeModal;
    b.querySelector('#m-text').focus();
    b.querySelector('#m-ok').onclick = async () => {
      const correction = b.querySelector('#m-text').value.trim(); if (!correction) return;
      closeModal(); loading(true, 'Re-analyzing…');
      const m = S.cur;
      const previous = { name: m.name, items: m.items.map(i => ({ name: i.name, amount: i.amount, calories: i.calories, protein_g: i.protein, carbs_g: i.carbs, fat_g: i.fat })), health_score: m.healthScore, notes: m.notes };
      try {
        const res = await AI.analyze(S.settings, { imageB64: m.imageFull ? AI.b64Of(m.imageFull) : null, text: m.text, previous, correction });
        loading(false);
        Object.assign(S.cur, { name: res.name, items: res.items, healthScore: res.healthScore, notes: res.notes, confidence: res.confidence });
        $('result-name').value = res.name; renderResult(); toast('Updated.');
      } catch (e) { loading(false); toast(e.message, 5000); }
    };
  }
  function bindResult() {
    $('result-back').onclick = async () => {
      if (S.curIsNew && !(await confirmDlg('Discard this meal?', 'It has not been saved yet.', 'Discard', true))) return;
      showScreen('home');
    };
    $('serv-minus').onclick = () => { S.cur.servings = Math.max(0.5, Math.round((S.cur.servings - 0.5) * 2) / 2); renderResult(); };
    $('serv-plus').onclick = () => { S.cur.servings = Math.round((S.cur.servings + 0.5) * 2) / 2; renderResult(); };
    $('add-item').onclick = () => editItem(-1);
    $('fix-btn').onclick = fixFlow;
    $('save-meal').onclick = async () => {
      S.cur.name = $('result-name').value.trim() || 'Meal';
      if (!S.cur.items.length && !(await confirmDlg('Save with no items?', 'This meal has no calories logged.', 'Save anyway'))) return;
      await DB.put(S.cur); toast(S.curIsNew ? 'Meal logged.' : 'Saved.'); showScreen('home');
    };
    $('delete-meal').onclick = async () => {
      if (!(await confirmDlg('Delete this meal?', 'This cannot be undone.', 'Delete', true))) return;
      await DB.del(S.cur.id); toast('Deleted.'); showScreen('home');
    };
  }

  // ---------- analytics ----------
  async function renderAnalytics() {
    // weight
    const w = [...S.weights].sort((a, b) => a.date.localeCompare(b.date));
    const latest = w[w.length - 1];
    const imp = S.profile.units === 'imperial';
    const fmtW = (kg) => imp ? `${Nutrition.lbFromKg(kg)} lb` : `${kg} kg`;
    $('weight-current').textContent = latest ? fmtW(latest.kg) : '–';
    const first = w[0];
    $('weight-goal-text').textContent = (first && latest && first !== latest) ? `${latest.kg - first.kg > 0 ? '+' : ''}${Math.round((latest.kg - first.kg) * 10) / 10} kg since ${fromYmd(first.date).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : 'Log weight regularly to see the trend';
    $('weight-chart').innerHTML = lineChart(w.slice(-30).map(x => ({ label: fromYmd(x.date).toLocaleDateString([], { month: 'numeric', day: 'numeric' }), value: imp ? Nutrition.lbFromKg(x.kg) : x.kg })));

    // calories last 7 days
    const today = new Date(); const from = ymd(addDays(today, -6));
    const meals = await DB.range(from, ymd(today));
    const days = [];
    for (let i = 6; i >= 0; i--) { const d = addDays(today, -i); days.push({ key: ymd(d), label: d.toLocaleDateString([], { weekday: 'short' }).slice(0, 2), calories: 0, protein: 0, carbs: 0, fat: 0, n: 0 }); }
    meals.forEach(m => { const d = days.find(x => x.key === m.date); if (!d) return; const t = mealTotals(m); d.calories += t.calories; d.protein += t.protein; d.carbs += t.carbs; d.fat += t.fat; d.n++; });
    const logged = days.filter(d => d.n > 0);
    const avg = (k) => logged.length ? r0(logged.reduce((a, d) => a + d[k], 0) / logged.length) : 0;
    $('week-avg').textContent = logged.length ? `avg ${avg('calories')} / goal ${S.goals.calories}` : 'no meals logged yet';
    $('cal-chart').innerHTML = barChart(days.map(d => ({ label: d.label, value: r0(d.calories), empty: d.n === 0 })), S.goals.calories);
    $('macro-avg').innerHTML = `<div><b style="color:var(--pro)">${avg('protein')}g</b><span class="muted small">Protein · goal ${S.goals.protein}</span></div><div><b style="color:var(--carb)">${avg('carbs')}g</b><span class="muted small">Carbs · goal ${S.goals.carbs}</span></div><div><b style="color:var(--fat)">${avg('fat')}g</b><span class="muted small">Fat · goal ${S.goals.fat}</span></div>`;
  }
  function barChart(data, goal) {
    const W = 320, H = 150, padB = 18, padT = 14; const n = data.length; const bw = W / n * 0.55;
    const max = Math.max(goal * 1.15, ...data.map(d => d.value), 1);
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
    s += `<line class="axis" x1="0" y1="${y(0)}" x2="${W}" y2="${y(0)}"/>`;
    s += `<line class="goal" x1="0" y1="${y(goal)}" x2="${W}" y2="${y(goal)}"/>`;
    data.forEach((d, i) => {
      const x = (i + 0.5) * (W / n) - bw / 2; const h = Math.max(2, y(0) - y(d.value));
      s += `<rect class="bar${d.empty ? ' empty' : d.value > goal ? ' over' : ''}" x="${x}" y="${d.empty ? y(0) - 2 : y(d.value)}" width="${bw}" height="${d.empty ? 2 : h}" rx="4"/>`;
      if (!d.empty) s += `<text class="val" x="${x + bw / 2}" y="${y(d.value) - 4}">${d.value}</text>`;
      s += `<text class="lbl" x="${x + bw / 2}" y="${H - 4}">${d.label}</text>`;
    });
    return s + '</svg>';
  }
  function lineChart(data) {
    if (data.length < 2) return `<p class="muted small">Log at least two weights to see a chart.</p>`;
    const W = 320, H = 150, padB = 18, padT = 12, padX = 12;
    const vals = data.map(d => d.value); const min = Math.min(...vals), max = Math.max(...vals); const span = Math.max(1, max - min);
    const x = (i) => padX + (W - 2 * padX) * (i / (data.length - 1));
    const y = (v) => padT + (H - padT - padB) * (1 - (v - min) / span);
    let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
    s += `<line class="axis" x1="0" y1="${H - padB}" x2="${W}" y2="${H - padB}"/>`;
    s += `<polyline class="line" points="${data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ')}"/>`;
    data.forEach((d, i) => { s += `<circle class="pt" cx="${x(i)}" cy="${y(d.value)}" r="3"/>`; });
    const lab = [0, Math.floor((data.length - 1) / 2), data.length - 1];
    lab.forEach(i => { s += `<text class="lbl" x="${x(i)}" y="${H - 4}">${data[i].label}</text>`; });
    s += `<text class="val" x="${x(data.length - 1)}" y="${y(data[data.length - 1].value) - 8}">${data[data.length - 1].value}</text>`;
    return s + '</svg>';
  }
  function bindAnalytics() {
    $('log-weight-btn').onclick = () => {
      const imp = S.profile.units === 'imperial';
      const last = S.weights.length ? S.weights[S.weights.length - 1].kg : S.profile.weightKg;
      const b = modal(`<h3>Log weight</h3><label>Weight (${imp ? 'lb' : 'kg'})<input type="number" id="m-w" inputmode="decimal" step="0.1" value="${imp ? Nutrition.lbFromKg(last) : last}"></label><label>Date<input type="text" id="m-d" value="${ymd(new Date())}" placeholder="YYYY-MM-DD"></label><div class="row-btns"><button class="btn-secondary" id="m-cancel">Cancel</button><button class="btn-primary" id="m-ok" style="margin-top:0">Save</button></div>`);
      b.querySelector('#m-cancel').onclick = closeModal;
      b.querySelector('#m-ok').onclick = () => {
        let v = Number(b.querySelector('#m-w').value); if (!(v > 0)) return toast('Enter a weight.');
        const kg = imp ? Nutrition.kgFromLb(v) : Math.round(v * 10) / 10;
        const date = b.querySelector('#m-d').value.trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Date must be YYYY-MM-DD');
        S.weights = S.weights.filter(x => x.date !== date).concat([{ date, kg }]).sort((a, c) => a.date.localeCompare(c.date));
        LS.set('weights', S.weights);
        if (date === ymd(new Date())) { S.profile.weightKg = kg; LS.set('profile', S.profile); }
        closeModal(); renderAnalytics(); toast('Weight logged.');
      };
    };
  }

  // ---------- settings ----------
  function renderSettings() {
    const g = S.goals, p = S.profile, s = S.settings;
    $('set-cal').value = g.calories; $('set-pro').value = g.protein; $('set-carb').value = g.carbs; $('set-fat').value = g.fat;
    $('set-gender').value = p.gender; $('set-age').value = p.age; $('set-height').value = p.heightCm; $('set-weight').value = p.weightKg;
    $('set-activity').value = String(p.activity); $('set-goal').value = p.goal; $('set-rate').value = p.rate || 0.5; $('set-units').value = p.units || 'metric';
    $('set-provider').value = s.provider || 'gemini';
    $('set-gemini-key').value = s.geminiKey || ''; $('set-claude-key').value = s.claudeKey || ''; $('set-claude-model').value = s.claudeModel || 'claude-opus-5';
    setModelOptions('set-gemini-model', [s.geminiModel || 'gemini-2.5-flash'], s.geminiModel || 'gemini-2.5-flash');
    $('set-or-key').value = s.openrouterKey || '';
    setModelOptions('set-or-model', [s.openrouterModel || 'openrouter/free'], s.openrouterModel || 'openrouter/free');
    toggleProvider();
    if ((s.provider || 'gemini') === 'openrouter') refreshOrModels();
    $('version-line').textContent = `Cal Photo v${VERSION} build ${BUILD} · data stays on this device`;
    $('diag-build').textContent = `Build ${BUILD} · ${navigator.userAgent}`;
    $('diag-log').value = Diag.text() || '(nothing logged yet)';
  }
  function setModelOptions(id, list, selected) {
    const sel = $(id); sel.innerHTML = '';
    const all = Array.from(new Set([selected, ...list].filter(Boolean)));
    all.forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
    sel.value = selected;
  }
  function toggleProvider() {
    const v = $('set-provider').value;
    $('prov-gemini').classList.toggle('hidden', v !== 'gemini'); $('prov-claude').classList.toggle('hidden', v !== 'claude');
    $('prov-openrouter').classList.toggle('hidden', v !== 'openrouter');
    if (v === 'openrouter' && $('set-or-model').options.length < 2) refreshOrModels();
  }
  async function refreshOrModels() {
    try {
      const list = await AI.openrouterListModels();
      if (!list.length) return;
      const saved = S.settings.openrouterModel;
      setModelOptions('set-or-model', list, (saved && saved !== 'openrouter/free' && list.includes(saved)) ? saved : list[0]);
    } catch (e) { /* keep whatever is in the dropdown */ }
  }
  function readAiSettings() {
    return Object.assign({}, S.settings, {
      provider: $('set-provider').value, geminiKey: $('set-gemini-key').value.trim(), geminiModel: $('set-gemini-model').value || 'gemini-2.5-flash',
      openrouterKey: $('set-or-key').value.trim(), openrouterModel: $('set-or-model').value || 'openrouter/free',
      claudeKey: $('set-claude-key').value.trim(), claudeModel: $('set-claude-model').value.trim() || 'claude-opus-5',
    });
  }
  function bindSettings() {
    $('set-provider').onchange = toggleProvider;
    $('set-save-goals').onclick = () => {
      const g = { calories: Number($('set-cal').value), protein: Number($('set-pro').value), carbs: Number($('set-carb').value), fat: Number($('set-fat').value) };
      if (!(g.calories > 0)) return toast('Calories must be positive.');
      S.goals = g; LS.set('goals', g); toast('Goals saved.');
    };
    $('set-save-profile').onclick = () => {
      const p = { gender: $('set-gender').value, age: Number($('set-age').value), heightCm: Number($('set-height').value), weightKg: Number($('set-weight').value), activity: $('set-activity').value, goal: $('set-goal').value, rate: Number($('set-rate').value) || 0.5, units: $('set-units').value };
      if (!(p.age > 0 && p.heightCm > 0 && p.weightKg > 0)) return toast('Fill in age, height and weight.');
      S.profile = p; LS.set('profile', p); toast('Details saved. Tap "Recalculate" to update goals.');
    };
    $('set-recalc').onclick = () => {
      const p = { gender: $('set-gender').value, age: Number($('set-age').value), heightCm: Number($('set-height').value), weightKg: Number($('set-weight').value), activity: $('set-activity').value, goal: $('set-goal').value, rate: Number($('set-rate').value) || 0.5 };
      const t = Nutrition.targets(p);
      $('set-cal').value = t.calories; $('set-pro').value = t.protein; $('set-carb').value = t.carbs; $('set-fat').value = t.fat;
      toast(`Maintenance is about ${t.tdee} kcal. Tap Save goals to keep these.`, 4000);
    };
    $('set-save-ai').onclick = async () => {
      S.settings = readAiSettings(); LS.set('settings', S.settings); toast('Saved.');
      if (S.settings.provider === 'gemini' && S.settings.geminiKey) refreshModels(false);
    };
    $('set-test-ai').onclick = async () => {
      const st = $('set-ai-status'); const cfg = readAiSettings();
      st.textContent = 'Testing… (this makes one real request)'; st.style.color = '';
      try {
        if (cfg.provider === 'gemini') await refreshModels(true, cfg.geminiKey);
        const msg = await AI.test(readAiSettings());
        st.textContent = msg; st.style.color = 'var(--ok)';
      } catch (e) { st.textContent = e.message; st.style.color = 'var(--danger)'; }
    };
    $('export-btn').onclick = async () => {
      const meals = await DB.all();
      const blob = new Blob([JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(), profile: S.profile, goals: S.goals, weights: S.weights, settings: Object.assign({}, S.settings, { geminiKey: '', claudeKey: '' }), meals })], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `calphoto-backup-${ymd(new Date())}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    $('import-btn').onclick = () => $('import-file').click();
    $('import-file').onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!j.meals) throw new Error('Not a Cal Photo backup');
        if (!(await confirmDlg('Import backup?', `${j.meals.length} meals will be merged into your log. Profile and goals will be replaced.`, 'Import'))) return;
        for (const m of j.meals) await DB.put(m);
        if (j.profile) { S.profile = j.profile; LS.set('profile', j.profile); }
        if (j.goals) { S.goals = j.goals; LS.set('goals', j.goals); }
        if (j.weights) { S.weights = j.weights; LS.set('weights', j.weights); }
        toast('Imported.'); renderSettings();
      } catch (err) { toast('Import failed: ' + err.message, 4000); }
    };
    $('diag-copy').onclick = async () => {
      if (await copyDiag()) return;
      $('diag-log').value = diagText(); $('diag-log').select(); toast('Long-press the text, Select all, Copy.');
    };
    $('diag-clear').onclick = () => { Diag.clear(); $('diag-log').value = ''; };
    $('wipe-btn').onclick = async () => {
      if (!(await confirmDlg('Delete everything?', 'All meals, photos, weights, goals and keys on this device will be erased.', 'Delete all', true))) return;
      await DB.clear(); ['profile', 'goals', 'settings', 'weights'].forEach(LS.del); location.reload();
    };
  }
  async function refreshModels(loud, key) {
    key = key || S.settings.geminiKey; if (!key) return;
    try {
      const list = await AI.geminiListModels(key);
      const cur = $('set-gemini-model').value;
      setModelOptions('set-gemini-model', list, list.includes(cur) ? cur : (list.includes('gemini-2.5-flash') ? 'gemini-2.5-flash' : list[0]));
    } catch (e) { if (loud) throw e; }
  }

  // ---------- init ----------
  function bindNav() {
    document.querySelectorAll('.nav-btn').forEach(b => b.onclick = () => showScreen(b.dataset.screen));
    document.querySelector('.modal-bg').onclick = closeModal;
  }
  function init() {
    bindOnboarding(); bindNav(); bindAdd(); bindResult(); bindAnalytics(); bindSettings();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    if (!S.profile || !S.goals) { showScreen('onboarding'); obRender(); }
    else showScreen('home');
    let lastDay = ymd(new Date());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const t = ymd(new Date());
      if (t !== lastDay) { lastDay = t; S.selectedDate = t; }
      if (S.screen === 'home') renderHome();
    });
  }
  init();
})();
