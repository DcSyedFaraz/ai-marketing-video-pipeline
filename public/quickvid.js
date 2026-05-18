// ══════ Quick Video Tab ══════
let _qvDuration = 8;
let _qvHeroes = [];        // all heroes from catalog
let _qvSelectedHeroes = new Set();
let _qvPendingTaskUUID = null;
let _qvPollTimer = null;
let _qvExtraRefs = [];     // { file, name, thumbUrl }
let _qvScriptPanelOpen = false;
let _qvScriptType = 'ua'; // 'ua' | 'story'
let _qvAngles = [];       // cached marketing angles
let _qvSelectedAngleId = null;
let _qvScriptDur = 8;     // target duration chosen inside the Generate Script panel

function qvSetScriptDur(val, el) {
  _qvScriptDur = val;
  document.querySelectorAll('#qv-script-dur-chips .el-chip').forEach(c => c.classList.remove('selected'));
  if (el) el.classList.add('selected');
}
function qvSetScriptDurSel(val) {
  _qvScriptDur = parseInt(val) || 8;
}
const QV_AUDIENCE_PRESETS = [
  "Gamer mom with a toddler on her lap",
  "Grandma excitedly showing her son's game to her friends",
  "Dad sneaking game sessions between work calls",
  "Teen streamer in her neon-lit bedroom",
  "Office worker playing on lunch break",
  "Retired man who loves strategy games",
  "Fitness influencer gaming between reps",
  "College student in a dorm room at 2am"
];

// Parse Key Features + USPs out of game-context.txt
function qvParseGameContextPoints(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const out = [];
  let section = null;
  for (const ln of lines) {
    if (/^key features:/i.test(ln)) { section = 'kf';  continue; }
    if (/^usps?:/i.test(ln))         { section = 'usp'; continue; }
    if (!ln)                         { section = null; continue; }
    if (!section)                    continue;
    if (/^[A-Z][A-Za-z ]+:$/.test(ln)) { section = null; continue; }
    out.push({ section, text: ln.replace(/^[-•*]\s*/, '') });
  }
  return out;
}

async function qvToggleScriptPanel() {
  const panel = document.getElementById('qv-script-panel');
  _qvScriptPanelOpen = !_qvScriptPanelOpen;
  panel.style.display = _qvScriptPanelOpen ? 'block' : 'none';
  if (!_qvScriptPanelOpen) return;

  // Build UA audience preset chips once
  const chipsEl = document.getElementById('qv-audience-chips');
  if (!chipsEl.dataset.built) {
    chipsEl.innerHTML = QV_AUDIENCE_PRESETS.map(p =>
      `<span class="el-chip" onclick="qvPickAudiencePreset(this,'ua')">${p}</span>`).join('');
    chipsEl.dataset.built = '1';
  }

  // Build Story audience preset chips once
  const storyChipsEl = document.getElementById('qv-story-audience-chips');
  if (!storyChipsEl.dataset.built) {
    storyChipsEl.innerHTML = QV_AUDIENCE_PRESETS.map(p =>
      `<span class="el-chip" onclick="qvPickAudiencePreset(this,'story')">${p}</span>`).join('');
    storyChipsEl.dataset.built = '1';
  }

  // Populate product-point dropdown (once per session)
  const sel = document.getElementById('qv-product-point');
  if (sel.options.length <= 1) {
    try {
      const res = await fetch('/game-context.txt');
      const txt = await res.text();
      for (const p of qvParseGameContextPoints(txt)) {
        const opt = document.createElement('option');
        opt.value = p.text;
        opt.textContent = (p.section === 'usp' ? 'USP — ' : 'Feature — ') + p.text;
        sel.appendChild(opt);
      }
    } catch (e) { /* Auto-only fallback */ }
  }

  // Load angles for story mode (once per session)
  if (_qvAngles.length === 0) await qvLoadAngles();
}

function qvSetScriptType(type) {
  _qvScriptType = type;
  const btns = { ua: 'qv-stype-ua', story: 'qv-stype-story', narrative: 'qv-stype-narrative', streetinterview: 'qv-stype-streetinterview' };
  for (const [t, id] of Object.entries(btns)) {
    const el = document.getElementById(id);
    if (t === type) {
      el.style.borderColor = 'var(--accent)';
      el.style.background = 'rgba(124,58,237,0.15)';
      el.style.color = 'var(--accent)';
    } else {
      el.style.borderColor = 'var(--border)';
      el.style.background = 'var(--surface)';
      el.style.color = 'var(--muted)';
    }
  }
  document.getElementById('qv-ua-fields').style.display = type === 'ua' ? 'block' : 'none';
  document.getElementById('qv-story-fields').style.display = type === 'story' ? 'block' : 'none';
  document.getElementById('qv-narrative-fields').style.display = type === 'narrative' ? 'block' : 'none';
  document.getElementById('qv-streetinterview-fields').style.display = type === 'streetinterview' ? 'block' : 'none';
  if ((type === 'story') && _qvAngles.length === 0) qvLoadAngles();
  if (type === 'narrative' && _qvAngles.length === 0) qvLoadNarrativeAngles();
  else if (type === 'narrative' && _qvAngles.length > 0) qvRenderNarrativeAngleGrid();
  if (type === 'streetinterview') qvBuildLocationChips();
}

async function qvLoadNarrativeAngles() {
  const grid = document.getElementById('qv-narrative-angle-grid');
  if (_qvAngles.length > 0) { qvRenderNarrativeAngleGrid(); return; }
  try {
    const res = await fetch('/api/marketing-angles');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _qvAngles = data.angles || [];
    qvRenderNarrativeAngleGrid();
  } catch (e) {
    grid.innerHTML = `<div style="color:var(--muted);font-size:12px;grid-column:1/-1">Could not load angles</div>`;
  }
}

function qvRenderNarrativeAngleGrid() {
  const grid = document.getElementById('qv-narrative-angle-grid');
  if (!_qvAngles.length) { grid.innerHTML = '<div style="color:var(--muted);font-size:12px;grid-column:1/-1">No angles</div>'; return; }
  grid.innerHTML = _qvAngles.map(a => {
    const statusClass = a.status === 'in_pipeline' ? 'in-pipeline' : a.status === 'untested_gap' ? 'untested-gap' : 'untested';
    const statusLabel = a.status === 'in_pipeline' ? '▶ In Pipeline' : a.status === 'untested_gap' ? `★ Gap (Priority ${a.test_priority})` : '○ Untested';
    return `<div class="angle-card" id="qv-nangle-card-${a.id}" onclick="qvSelectNarrativeAngle(${a.id})">
      <div class="angle-card-name">${a.name}</div>
      <div class="angle-card-msg">${a.core_message}</div>
      <div class="angle-card-status ${statusClass}">${statusLabel}</div>
    </div>`;
  }).join('');
}

let _qvSelectedNarrativeAngleId = null;
function qvSelectNarrativeAngle(id) {
  _qvSelectedNarrativeAngleId = id;
  document.querySelectorAll('#qv-narrative-angle-grid .angle-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById(`qv-nangle-card-${id}`);
  if (card) card.classList.add('selected');
}

async function qvLoadAngles() {
  const grid = document.getElementById('qv-angle-grid');
  try {
    const res = await fetch('/api/marketing-angles');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _qvAngles = data.angles || [];
    qvRenderAngleGrid();
  } catch (e) {
    grid.innerHTML = `<div style="color:var(--muted);font-size:12px;grid-column:1/-1">Could not load angles: ${e.message}</div>`;
  }
}

function qvRenderAngleGrid() {
  const grid = document.getElementById('qv-angle-grid');
  if (!_qvAngles.length) {
    grid.innerHTML = '<div style="color:var(--muted);font-size:12px;grid-column:1/-1">No angles found.</div>';
    return;
  }
  grid.innerHTML = _qvAngles.map(a => {
    const statusClass = a.status === 'in_pipeline' ? 'in-pipeline' : a.status === 'untested_gap' ? 'untested-gap' : 'untested';
    const statusLabel = a.status === 'in_pipeline' ? '▶ In Pipeline' : a.status === 'untested_gap' ? `★ Gap (Priority ${a.test_priority})` : '○ Untested';
    return `<div class="angle-card" id="qv-angle-card-${a.id}" onclick="qvSelectAngle(${a.id})">
      <div class="angle-card-name">${a.name}</div>
      <div class="angle-card-msg">${a.core_message}</div>
      <div class="angle-card-status ${statusClass}">${statusLabel}</div>
    </div>`;
  }).join('');
}

function qvSelectAngle(id) {
  _qvSelectedAngleId = id;
  document.querySelectorAll('#qv-angle-grid .angle-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById(`qv-angle-card-${id}`);
  if (card) card.classList.add('selected');
}

function qvPickAudiencePreset(el, mode) {
  const inputId = mode === 'story' ? 'qv-story-audience-input' : 'qv-audience-input';
  const chipsId = mode === 'story' ? '#qv-story-audience-chips .el-chip' : '#qv-audience-chips .el-chip';
  document.getElementById(inputId).value = el.textContent;
  document.querySelectorAll(chipsId).forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
}

function qvUpdateMobileLabel() {
  // qv-mobile-hint element removed in redesign — nothing to update
}

let _qvSuggestedDuration = null;

async function qvGenerateScript() {
  const statusEl = document.getElementById('qv-gen-script-status');
  const btn = document.getElementById('qv-gen-script-btn');
  const showMobileScreen = document.getElementById('qv-show-mobile').checked;

  // Validate + build body based on mode
  let endpoint, body;
  if (_qvScriptType === 'story') {
    const audience = document.getElementById('qv-story-audience-input').value.trim();
    if (!_qvSelectedAngleId) {
      statusEl.textContent = '⚠ Select a marketing angle';
      statusEl.style.color = 'var(--red)';
      return;
    }
    endpoint = '/api/quickvid/generate-story-script';
    body = { angleId: _qvSelectedAngleId, audience: audience || '', duration: _qvScriptDur || 8, showMobileScreen };
  } else if (_qvScriptType === 'narrative') {
    const premise = document.getElementById('qv-narrative-premise').value.trim();
    endpoint = '/api/quickvid/generate-narrative-script';
    body = { premise: premise || '', angleId: _qvSelectedNarrativeAngleId || null, duration: _qvScriptDur || 15, showMobileScreen };
  } else if (_qvScriptType === 'streetinterview') {
    const hook = document.getElementById('qv-si-hook').value.trim();
    const location = document.getElementById('qv-si-location').value.trim();
    endpoint = '/api/quickvid/generate-streetinterview-script';
    body = { hook: hook || '', location: location || '', duration: _qvScriptDur || 12 };
  } else {
    const audience = document.getElementById('qv-audience-input').value.trim();
    const productPoint = document.getElementById('qv-product-point').value;
    endpoint = '/api/quickvid/generate-script';
    body = { audience: audience || '', productPoint, duration: _qvScriptDur || 8, showMobileScreen };
  }

  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = '⏳ Generating…';
  btn.disabled = true;
  document.getElementById('qv-suggested-dur-banner').style.display = 'none';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    const ta = document.getElementById('qv-prompt');
    ta.value = data.script;
    document.getElementById('qv-char-count').textContent = data.script.length;

    // Always show suggested duration when Claude returns one
    if (data.suggestedDuration) {
      _qvSuggestedDuration = data.suggestedDuration;
      document.getElementById('qv-suggested-dur-value').textContent = data.suggestedDuration;
      document.getElementById('qv-suggested-dur-banner').style.display = 'flex';
    }

    // Show ref hint for narrative mode when phone/gameplay is in the script
    const refBanner = document.getElementById('qv-ref-hint-banner');
    const refText = document.getElementById('qv-ref-hint-text');
    if (refBanner && refText) {
      if (data.refHint) {
        refText.textContent = data.refHint;
        refBanner.style.display = 'flex';
      } else {
        refBanner.style.display = 'none';
      }
    }

    statusEl.textContent = '✅ Done';
    statusEl.style.color = 'var(--green)';
    setTimeout(() => { qvToggleScriptPanel(); }, 400);
  } catch (e) {
    statusEl.textContent = '❌ ' + (e.message || 'Failed');
    statusEl.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

function qvApplySuggestedDuration() {
  if (!_qvSuggestedDuration) return;
  // Update the duration select
  const sel = document.getElementById('qv-duration-sel');
  if (sel) {
    sel.value = String(_qvSuggestedDuration);
    qvSetDurationSel(_qvSuggestedDuration);
  }
  // Hide the banner
  document.getElementById('qv-suggested-dur-banner').style.display = 'none';
  _qvSuggestedDuration = null;
}
let _qvOrient = 'portrait'; // 'portrait' | 'landscape'

function qvSetDuration(val, btn) {
  _qvDuration = val;
  document.querySelectorAll('#qv-duration-chips .el-chip').forEach(c => c.classList.remove('selected'));
  if (btn) btn.classList.add('selected');
}
function qvSetDurationSel(val) {
  _qvDuration = parseInt(val) || 8;
}

let _qvRefsOpen = false;
function qvToggleRefs() {
  _qvRefsOpen = !_qvRefsOpen;
  const panel = document.getElementById('qv-refs-panel');
  const btn = document.getElementById('qv-refs-toggle-btn');
  if (panel) panel.style.display = _qvRefsOpen ? 'block' : 'none';
  if (btn) {
    btn.style.borderColor = _qvRefsOpen ? 'var(--accent)' : 'var(--border)';
    btn.style.color = _qvRefsOpen ? 'var(--accent)' : 'var(--muted)';
  }
  // Lazy-load heroes when refs panel opens for the first time
  if (_qvRefsOpen) loadQuickVidHeroes();
}

async function loadQuickVidHeroes() {
  if (_qvHeroes.length > 0) return; // already loaded
  const grid = document.getElementById('qv-hero-grid');
  try {
    const res = await fetch('/api/hero-catalog');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _qvHeroes = data.heroes || [];
    renderQvHeroGrid();
  } catch (e) {
    grid.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px;grid-column:1/-1">Could not load heroes: ${e.message}</div>`;
  }
}

function renderQvHeroGrid() {
  const grid = document.getElementById('qv-hero-grid');
  if (!_qvHeroes.length) {
    grid.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px;grid-column:1/-1">No heroes in catalog.</div>';
    return;
  }
  grid.innerHTML = _qvHeroes.map(h => {
    const sel = _qvSelectedHeroes.has(h.name);
    const hasImages = h.images?.length > 0;
    const imgPreview = hasImages
      ? `<img src="${h.images[0]}" style="width:100%;height:60px;object-fit:cover;border-radius:4px;margin-bottom:4px;display:block" loading="lazy">`
      : `<div style="width:100%;height:60px;background:var(--border);border-radius:4px;margin-bottom:4px;display:flex;align-items:center;justify-content:center;font-size:18px">🦸</div>`;
    const noImgNote = !hasImages ? `<div style="font-size:9px;color:var(--yellow);margin-top:2px">No ref images</div>` : '';
    return `<div class="hero-catalog-item${sel ? ' selected' : ''}" onclick="qvToggleHero('${h.name.replace(/'/g,"\\'")}', this)" style="padding:8px">
      ${imgPreview}
      <div class="hc-name">${h.name}</div>
      <div class="hc-class">${h.class}</div>
      ${noImgNote}
    </div>`;
  }).join('');
}

function qvToggleHero(name, el) {
  if (_qvSelectedHeroes.has(name)) {
    _qvSelectedHeroes.delete(name);
    el.classList.remove('selected');
  } else {
    _qvSelectedHeroes.add(name);
    el.classList.add('selected');
  }
  // Update refs badge count
  const badge = document.getElementById('qv-refs-badge');
  if (badge) badge.textContent = _qvSelectedHeroes.size > 0 ? ` (${_qvSelectedHeroes.size})` : '';
}

function qvSetStatus(type, msg) {
  const box = document.getElementById('qv-status-box');
  box.style.display = 'block';
  box.style.background = type === 'error' ? 'rgba(239,68,68,0.15)'
    : type === 'success' ? 'rgba(34,197,94,0.15)'
    : 'rgba(124,58,237,0.12)';
  box.style.color = type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--text)';
  box.style.border = `1px solid ${type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--accent)'}`;
  box.textContent = msg;
}

function qvClearStatus() {
  const box = document.getElementById('qv-status-box');
  box.style.display = 'none';
  box.textContent = '';
}

function qvSetOrient(val, btn) {
  _qvOrient = val;
  document.querySelectorAll('#qv-orient-chips .el-chip').forEach(c => c.classList.remove('selected'));
  btn.classList.add('selected');
}

function qvAddExtraRefs() {
  const input = document.getElementById('qv-extra-refs-input');
  for (const f of input.files) {
    if (_qvExtraRefs.length >= 8) break;
    _qvExtraRefs.push({ file: f, name: f.name, thumbUrl: URL.createObjectURL(f) });
  }
  input.value = '';
  qvRenderExtraRefPills();
}

function qvRenderExtraRefPills() {
  const container = document.getElementById('qv-extra-refs-pills');
  const countEl = document.getElementById('qv-extra-refs-count');
  container.innerHTML = '';
  _qvExtraRefs.forEach((r, idx) => {
    const pill = document.createElement('div');
    pill.style.cssText = 'display:flex;align-items:center;gap:5px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:3px 8px 3px 4px;font-size:11px';
    pill.innerHTML = `<img src="${r.thumbUrl}" style="width:28px;height:28px;object-fit:cover;border-radius:5px" /><span style="max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.name.replace(/</g,'&lt;')}</span><span style="cursor:pointer;color:var(--muted);font-size:10px;margin-left:2px" onclick="qvRemoveExtraRef(${idx})">✕</span>`;
    container.appendChild(pill);
  });
  countEl.textContent = _qvExtraRefs.length ? `${_qvExtraRefs.length} image${_qvExtraRefs.length > 1 ? 's' : ''} selected` : '';
}

function qvRemoveExtraRef(idx) {
  _qvExtraRefs.splice(idx, 1);
  qvRenderExtraRefPills();
}

async function submitQuickVid() {
  const prompt = document.getElementById('qv-prompt').value.trim();
  if (!prompt) { qvSetStatus('error', '⚠ Please enter a script or prompt.'); return; }

  const btn = document.getElementById('qv-submit-btn');
  const spinner = document.getElementById('qv-spinner');
  const btnText = document.getElementById('qv-btn-text');

  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnText.textContent = 'Submitting…';
  document.getElementById('qv-result').style.display = 'none';
  qvSetStatus('info', '⏳ Submitting to Seedance 2.0…');

  const heroes = Array.from(_qvSelectedHeroes);

  try {
    const fd = new FormData();
    const negPrompt = document.getElementById('qv-negative-prompt').value.trim();
    fd.append('prompt', prompt);
    fd.append('duration', String(_qvDuration));
    fd.append('heroes', JSON.stringify(heroes));
    fd.append('orient', _qvOrient);
    if (negPrompt) fd.append('negativePrompt', negPrompt);
    for (const ref of _qvExtraRefs) fd.append('extraRefImages', ref.file);

    const res = await fetch('/api/quickvid', { method: 'POST', body: fd });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    _qvPendingTaskUUID = data.taskUUID;
    btnText.textContent = 'Generating…';
    qvSetStatus('info', '⏳ Generating video… this usually takes 30–90 seconds. You can switch tabs — we\'ll update when done.');

    // Start polling for completion
    qvStartPolling(data.taskUUID);

  } catch (err) {
    qvSetStatus('error', `❌ ${err.message}`);
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.textContent = '⚡ Generate Video';
  }
}

function qvStartPolling(taskUUID) {
  if (_qvPollTimer) clearInterval(_qvPollTimer);
  let attempts = 0;
  const MAX_ATTEMPTS = 120; // 10 min (120 × 5s)

  _qvPollTimer = setInterval(async () => {
    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      clearInterval(_qvPollTimer);
      _qvPollTimer = null;
      qvSetStatus('error', '❌ Timed out after 10 minutes. Check History tab for status.');
      qvResetBtn();
      return;
    }
    try {
      const res = await fetch('/api/history');
      if (!res.ok) return;
      const { history } = await res.json();
      const entry = history.find(e => e.taskUUID === taskUUID);
      if (!entry) return;

      if (entry.status === 'completed') {
        clearInterval(_qvPollTimer);
        _qvPollTimer = null;
        qvShowResult(entry);
        qvResetBtn();
      } else if (entry.status === 'failed') {
        clearInterval(_qvPollTimer);
        _qvPollTimer = null;
        qvSetStatus('error', `❌ Generation failed: ${entry.error || 'Unknown error'}`);
        qvResetBtn();
      }
      // still pending/processing — keep polling
    } catch (e) { /* network blip — retry next tick */ }
  }, 5000);
}

function qvShowResult(entry) {
  const video = document.getElementById('qv-video');
  const dl = document.getElementById('qv-download');
  const costBadge = document.getElementById('qv-cost-badge');
  const result = document.getElementById('qv-result');

  video.src = entry.videoUrl;
  dl.href = entry.videoUrl;
  dl.download = entry.filename || 'quickvid.mp4';
  costBadge.textContent = entry.cost != null ? `Cost: $${parseFloat(entry.cost).toFixed(4)}` : '';
  result.style.display = 'block';
  qvSetStatus('success', '✅ Video ready!');
  video.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function qvResetBtn() {
  const btn = document.getElementById('qv-submit-btn');
  const spinner = document.getElementById('qv-spinner');
  const btnText = document.getElementById('qv-btn-text');
  btn.disabled = false;
  spinner.style.display = 'none';
  btnText.textContent = '⚡ Generate Video';
}


const QV_SI_LOCATION_PRESETS = [
  "Busy sidewalk near a taco truck",
  "Bus stop bench, afternoon",
  "Park path near a coffee cart",
  "Outside a gym entrance",
  "Food court patio, lunch rush",
  "College campus steps",
  "Construction site break area",
  "Parking lot near a basketball court"
];

function qvBuildLocationChips() {
  const el = document.getElementById('qv-si-location-chips');
  if (el.dataset.built) return;
  el.innerHTML = QV_SI_LOCATION_PRESETS.map(p =>
    `<span class="el-chip" onclick="qvPickSiLocation(this)">${p}</span>`).join('');
  el.dataset.built = '1';
}

function qvPickSiLocation(el) {
  document.getElementById('qv-si-location').value = el.textContent;
  document.querySelectorAll('#qv-si-location-chips .el-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
}

// Load heroes + angles on startup since Quick Video is the default page
document.addEventListener('DOMContentLoaded', () => {
  loadQuickVidHeroes();
  // Load CTA folder images since Manual is now the default bridge mode
  loadBridgeCtaFolder();
  // Pre-load angles so they're ready when the Generate Script panel opens
  fetch('/api/marketing-angles').then(r => r.ok ? r.json() : null).then(data => {
    if (data?.angles?.length) {
      _qvAngles = data.angles;
      // If angle grids are already visible, render them
      if (document.getElementById('qv-angle-grid')) qvRenderAngleGrid();
      if (document.getElementById('qv-narrative-angle-grid')) qvRenderNarrativeAngleGrid();
    }
  }).catch(() => {});
});

// React to SSE task-complete for quickvid tasks even when on another tab
(function () {
  const origSSE = window.__sseInstance;
  // Hook into the existing SSE handler after it initialises (sse is set up before this script)
  // We listen on the already-initialised EventSource
  function hookSSE() {
    const sse = window.__sseInstance;
    if (!sse) return;
    sse.addEventListener('task-complete', (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === 'quickvid' && payload.taskUUID === _qvPendingTaskUUID) {
          if (_qvPollTimer) { clearInterval(_qvPollTimer); _qvPollTimer = null; }
          if (payload.status === 'completed' && payload.entry) {
            qvShowResult(payload.entry);
          } else if (payload.status === 'failed') {
            qvSetStatus('error', `❌ ${payload.error || 'Generation failed'}`);
          }
          qvResetBtn();
        }
      } catch {}
    });
  }
  // Run after page load so window.__sseInstance is set
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hookSSE);
  } else {
    hookSSE();
  }
})();
