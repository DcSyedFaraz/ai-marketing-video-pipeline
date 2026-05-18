// ══════ State ══════
let selectedModel = 'heygen:avatar@4';
let selectedBridgeModel = 'google:3@3';
let bridgeMusicFile = null; // { file } or { isUploadRef, serverPath, name } or null
let selectedLipSyncModel = 'pixverse:lipsync@1';
let selectedStoryModel = 'google:3@2';
let veoW = 1280, veoH = 720;
let historyFilter = 'all';
let autoPollInterval = null;
let storyPollInterval = null;
let activeStoryUUID = null;
let editingSceneIndex = null;
let models = [];
let storyModels = [];

const BRIDGE_MODELS = [
  { id: 'google:3@2',                    label: 'Google Veo 3.1',         provider: 'Google',  description: 'Best quality, cinematic transitions', cost: '~$0.20/sec',  badge: 'BEST',     allowedDurations: [4, 6, 8] },
  { id: 'google:3@3',                    label: 'Google Veo 3.1 Fast',    provider: 'Google',  description: 'Faster, slightly lower quality',       cost: '~$0.15/sec',  badge: null,       allowedDurations: [4, 6, 8] },
  { id: 'google:veo@3.1-lite',           label: 'Google Veo 3.1 Lite',    provider: 'Google',  description: 'Cost-effective, native audio, 4–8s',   cost: '$0.05–0.08/sec', badge: 'LITE',  allowedDurations: [4, 6, 8] },
  { id: 'klingai:kling-video@3-pro',     label: 'Kling 3.0 Pro',          provider: 'KlingAI', description: 'Top-tier quality, up to 15s',          cost: '$0.168/sec',  badge: 'PRO',      allowedDurations: [4, 6, 8, 10, 15] },
  { id: 'klingai:kling-video@3-standard',label: 'Kling 3.0 Standard',     provider: 'KlingAI', description: 'High quality, cost-effective, up to 15s', cost: '$0.126/sec', badge: 'NEW',    allowedDurations: [4, 6, 8, 10, 15] },
  { id: 'klingai:avatar@2.0-pro',        label: 'KlingAI 2.0 Pro',        provider: 'KlingAI', description: 'Smooth motion, high fidelity',          cost: '$0.087/sec',  badge: null,       allowedDurations: [4, 6, 8] },
  { id: 'klingai:avatar@2.0-standard',   label: 'KlingAI 2.0 Standard',   provider: 'KlingAI', description: 'Economical, good quality',              cost: '$0.044/sec',  badge: null,       allowedDurations: [4, 6, 8] },
];

const LIPSYNC_MODELS = [
  { id: 'pixverse:lipsync@1', label: 'PixVerse LipSync', provider: 'PixVerse', description: 'Fast, reliable lip-sync', cost: '~$0.05/sec', badge: null },
  { id: 'sync:lipsync-2-pro@1', label: 'Sync LipSync 2 Pro', provider: 'Sync', description: 'Studio-grade, 4K, preserves facial details', cost: '$0.073/sec', badge: 'PRO' },
];

// ══════ SSE — real-time task completion notifications ══════
(function initSSE() {
  const sse = new EventSource('/api/events');
  window.__sseInstance = sse;
  sse.addEventListener('server-log', ev => {
    try { const d = JSON.parse(ev.data); if (window.__logPanelReady) window.__logPanelReady(d.level, d.msg, d.ts); } catch {}
  });
  sse.addEventListener('task-complete', async (e) => {
    try {
      const payload = JSON.parse(e.data);
      console.log('[SSE] task-complete:', payload);
      if (payload.status === 'completed') {
        await loadHistory();
        await loadGallery();
        updatePendingBadge((await (await fetch('/api/history')).json()).history);
      } else if (payload.status === 'failed') {
        await loadHistory();
        updatePendingBadge((await (await fetch('/api/history')).json()).history);
      }
    } catch (err) {
      console.warn('[SSE] Error handling task-complete event:', err);
    }
  });
  sse.onerror = () => {
    console.warn('[SSE] Connection lost — browser will reconnect automatically.');
  };
})();

// ══════ Init ══════
async function init() {
  await Promise.all([loadModels(), loadStoryModels(), loadStoryGameContext()]);
  renderBridgeModelGrid();
  renderLipSyncModelGrid();
  onPipelineModeChange('standard');
  bridgeToggleMode();
  loadHistory();
  loadGallery();
  loadCombineVideos();
  loadStoryHistoryList();
  loadMarketingAngles();
  loadBridgePodcastVideos();
}

// ══════ Models ══════
async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    models = data.models;
    renderModelGrid();
    // Apply initial HeyGen section visibility based on default selected model
    const isHeyGenDefault = (models || []).find(m => m.id === selectedModel)?.isHeyGen;
    if (isHeyGenDefault) {
      document.getElementById('avatar-img-section').style.display = 'none';
      document.getElementById('gen-podcaster-section').style.display = 'none';
      document.getElementById('heygen-avatar-section').style.display = '';
      renderHeyGenAvatarGrid(selectedModel);
    }
  } catch {}
}

function renderModelGrid() {
  const grid = document.getElementById('model-grid');
  grid.innerHTML = models.map(m => `
    <label class="model-card ${m.id === selectedModel ? 'selected' : ''}" onclick="selectModel('${m.id}')">
      <input type="radio" name="model" value="${m.id}" ${m.id === selectedModel ? 'checked' : ''} />
      ${m.provider !== 'KlingAI' ? `<div class="model-card-provider">${m.provider}</div>` : `<div class="model-card-provider">${m.provider}</div>`}
      <div class="model-card-name">
        ${m.label.replace(m.provider + ' ', '')}
        ${m.badge ? `<span class="badge ${m.badge === 'PRO' ? 'badge-pro' : m.badge === 'NEW' ? 'badge-new' : 'badge-std'}">${m.badge}</span>` : ''}
      </div>
      <div class="model-card-desc">${m.description}</div>
      <div class="model-card-cost">${m.cost}</div>
    </label>
  `).join('');
}

let heygenSelectedAvatarId = null; // built-in avatar ID, null = none selected

function selectModel(id) {
  selectedModel = id;
  document.querySelectorAll('#model-grid .model-card').forEach(c => c.classList.remove('selected'));
  event.currentTarget.classList.add('selected');

  // Show/hide HeyGen vs standard image sections
  const isHeyGen = (models || []).find(m => m.id === id)?.isHeyGen;
  document.getElementById('avatar-img-section').style.display = isHeyGen ? 'none' : '';
  document.getElementById('gen-podcaster-section').style.display = isHeyGen ? 'none' : '';
  document.getElementById('heygen-avatar-section').style.display = isHeyGen ? '' : 'none';
  if (isHeyGen) renderHeyGenAvatarGrid(id);
}

function renderHeyGenAvatarGrid(modelId) {
  const m = (models || []).find(x => x.id === modelId);
  if (!m?.builtinAvatars) return;
  const grid = document.getElementById('heygen-builtin-grid');
  grid.innerHTML = m.builtinAvatars.map(a => `
    <div class="model-card ${heygenSelectedAvatarId === a.id ? 'selected' : ''}" onclick="selectHeyGenAvatar('${a.id}')" style="cursor:pointer;padding:8px 10px;min-height:unset">
      <div style="font-size:18px;text-align:center;margin-bottom:4px">🧑</div>
      <div style="font-size:10px;font-weight:600;text-align:center;line-height:1.3">${a.label}</div>
    </div>
  `).join('');
}

function selectHeyGenAvatar(id) {
  heygenSelectedAvatarId = id;
  document.querySelectorAll('#heygen-builtin-grid .model-card').forEach(c => c.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
}

function heygenHighlightRes() {
  const val = document.querySelector('input[name="heygen-res"]:checked')?.value || '1080x1920';
  const map = { '1080x1920': 'heygen-res-9-16', '1920x1080': 'heygen-res-16-9', '1280x720': 'heygen-res-hd-l', '720x1280': 'heygen-res-hd-p' };
  Object.entries(map).forEach(([v, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.borderColor = (v === val) ? 'var(--accent)' : 'var(--border)';
  });
}

function heygenToggleSource() {
  const val = document.querySelector('input[name="heygen-source"]:checked')?.value || 'builtin';
  const builtinOpt = document.getElementById('heygen-builtin-opt');
  const customOpt = document.getElementById('heygen-custom-opt');
  const builtinGrid = document.getElementById('heygen-builtin-grid');
  const customUpload = document.getElementById('heygen-custom-upload');
  if (val === 'builtin') {
    builtinOpt.style.borderColor = 'var(--accent)';
    customOpt.style.borderColor = 'var(--border)';
    builtinGrid.style.display = '';
    customUpload.style.display = 'none';
  } else {
    builtinOpt.style.borderColor = 'var(--border)';
    customOpt.style.borderColor = 'var(--accent)';
    builtinGrid.style.display = 'none';
    customUpload.style.display = '';
    heygenSelectedAvatarId = null;
    loadPodcastImagesForAvatar();
  }
}

function onHeyGenImagePick(input) {
  const file = input.files[0];
  if (!file) return;
  heygenSelectedServerImage = null;
  document.querySelectorAll('#heygen-podcast-img-grid .podcast-img-card').forEach(c => c.style.borderColor = 'var(--border)');
  const pill = document.getElementById('heygen-img-pill');
  document.getElementById('heygen-img-thumb').src = URL.createObjectURL(file);
  document.getElementById('heygen-img-name').textContent = file.name;
  document.getElementById('heygen-img-size').textContent = `${(file.size / 1024).toFixed(0)} KB`;
  pill.classList.add('show');
  document.getElementById('heygen-img-dz').style.display = 'none';
}

function clearHeyGenImage() {
  document.getElementById('heygen-img-input').value = '';
  document.getElementById('heygen-img-thumb').src = '';
  document.getElementById('heygen-img-pill').classList.remove('show');
  document.getElementById('heygen-img-dz').style.display = '';
  heygenSelectedServerImage = null;
  // deselect podcast image cards
  document.querySelectorAll('#heygen-podcast-img-grid .podcast-img-card').forEach(c => c.style.borderColor = 'var(--border)');
}

let heygenSelectedServerImage = null; // server path of selected podcast image

async function loadPodcastImagesForAvatar() {
  const grid = document.getElementById('heygen-podcast-img-grid');
  if (!grid) return;
  try {
    const cards = [];

    // AI-generated podcaster images (from this tab's generator)
    try {
      const vRes = await fetch('/api/podcaster-images');
      const vData = await vRes.json();
      (vData.images || []).forEach(img => {
        cards.push(`<div class="podcast-img-card" onclick="selectPodcastImageForAvatar('${img.url}', this)" style="cursor:pointer;border:2px solid var(--border);border-radius:8px;padding:4px;width:72px;text-align:center;transition:border-color .15s">
          <img src="${img.url}" style="width:64px;height:auto;border-radius:6px;display:block;margin:0 auto" />
          <div style="font-size:9px;color:var(--muted);margin-top:3px">🎙 AI</div>
        </div>`);
      });
    } catch {}

    // Podcast pipeline images
    try {
      const res = await fetch('/api/story-history');
      const data = await res.json();
      const podcasts = (data.history || []).filter(h => h.type === 'podcast' && h.scenes?.[0]?.imageStatus === 'completed' && h.scenes[0].imageThumbUrl);
      podcasts.forEach(p => {
        const sc = p.scenes[0];
        const genderCap = p.gender === 'girl' ? 'Girl' : 'Boy';
        const time = new Date(p.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        cards.push(`<div class="podcast-img-card" onclick="selectPodcastImageForAvatar('${sc.imageUrl}', this)" style="cursor:pointer;border:2px solid var(--border);border-radius:8px;padding:4px;width:72px;text-align:center;transition:border-color .15s">
          <img src="${sc.imageThumbUrl}" style="width:64px;height:auto;border-radius:6px;display:block;margin:0 auto" />
          <div style="font-size:9px;color:var(--muted);margin-top:3px">🎙 ${genderCap} · ${time}</div>
        </div>`);
      });
    } catch {}

    grid.innerHTML = cards.length
      ? cards.join('')
      : '<div style="font-size:11px;color:var(--muted)">No generated images yet</div>';
  } catch (e) { console.warn('loadPodcastImagesForAvatar:', e); }
}

function selectPodcastImageForAvatar(serverPath, el) {
  heygenSelectedServerImage = serverPath;
  // Clear file input since we're using a server image
  document.getElementById('heygen-img-input').value = '';
  document.getElementById('heygen-img-pill').classList.remove('show');
  document.getElementById('heygen-img-dz').style.display = '';
  // Highlight selected card
  document.querySelectorAll('#heygen-podcast-img-grid .podcast-img-card').forEach(c => c.style.borderColor = 'var(--border)');
  el.style.borderColor = 'var(--accent)';
  // Show pill with preview
  document.getElementById('heygen-img-thumb').src = serverPath;
  document.getElementById('heygen-img-name').textContent = 'Podcast image';
  document.getElementById('heygen-img-size').textContent = 'From history';
  document.getElementById('heygen-img-pill').classList.add('show');
  document.getElementById('heygen-img-dz').style.display = 'none';
}

// ── Generate Podcaster Image (Avatar tab) ─────────────────────────────────────
let genpiServerPath = null; // server path of last generated podcaster image

function toggleGenPodcasterPanel() {
  const panel = document.getElementById('gen-podcaster-panel');
  const btn = document.getElementById('gen-podcaster-toggle');
  const open = panel.style.display === 'none';
  panel.style.display = open ? '' : 'none';
  btn.textContent = open ? '− Close' : '＋ Generate';
}

function genpiHighlightGender() {
  const val = document.querySelector('input[name="genpi-gender"]:checked')?.value;
  document.getElementById('genpi-male-opt').style.borderColor = val === 'boy' ? 'var(--accent)' : 'var(--border)';
  document.getElementById('genpi-female-opt').style.borderColor = val === 'girl' ? 'var(--accent)' : 'var(--border)';
}

async function generatePodcasterImage() {
  const gender = document.querySelector('input[name="genpi-gender"]:checked')?.value || 'boy';
  const prompt = document.getElementById('genpi-prompt').value.trim();

  const btn = document.getElementById('btn-genpi');
  const spinner = document.getElementById('genpi-spinner');
  const btnText = document.getElementById('genpi-btn-text');
  const status = document.getElementById('genpi-status');
  const result = document.getElementById('genpi-result');

  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnText.textContent = 'Generating…';
  status.style.display = '';
  status.style.borderColor = 'var(--accent)';
  status.textContent = '⏳ Generating podcaster image (may take ~30s)…';
  result.style.display = 'none';
  genpiServerPath = null;

  try {
    const res = await fetch('/api/generate-podcaster-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gender, prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed.');

    genpiServerPath = data.serverPath;
    document.getElementById('genpi-img').src = data.imageUrl + '?t=' + Date.now();
    result.style.display = '';
    status.style.borderColor = 'var(--green)';
    status.textContent = `✅ Done${data.cost != null ? ' · cost $' + data.cost.toFixed(4) : ''}`;
    // Refresh HeyGen image grid immediately so the new image appears
    loadPodcastImagesForAvatar();
  } catch (err) {
    status.style.borderColor = 'var(--red)';
    status.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.textContent = '🎙 Generate Podcaster Image';
  }
}

function usePodcasterImage() {
  if (!genpiServerPath) return;
  // Set the server path as the portrait image source
  const imgUrl = document.getElementById('genpi-img').src;
  // Show pill in main portrait section
  document.getElementById('img-thumb').src = imgUrl;
  document.getElementById('img-name').textContent = 'Generated podcaster';
  document.getElementById('img-size').textContent = 'AI generated';
  document.getElementById('img-pill').classList.add('show');
  document.getElementById('img-dz').style.display = 'none';
  // Store server path so submitAvatar can use it
  window._avatarServerImagePath = genpiServerPath;
  // Close panel
  document.getElementById('gen-podcaster-panel').style.display = 'none';
  document.getElementById('gen-podcaster-toggle').textContent = '＋ Generate';
  // Refresh the HeyGen image grid too so the new image appears there
  loadPodcastImagesForAvatar();
}

// ── HeyGen inline podcaster image generator ───────────────────────────────────
function toggleHeygenGenPanel() {
  const panel = document.getElementById('heygen-gen-panel');
  const btn = document.getElementById('heygen-gen-toggle');
  const open = panel.style.display === 'none';
  panel.style.display = open ? '' : 'none';
  btn.textContent = open ? '− Close' : '＋ Generate';
}

function hgpiHighlightGender() {
  const val = document.querySelector('input[name="hgpi-gender"]:checked')?.value;
  document.getElementById('hgpi-male-opt').style.borderColor = val === 'boy' ? 'var(--accent)' : 'var(--border)';
  document.getElementById('hgpi-female-opt').style.borderColor = val === 'girl' ? 'var(--accent)' : 'var(--border)';
}

async function generateHeygenPodcasterImage() {
  const gender = document.querySelector('input[name="hgpi-gender"]:checked')?.value || 'boy';
  const btn = document.getElementById('btn-hgpi');
  const spinner = document.getElementById('hgpi-spinner');
  const btnText = document.getElementById('hgpi-btn-text');
  const status = document.getElementById('hgpi-status');

  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnText.textContent = 'Generating…';
  status.style.display = '';
  status.style.borderColor = 'var(--accent)';
  status.textContent = '⏳ Generating (~30s)…';

  try {
    const res = await fetch('/api/generate-podcaster-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gender }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed.');

    status.style.borderColor = 'var(--green)';
    status.textContent = `✅ Done${data.cost != null ? ' · $' + data.cost.toFixed(4) : ''} — select below`;
    // Reload grid to show the new image
    await loadPodcastImagesForAvatar();
    // Auto-select the newly generated image
    const firstCard = document.querySelector('#heygen-podcast-img-grid .podcast-img-card');
    if (firstCard) firstCard.click();
    // Collapse the panel
    document.getElementById('heygen-gen-panel').style.display = 'none';
    document.getElementById('heygen-gen-toggle').textContent = '＋ Generate';
  } catch (err) {
    status.style.borderColor = 'var(--red)';
    status.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.textContent = '🎙 Generate Image';
  }
}

function renderBridgeModelGrid() {
  const grid = document.getElementById('bridge-model-grid');
  grid.innerHTML = BRIDGE_MODELS.map(m => `
    <label class="model-card ${m.id === selectedBridgeModel ? 'selected' : ''}" onclick="selectBridgeModel('${m.id}')">
      <input type="radio" name="bridge-model" value="${m.id}" ${m.id === selectedBridgeModel ? 'checked' : ''} />
      <div class="model-card-provider">${m.provider}</div>
      <div class="model-card-name">
        ${m.label.replace(m.provider + ' ', '')}
        ${m.badge ? `<span class="badge ${m.badge === 'BEST' ? 'badge-pro' : m.badge === 'PRO' ? 'badge-pro' : 'badge-std'}">${m.badge}</span>` : ''}
      </div>
      <div class="model-card-desc">${m.description}</div>
      <div class="model-card-cost">${m.cost}</div>
    </label>
  `).join('');
  updateBridgeDurations(selectedBridgeModel);
}

function selectBridgeModel(id) {
  selectedBridgeModel = id;
  document.querySelectorAll('#bridge-model-grid .model-card').forEach(c => c.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  updateBridgeDurations(id);
}

function updateBridgeDurations(modelId) {
  const m = BRIDGE_MODELS.find(x => x.id === modelId);
  const allowed = m?.allowedDurations || [4, 6, 8];
  const labels = { 4: '4 seconds', 6: '6 seconds', 8: '8 seconds', 10: '10 seconds', 15: '15 seconds' };
  const sel = document.getElementById('bridge-duration');
  if (!sel) return;
  const cur = parseInt(sel.value);
  sel.innerHTML = allowed.map(d => `<option value="${d}"${d === cur ? ' selected' : ''}>${labels[d]}</option>`).join('');
  if (!allowed.includes(cur)) sel.value = String(allowed[0]);
}

function renderLipSyncModelGrid() {
  const grid = document.getElementById('lipsync-model-grid');
  grid.innerHTML = LIPSYNC_MODELS.map(m => `
    <label class="model-card ${m.id === selectedLipSyncModel ? 'selected' : ''}" onclick="selectLipSyncModel('${m.id}')">
      <input type="radio" name="lipsync-model" value="${m.id}" ${m.id === selectedLipSyncModel ? 'checked' : ''} />
      <div class="model-card-provider">${m.provider}</div>
      <div class="model-card-name">
        ${m.label.replace(m.provider + ' ', '')}
        ${m.badge ? `<span class="badge badge-pro">${m.badge}</span>` : ''}
      </div>
      <div class="model-card-desc">${m.description}</div>
      <div class="model-card-cost">${m.cost}</div>
    </label>
  `).join('');
}

function selectLipSyncModel(id) {
  selectedLipSyncModel = id;
  document.querySelectorAll('#lipsync-model-grid .model-card').forEach(c => c.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
}

// ══════ Pages ══════
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
  event.target.classList.add('active');
  if (name === 'combine') loadCombineVideos();
  if (name === 'history') loadHistory();
  if (name === 'gallery') loadGallery();
  if (name === 'story') loadStoryHistoryList();
  if (name === 'bridge') loadBridgePodcastVideos();
  if (name === 'splitscreen') { /* nothing to preload */ }
  if (name === 'quickvid') loadQuickVidHeroes();
}

function openCanvas() {
  // If a story is currently active in the Story tab, pass its UUID to the canvas
  const uuid = typeof activeStoryUUID !== 'undefined' && activeStoryUUID ? activeStoryUUID : '';
  const url = uuid ? `/canvas.html?uuid=${uuid}` : '/canvas.html';
  window.open(url, '_blank');
}

// ══════ Dropzones ══════
function setupDropzone(inputId, dzId, pillId, nameId, sizeId, thumbId, type) {
  const input = document.getElementById(inputId);
  const dz = document.getElementById(dzId);
  input.addEventListener('change', () => handleFile(input, pillId, nameId, sizeId, thumbId, type));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('over');
    if (e.dataTransfer.files[0]) { input.files = e.dataTransfer.files; handleFile(input, pillId, nameId, sizeId, thumbId, type); }
  });
}

function handleFile(input, pillId, nameId, sizeId, thumbId, type) {
  const file = input.files[0]; if (!file) return;
  document.getElementById(nameId).textContent = file.name;
  document.getElementById(sizeId).textContent = fmtSize(file.size);
  document.getElementById(pillId).classList.add('show');
  if (thumbId) { const r = new FileReader(); r.onload = e => document.getElementById(thumbId).src = e.target.result; r.readAsDataURL(file); }
  if (input.id === 'img-input') window._avatarServerImagePath = null;
}

function clearFile(prefix) {
  document.getElementById(`${prefix}-input`).value = '';
  document.getElementById(`${prefix}-pill`).classList.remove('show');
  if (prefix === 'img') {
    document.getElementById('img-thumb').src = '';
    document.getElementById('img-dz').style.display = '';
    window._avatarServerImagePath = null;
  }
}

function fmtSize(b) { return b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB'; }

// ══════ ElevenLabs Audio Generation ══════
// State
let elVoices = [];           // full voice list from API
let elSelectedVoiceId = '';  // currently selected voice ID
let elSelectedVoiceName = '';
let elGeneratedAudioPath = ''; // server path to generated audio (/uploads/xxx.mp3)
let elCurrentPreviewAudio = null; // playing preview Audio object
let elChipState = { type: 'game', dur: '30', pace: 'natural', energy: 'moderate' };
let elSelectedAngleId = null;       // number | null
let _elMarketingAngles = [];        // cached angle list for EL panel
let elSpeedMultiplier = 1.0;        // FFmpeg post-processing speed (1×, 1.25×, 1.5×)

function elToggleAudioSource(source) {
  document.getElementById('el-tab-upload').classList.toggle('active', source === 'upload');
  document.getElementById('el-tab-generate').classList.toggle('active', source === 'generate');
  document.getElementById('el-panel-upload').classList.toggle('active', source === 'upload');
  document.getElementById('el-panel-generate').classList.toggle('active', source === 'generate');
  if (source === 'generate' && elVoices.length === 0) elLoadVoices();
  if (source === 'generate' && _elMarketingAngles.length === 0) elLoadAngles();
}

function elSelectChip(group, el) {
  // Deselect siblings in same chip group
  const groupMap = { type: 'el-type-chips', dur: 'el-dur-chips', pace: 'el-pace-chips', energy: 'el-energy-chips' };
  document.getElementById(groupMap[group])?.querySelectorAll('.el-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  elChipState[group] = el.dataset.val;
  if (group === 'dur') {
    const wrap = document.getElementById('el-custom-dur-wrap');
    if (el.dataset.val === 'custom') {
      wrap.style.display = 'flex';
      const input = document.getElementById('el-custom-dur');
      if (input.value) elChipState.dur = input.value;
    } else {
      wrap.style.display = 'none';
    }
  }
  elUpdateWordCount();
}

function elOnCustomDur(input) {
  const val = parseInt(input.value);
  if (val >= 5) { elChipState.dur = String(val); elUpdateWordCount(); }
}

function elSelectVersion(ver) {
  document.getElementById('el-ver-v2-opt').classList.toggle('selected', ver === 'v2');
  document.getElementById('el-ver-v3-opt').classList.toggle('selected', ver === 'v3');
  document.querySelector(`input[name="el-version"][value="${ver}"]`).checked = true;
  // Show/hide style slider (v3 only)
  document.getElementById('el-style-row').style.display = ver === 'v3' ? 'block' : 'none';
}

function elGetVersion() {
  return document.querySelector('input[name="el-version"]:checked')?.value || 'v2';
}

async function elLoadAngles() {
  try {
    const res = await fetch('/api/marketing-angles');
    if (!res.ok) return;
    const data = await res.json();
    _elMarketingAngles = data.angles || [];
    elRenderAngles(_elMarketingAngles);
  } catch (e) {
    const grid = document.getElementById('el-angle-grid');
    if (grid) grid.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:4px;grid-column:1/-1">Angles unavailable.</div>';
  }
}

function elRenderAngles(angles) {
  const grid = document.getElementById('el-angle-grid');
  if (!grid) return;
  if (!angles.length) {
    grid.innerHTML = '<div style="color:var(--muted);font-size:12px;grid-column:1/-1">No angles found.</div>';
    return;
  }
  grid.innerHTML = angles.map(a => {
    const statusClass = a.status === 'in_pipeline' ? 'in-pipeline' : a.status === 'untested_gap' ? 'untested-gap' : 'untested';
    const statusLabel = a.status === 'in_pipeline' ? '▶ In Pipeline' : a.status === 'untested_gap' ? `★ Gap (P${a.test_priority})` : '○ Untested';
    return `<div class="angle-card" id="el-angle-card-${a.id}" onclick="elSelectAngle(${a.id})">
      <div class="angle-card-name">${a.name}</div>
      <div class="angle-card-msg">${a.core_message}</div>
      <div class="angle-card-status ${statusClass}">${statusLabel}</div>
    </div>`;
  }).join('');
}

function elSelectAngle(id) {
  elSelectedAngleId = id;

  // Toggle "None" chip
  document.getElementById('el-angle-none-opt')?.classList.toggle('selected', id === null);

  // Toggle angle cards (scoped to EL grid only)
  document.querySelectorAll('#el-angle-grid .angle-card').forEach(c => c.classList.remove('selected'));
  if (id !== null) {
    document.getElementById(`el-angle-card-${id}`)?.classList.add('selected');
  }

  // Update topic field hint and required marker
  const topicReq  = document.getElementById('el-topic-req');
  const topicHint = document.getElementById('el-topic-hint');
  const topicTA   = document.getElementById('el-topic');
  if (id !== null) {
    if (topicReq)  topicReq.style.display  = 'none';
    if (topicHint) topicHint.style.display = 'inline';
    // Pre-fill with core_message only if textarea is currently empty
    const angle = _elMarketingAngles.find(a => a.id === id);
    if (angle && topicTA && !topicTA.value.trim()) {
      topicTA.value = angle.core_message;
    }
  } else {
    if (topicReq)  topicReq.style.display  = '';
    if (topicHint) topicHint.style.display = 'none';
  }
}

const EL_WPM = { slow: 100, natural: 130, fast: 160 };

function elUpdateWordCount() {
  const script = document.getElementById('el-script').value;
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  const wpm = EL_WPM[elChipState.pace] || 130;
  const estSec = words > 0 ? Math.round((words / wpm) * 60) : 0;
  const targetSec = parseInt(elChipState.dur) || 30;
  const budget = Math.round((targetSec / 60) * wpm);
  const el = document.getElementById('el-word-count');
  el.textContent = `${words} words · ~${estSec}s estimated (budget: ${budget} words for ${targetSec}s)`;
  el.classList.toggle('over', words > budget + 5);
}

async function elGenerateScript() {
  const topic   = document.getElementById('el-topic').value.trim();
  const angleId = elSelectedAngleId;
  if (!topic && angleId === null) {
    alert('Please enter a topic or select a marketing angle.');
    return;
  }
  const btn = document.getElementById('el-gen-script-btn');
  const spinner = document.getElementById('el-script-spinner');
  const btnText = document.getElementById('el-script-btn-text');
  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnText.textContent = 'Generating…';

  try {
    const res = await fetch('/api/elevenlabs/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentType: elChipState.type,
        topic,
        angleId,
        duration: elChipState.dur,
        pacing: elChipState.pace,
        energy: elChipState.energy,
        apiVersion: elGetVersion(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Script generation failed');
    document.getElementById('el-script').value = data.script;
    elUpdateWordCount();
    document.getElementById('el-step1-num').classList.add('done');
  } catch (err) {
    alert(`Script generation failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.textContent = '✨ Generate Script with Claude';
  }
}

async function elLoadVoices() {
  document.getElementById('el-voice-loading').style.display = 'block';
  document.getElementById('el-voice-grid').innerHTML = '';
  document.getElementById('el-voice-none').style.display = 'none';
  document.getElementById('el-reload-voices-btn').disabled = true;
  try {
    const res = await fetch('/api/elevenlabs/voices');
    const data = await res.json();
    if (data.error && (!data.voices || data.voices.length === 0)) {
      document.getElementById('el-voice-grid').innerHTML = `<div style="font-size:12px;color:var(--red);padding:6px 0">⚠ ${data.error}</div>`;
      return;
    }
    elVoices = data.voices || [];
    elRenderVoices('young-girl');
  } catch (err) {
    document.getElementById('el-voice-grid').innerHTML = `<div style="font-size:12px;color:var(--red);padding:6px 0">Failed to load voices: ${err.message}</div>`;
  } finally {
    document.getElementById('el-voice-loading').style.display = 'none';
    document.getElementById('el-reload-voices-btn').disabled = false;
  }
}

function elFilterVoices(filter, chipEl) {
  document.getElementById('el-voice-filters').querySelectorAll('.el-chip').forEach(c => c.classList.remove('selected'));
  chipEl.classList.add('selected');
  elRenderVoices(filter);
}

function elRenderVoices(filter) {
  const grid = document.getElementById('el-voice-grid');
  const filtered = filter === 'all' ? elVoices : elVoices.filter(v => {
    if (filter === 'young')      return v.age === 'young';
    if (filter === 'young-girl') return v.age === 'young' && v.gender === 'female';
    if (filter === 'young-boy')  return v.age === 'young' && v.gender === 'male';
    if (filter === 'female')    return v.gender === 'female';
    if (filter === 'male')      return v.gender === 'male';
    if (filter === 'energetic') return v.description.includes('energetic') || v.description.includes('strong') || v.description.includes('lively');
    if (filter === 'podcast')   return v.useCase.includes('podcast') || v.useCase.includes('conversational') || v.useCase.includes('news');
    if (filter === 'gaming')    return v.useCase.includes('gaming') || v.useCase.includes('video_games') || v.useCase.includes('entertainment');
    return true;
  });

  document.getElementById('el-voice-none').style.display = filtered.length === 0 ? 'block' : 'none';
  grid.innerHTML = filtered.map(v => `
    <div class="el-voice-card${v.voiceId === elSelectedVoiceId ? ' selected' : ''}" id="el-vc-${v.voiceId}" onclick="elSelectVoice('${v.voiceId}','${v.name.replace(/'/g,'\\\'')}')" >
      <div class="el-voice-name">${v.name}</div>
      <div class="el-voice-badges">
        ${v.gender ? `<span class="el-voice-badge evb-${v.gender}">${v.gender}</span>` : ''}
        ${v.age    ? `<span class="el-voice-badge evb-${v.age}">${v.age.replace('_',' ')}</span>` : ''}
      </div>
      <div class="el-voice-desc">${v.description || v.useCase || ''}</div>
      ${v.previewUrl ? `<button class="el-voice-preview" id="el-prev-${v.voiceId}" data-url="${v.previewUrl.replace(/"/g,'&quot;')}" onclick="event.stopPropagation();elPreviewVoice('${v.voiceId}',this.dataset.url)">▶ Preview</button>` : ''}
    </div>
  `).join('');
}

function elSelectVoice(voiceId, voiceName) {
  elSelectedVoiceId = voiceId;
  elSelectedVoiceName = voiceName;
  document.querySelectorAll('.el-voice-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById(`el-vc-${voiceId}`);
  if (card) card.classList.add('selected');
  document.getElementById('el-step2-num').classList.add('done');
}

function elPreviewVoice(voiceId, previewUrl) {
  // Stop any currently playing preview
  if (elCurrentPreviewAudio) {
    elCurrentPreviewAudio.pause();
    elCurrentPreviewAudio = null;
  }
  // Reset all preview buttons
  document.querySelectorAll('.el-voice-preview').forEach(btn => {
    btn.classList.remove('playing');
    btn.textContent = '▶ Preview';
  });

  const btn = document.getElementById(`el-prev-${voiceId}`);
  const audio = new Audio(previewUrl);
  elCurrentPreviewAudio = audio;
  audio.play().then(() => {
    if (btn) { btn.classList.add('playing'); btn.textContent = '⏹ Stop'; }
    audio.onended = () => {
      if (btn) { btn.classList.remove('playing'); btn.textContent = '▶ Preview'; }
      elCurrentPreviewAudio = null;
    };
  }).catch(() => {
    if (btn) btn.textContent = '✗ Preview N/A';
  });
}

async function elGenerateAudio() {
  const script = document.getElementById('el-script').value.trim();
  if (!script) { alert('Please generate or write a script first (Step 1).'); return; }
  if (!elSelectedVoiceId) { alert('Please select a voice (Step 2).'); return; }

  const btn = document.getElementById('el-gen-audio-btn');
  const spinner = document.getElementById('el-audio-spinner');
  const btnText = document.getElementById('el-audio-btn-text');
  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnText.textContent = 'Generating…';

  const preview = document.getElementById('el-audio-preview');
  preview.classList.remove('show');
  document.getElementById('el-use-audio-wrap').style.display = 'none';

  try {
    const ver = elGetVersion();
    const res = await fetch('/api/elevenlabs/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script,
        voiceId: elSelectedVoiceId,
        apiVersion: ver,
        stability:      parseInt(document.getElementById('el-stability').value) / 100,
        similarityBoost:parseInt(document.getElementById('el-similarity').value) / 100,
        style:          parseInt(document.getElementById('el-style').value) / 100,
        speed:          parseInt(document.getElementById('el-speed').value) / 100,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Audio generation failed');

    elGeneratedAudioPath = data.audioPath;
    preview.src = data.audioPath;
    preview.classList.add('show');
    document.getElementById('el-use-audio-wrap').style.display = 'block';
    document.getElementById('el-speed-enhance-wrap').style.display = 'block';
    document.getElementById('el-step3-num').classList.add('done');
    // Reset speed chip to Normal on each new generation
    document.querySelectorAll('#el-speed-chips .el-chip').forEach(c => c.classList.remove('selected'));
    document.querySelector('#el-speed-chips .el-chip[data-val="1.0"]')?.classList.add('selected');
    elSpeedMultiplier = 1.0;
    document.getElementById('el-speed-status').style.display = 'none';
  } catch (err) {
    alert(`Audio generation failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.textContent = '🔊 Generate Audio';
  }
}

function elUseGeneratedAudio() {
  if (!elGeneratedAudioPath) return;
  const filename = elGeneratedAudioPath.split('/').pop();
  document.getElementById('el-confirmed-name').textContent = `${elSelectedVoiceName || 'ElevenLabs'} — ${filename}`;
  document.getElementById('el-confirmed-desc').textContent = 'Ready for avatar generation';
  document.getElementById('el-audio-confirmed').classList.add('show');
}

function elClearGeneratedAudio() {
  elGeneratedAudioPath = '';
  document.getElementById('el-audio-confirmed').classList.remove('show');
  document.getElementById('el-audio-preview').classList.remove('show');
  document.getElementById('el-use-audio-wrap').style.display = 'none';
  document.getElementById('el-speed-enhance-wrap').style.display = 'none';
  document.getElementById('el-step3-num').classList.remove('done');
  // Reset speed chip to Normal
  document.querySelectorAll('#el-speed-chips .el-chip').forEach(c => c.classList.remove('selected'));
  document.querySelector('#el-speed-chips .el-chip[data-val="1.0"]')?.classList.add('selected');
  elSpeedMultiplier = 1.0;
}

function elSelectSpeedChip(el) {
  document.querySelectorAll('#el-speed-chips .el-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  elSpeedMultiplier = parseFloat(el.dataset.val);
  document.getElementById('el-speed-status').style.display = 'none';
}

async function elApplySpeed() {
  if (!elGeneratedAudioPath) return;

  const btn     = document.getElementById('el-apply-speed-btn');
  const spinner = document.getElementById('el-speed-spinner');
  const status  = document.getElementById('el-speed-status');

  if (Math.abs(elSpeedMultiplier - 1.0) < 0.001) {
    status.textContent = 'Already at 1× — no change needed.';
    status.style.display = 'block';
    return;
  }

  btn.disabled = true;
  spinner.style.display = 'inline-block';
  status.style.display = 'none';

  try {
    const res = await fetch('/api/elevenlabs/speed-enhance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioPath: elGeneratedAudioPath, speed: elSpeedMultiplier }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Speed enhancement failed');

    elGeneratedAudioPath = data.audioPath;
    const preview = document.getElementById('el-audio-preview');
    preview.src = data.audioPath + '?t=' + Date.now();
    preview.load();

    status.textContent = `✅ Applied ${elSpeedMultiplier}× speed — preview updated.`;
    status.style.color = 'var(--green)';
    status.style.display = 'block';
  } catch (err) {
    status.textContent = `⚠ ${err.message}`;
    status.style.color = 'var(--red)';
    status.style.display = 'block';
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
  }
}

// ══════ Avatar submit ══════
async function submitAvatar() {
  const prompt = document.getElementById('avatar-prompt').value.trim();
  const isHeyGen = (models || []).find(m => m.id === selectedModel)?.isHeyGen;

  // Determine audio source
  const audioSource = document.getElementById('el-panel-generate').classList.contains('active') ? 'generate' : 'upload';
  if (audioSource === 'upload') {
    const aud = document.getElementById('aud-input').files[0];
    if (!aud) { setStatus('avatar','error','⚠ Please select an audio file.'); return; }
  } else {
    if (!elGeneratedAudioPath) { setStatus('avatar','error','⚠ Please generate audio using ElevenLabs (complete Steps 1–3) and click "Use This Audio".'); return; }
  }

  if (isHeyGen) {
    const heygenSource = document.querySelector('input[name="heygen-source"]:checked')?.value || 'builtin';
    if (heygenSource === 'builtin' && !heygenSelectedAvatarId) {
      setStatus('avatar','error','⚠ Please select a built-in avatar from the grid.'); return;
    }
    if (heygenSource === 'custom' && !document.getElementById('heygen-img-input').files[0] && !heygenSelectedServerImage) {
      setStatus('avatar','error','⚠ Please upload a custom portrait image or select a podcast image.'); return;
    }
  } else {
    const img = document.getElementById('img-input').files[0];
    if (!img && !window._avatarServerImagePath) { setStatus('avatar','error','⚠ Please select or generate a portrait image.'); return; }
  }

  setBtnLoading('avatar', true);
  setStatus('avatar','loading','⏳ Uploading and submitting...');
  hideResult('avatar');

  const fd = new FormData();
  fd.append('model', selectedModel);
  if (audioSource === 'upload') {
    fd.append('audio', document.getElementById('aud-input').files[0]);
  } else {
    fd.append('audioServerPath', elGeneratedAudioPath);
  }
  if (prompt) fd.append('prompt', prompt);

  if (isHeyGen) {
    const heygenSource = document.querySelector('input[name="heygen-source"]:checked')?.value || 'builtin';
    if (heygenSource === 'builtin') {
      fd.append('heygenAvatarId', heygenSelectedAvatarId);
    } else if (heygenSelectedServerImage) {
      fd.append('imageServerPath', heygenSelectedServerImage);
    } else {
      fd.append('image', document.getElementById('heygen-img-input').files[0]);
    }
    const heygenRes = document.querySelector('input[name="heygen-res"]:checked')?.value || '1080x1920';
    fd.append('resolution', heygenRes);
  } else if (window._avatarServerImagePath) {
    fd.append('imageServerPath', window._avatarServerImagePath);
  } else {
    fd.append('image', document.getElementById('img-input').files[0]);
  }

  try {
    const res = await fetch('/api/generate-avatar', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submission failed.');

    setStatus('avatar', 'pending',
      `✅ Task submitted! taskUUID: ${data.taskUUID}\n🔄 Generation running in background — check History tab for progress.`);
    document.getElementById('avatar-prog').style.display = 'none';

    // refresh history badge
    setTimeout(() => { loadHistory(); updatePendingBadge(); }, 500);

  } catch (err) {
    setStatus('avatar','error',`❌ ${err.message}`);
  } finally {
    setBtnLoading('avatar', false);
  }
}

// ══════ LipSync submit ══════
async function submitLipSync() {
  const vid = document.getElementById('ls-vid-input').files[0];
  const aud = document.getElementById('ls-aud-input').files[0];
  const status = document.getElementById('lipsync-status');

  if (!vid) { status.style.display='block'; status.className='status-box error'; status.textContent='⚠ Please select a video file.'; return; }
  if (!aud) { status.style.display='block'; status.className='status-box error'; status.textContent='⚠ Please select an audio file.'; return; }

  const btn = document.getElementById('lipsync-btn');
  btn.disabled = true; btn.textContent = '⏳ Submitting…';
  status.style.display = 'block'; status.className = 'status-box loading';
  status.textContent = '⏳ Uploading and submitting…';
  document.getElementById('lipsync-result').classList.remove('show');

  const fd = new FormData();
  fd.append('video', vid);
  fd.append('audio', aud);
  fd.append('model', selectedLipSyncModel);

  try {
    const res = await fetch('/api/generate-lipsync', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submission failed.');
    status.className = 'status-box pending';
    status.textContent = `✅ Task submitted! taskUUID: ${data.taskUUID}\n🔄 Processing — check History tab for progress.`;
    setTimeout(() => { loadHistory(); updatePendingBadge(); }, 500);
  } catch (err) {
    status.className = 'status-box error'; status.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false; btn.textContent = '👄 Generate LipSync Video';
  }
}

// ══════ Bridge submit ══════
let bridgeSelectedPodcastPath = null; // server-side path of selected podcast video

function bridgeOrientChange() {
  const val = document.querySelector('input[name="bridge-orient"]:checked')?.value || 'portrait';
  document.getElementById('bridge-orient-portrait-lbl').style.borderColor = val === 'portrait' ? 'var(--accent)' : 'var(--border)';
  document.getElementById('bridge-orient-landscape-lbl').style.borderColor = val === 'landscape' ? 'var(--accent)' : 'var(--border)';
}
// Init highlight
document.addEventListener('DOMContentLoaded', bridgeOrientChange);

async function loadBridgePodcastVideos() {
  const sel = document.getElementById('bridge-podcast-pick');
  if (!sel) return;
  try {
    // Load podcast videos from story history
    const [storyRes, histRes] = await Promise.all([
      fetch('/api/story-history'),
      fetch('/api/history'),
    ]);
    const storyData = storyRes.ok ? await storyRes.json() : { history: [] };
    const histData  = histRes.ok  ? await histRes.json()  : [];

    // Podcast entries
    const podcasts = (storyData.history || []).filter(h => h.type === 'podcast' && h.status === 'completed' && h.finalVideoUrl);
    // Avatar entries from the regular history array
    const histList = Array.isArray(histData) ? histData : (histData.history || []);
    const avatars  = histList.filter(h => h.type === 'avatar' && h.status === 'completed' && h.videoUrl);

    let opts = '<option value="">🎬 Select from generated videos (optional)…</option>';

    if (podcasts.length) {
      opts += '<optgroup label="🎙 Podcast Videos">';
      opts += podcasts.map(h => {
        const date  = new Date(h.submittedAt).toLocaleDateString();
        const label = `🎙 ${h.gender || ''} · ${h.marketingAngle || ''} · ${date}`.trim().replace(/^· |· $/g, '');
        const diskPath = h.finalVideoUrl.replace(/^\//, '');
        return `<option value="${diskPath}" data-type="podcast" data-url="${h.finalVideoUrl}" data-label="${label.replace(/"/g,'&quot;')}">${label}</option>`;
      }).join('');
      opts += '</optgroup>';
    }

    if (avatars.length) {
      opts += '<optgroup label="🎭 Avatar Videos">';
      opts += avatars.map(h => {
        const date  = new Date(h.submittedAt).toLocaleDateString();
        const model = h.modelLabel || h.model || 'Avatar';
        const label = `🎭 ${model} · ${date}`;
        const diskPath = h.videoUrl.replace(/^\//, '');
        return `<option value="${diskPath}" data-type="avatar" data-url="${h.videoUrl}" data-label="${label.replace(/"/g,'&quot;')}">${label}</option>`;
      }).join('');
      opts += '</optgroup>';
    }

    sel.innerHTML = opts;
  } catch {}
}

function onBridgePodcastPick() {
  const sel = document.getElementById('bridge-podcast-pick');
  const val = sel?.value;
  if (!val) { clearBridgePodcastPick(); return; }

  bridgeSelectedPodcastPath = val;
  const opt    = sel.options[sel.selectedIndex];
  const label  = opt?.dataset?.label || val;
  const type   = opt?.dataset?.type  || 'video';
  const vidUrl = opt?.dataset?.url   || ('/' + val);

  // Show pill with type-specific icon
  const icon = type === 'avatar' ? '🎭' : '🎙';
  const typeLabel = type === 'avatar' ? 'Avatar video (server path)' : 'Podcast video (server path)';
  document.getElementById('bridge-podcast-pill-icon').textContent = icon;
  document.getElementById('bridge-podcast-pill-name').textContent = label;
  document.getElementById('bridge-podcast-pill-type').textContent = typeLabel;
  document.getElementById('bridge-podcast-pill').style.display = 'flex';

  // Show inline video preview
  const previewWrap  = document.getElementById('bridge-server-vid-preview');
  const previewVideo = document.getElementById('bridge-server-vid-player');
  const previewInfo  = document.getElementById('bridge-server-vid-info');
  previewVideo.src = vidUrl;
  previewInfo.textContent = label;
  previewWrap.style.display = 'block';

  // Clear file input pill
  document.getElementById('bvid-pill').classList.remove('show');
  document.getElementById('bvid-input').value = '';
}

function clearBridgePodcastPick() {
  bridgeSelectedPodcastPath = null;
  document.getElementById('bridge-podcast-pick').value = '';
  document.getElementById('bridge-podcast-pill').style.display = 'none';
  document.getElementById('bridge-server-vid-preview').style.display = 'none';
  const previewVideo = document.getElementById('bridge-server-vid-player');
  if (previewVideo) { previewVideo.pause(); previewVideo.src = ''; }
}

function onBridgeFileChange() {
  // If user picks a file, clear server-path selection and preview
  if (document.getElementById('bvid-input').files[0]) {
    clearBridgePodcastPick();
  }
}

function clearBridgeVideo() {
  clearFile('bvid');
  clearBridgePodcastPick();
}

function bridgeToggleMode() {
  const mode = document.querySelector('input[name="bridge-mode"]:checked')?.value || 'auto';
  const ctaSection = document.getElementById('bridge-cta-section');
  const autoOpt = document.getElementById('bridge-mode-auto-opt');
  const manualOpt = document.getElementById('bridge-mode-manual-opt');
  if (mode === 'auto') {
    if (ctaSection) ctaSection.style.display = 'none';
    if (autoOpt) autoOpt.style.borderColor = 'var(--accent)';
    if (manualOpt) manualOpt.style.borderColor = 'var(--border)';
  } else {
    if (ctaSection) ctaSection.style.display = '';
    if (autoOpt) autoOpt.style.borderColor = 'var(--border)';
    if (manualOpt) manualOpt.style.borderColor = 'var(--accent)';
    if (typeof loadBridgeCtaFolder === 'function') loadBridgeCtaFolder();
  }
}

// ── CTA Folder Picker ─────────────────────────────────────────────────────────
let _bctaFolderUrl = null; // selected preset CTA image URL (e.g. /cta/foo.png)

async function loadBridgeCtaFolder() {
  const grid = document.getElementById('bcta-folder-grid');
  if (!grid || grid.dataset.loaded) return;
  try {
    const res = await fetch('/api/cta-images');
    const data = await res.json();
    const images = data.images || [];
    document.getElementById('bcta-folder-count').textContent = images.length ? `(${images.length})` : '';
    if (!images.length) {
      grid.innerHTML = '<span style="font-size:11px;color:var(--muted)">No images found in cta/ folder</span>';
    } else {
      grid.innerHTML = images.map(img => `
        <div class="bcta-folder-item" data-url="${img.url}" data-name="${img.name}"
          onclick="bctaSelectFolder(this)"
          title="${img.name}"
          style="cursor:pointer;border:2px solid var(--border);border-radius:5px;overflow:hidden;aspect-ratio:9/16;position:relative">
          <img src="${img.url}" style="width:100%;height:100%;object-fit:cover;display:block" loading="lazy" />
        </div>`).join('');
    }
    grid.dataset.loaded = '1';
  } catch (e) {
    grid.innerHTML = '<span style="font-size:11px;color:var(--muted)">Could not load CTA images</span>';
  }
}

function bctaSelectFolder(el) {
  // Deselect all
  document.querySelectorAll('.bcta-folder-item').forEach(i => {
    i.style.borderColor = 'var(--border)';
    i.style.boxShadow = '';
  });
  if (_bctaFolderUrl === el.dataset.url) {
    // Toggle off
    _bctaFolderUrl = null;
    return;
  }
  _bctaFolderUrl = el.dataset.url;
  el.style.borderColor = 'var(--accent)';
  el.style.boxShadow = '0 0 0 2px var(--accent)';
  // Clear the file input since folder image is selected
  const inp = document.getElementById('bcta-input');
  if (inp) inp.value = '';
  document.getElementById('bcta-pill').style.display = 'none';
}

async function submitBridge() {
  const mode = document.querySelector('input[name="bridge-mode"]:checked')?.value || 'auto';
  const vid = document.getElementById('bvid-input').files[0];
  const prompt = document.getElementById('bridge-prompt').value.trim();
  const duration = document.getElementById('bridge-duration').value;

  // Video source: uploaded file OR selected podcast server path
  const hasVideo = !!vid || !!bridgeSelectedPodcastPath;
  if (!hasVideo) { setStatus('bridge','error','⚠ Please select a video file or choose a podcast video.'); return; }

  if (mode === 'manual') {
    const cta = document.getElementById('bcta-input').files[0];
    if (!cta && !_bctaFolderUrl) { setStatus('bridge','error','⚠ Please select a CTA image from the library or upload one.'); return; }

    setBtnLoading('bridge', true);
    setStatus('bridge','loading','⏳ Submitting...');
    hideResult('bridge');

    const fd = new FormData();
    if (vid) fd.append('video', vid);
    else fd.append('videoPath', bridgeSelectedPodcastPath);
    if (cta) fd.append('ctaImage', cta);
    else fd.append('ctaImagePath', _bctaFolderUrl.replace(/^\/cta\//, ''));
    fd.append('model', selectedBridgeModel);
    fd.append('duration', duration);
    fd.append('orient', document.querySelector('input[name="bridge-orient"]:checked')?.value || 'portrait');
    if (prompt) fd.append('prompt', prompt);
    if (bridgeMusicFile) {
      if (bridgeMusicFile.isUploadRef) fd.append('musicFileRef', bridgeMusicFile.serverPath);
      else fd.append('musicFile', bridgeMusicFile.file);
      const bridgeOnly = document.getElementById('bridge-music-bridge-only')?.checked;
      if (bridgeOnly) fd.append('musicScope', 'bridge-only');
    }

    try {
      const res = await fetch('/api/generate-bridge', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Submission failed.');

      setStatus('bridge', 'pending',
        `✅ Task submitted! taskUUID: ${data.taskUUID}\n🔄 Extracting frame, generating bridge & concatenating — check History tab for progress.`);
      document.getElementById('bridge-prog').style.display = 'none';
      setTimeout(() => { loadHistory(); updatePendingBadge(); }, 500);
    } catch (err) {
      setStatus('bridge','error',`❌ ${err.message}`);
    } finally {
      setBtnLoading('bridge', false);
    }

  } else {
    // Auto mode: video only, AI generates CTA image
    setBtnLoading('bridge', true);
    setStatus('bridge','loading','⏳ Submitting — AI will extract last frame, generate CTA image, then create bridge...');
    hideResult('bridge');

    const fd = new FormData();
    if (vid) fd.append('video', vid);
    else fd.append('videoPath', bridgeSelectedPodcastPath);
    fd.append('model', selectedBridgeModel);
    fd.append('duration', duration);
    fd.append('orient', document.querySelector('input[name="bridge-orient"]:checked')?.value || 'portrait');
    if (prompt) fd.append('prompt', prompt);
    if (bridgeMusicFile) {
      if (bridgeMusicFile.isUploadRef) fd.append('musicFileRef', bridgeMusicFile.serverPath);
      else fd.append('musicFile', bridgeMusicFile.file);
    }

    try {
      const res = await fetch('/api/generate-bridge-auto', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Submission failed.');

      setStatus('bridge', 'pending',
        `✅ Task submitted! taskUUID: ${data.taskUUID}\n🔄 AI is generating CTA image + bridge video — check History tab for progress.`);
      document.getElementById('bridge-prog').style.display = 'none';
      setTimeout(() => { loadHistory(); updatePendingBadge(); }, 500);
    } catch (err) {
      setStatus('bridge','error',`❌ ${err.message}`);
    } finally {
      setBtnLoading('bridge', false);
    }
  }
}

// ══════ Veo submit ══════
async function submitVeo() {
  const prompt = document.getElementById('veo-prompt').value.trim();
  if (!prompt) { setStatus('veo','error','⚠ Please enter a prompt.'); return; }

  setBtnLoading('veo', true);
  setStatus('veo','loading','⏳ Submitting to Runware API...');
  hideResult('veo');

  try {
    const res = await fetch('/api/generate-veo', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ prompt, duration: document.getElementById('veo-duration').value, width: veoW, height: veoH, model: document.getElementById('veo-model').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submission failed.');

    setStatus('veo', 'pending',
      `✅ Task submitted! taskUUID: ${data.taskUUID}\n🔄 Generation running in background — check History tab for progress.`);
    document.getElementById('veo-prog').style.display = 'none';

    setTimeout(() => { loadHistory(); updatePendingBadge(); }, 500);

  } catch (err) {
    setStatus('veo','error',`❌ ${err.message}`);
  } finally {
    setBtnLoading('veo', false);
  }
}

function updateOrient() {
  const v = document.getElementById('veo-orient').value;
  veoW = v === 'portrait' ? 720 : 1280;
  veoH = v === 'portrait' ? 1280 : 720;
}

function setVeoPrompt(el) { document.getElementById('veo-prompt').value = el.textContent.trim(); }

// ══════ UI helpers ══════
function setBtnLoading(type, on) {
  const btn = document.getElementById(`btn-${type}`);
  const sp = document.getElementById(`${type}-spinner`);
  const tx = document.getElementById(`${type}-btn-text`);
  btn.disabled = on;
  sp.style.display = on ? 'block' : 'none';
  tx.textContent = on ? 'Processing...' : (type === 'avatar' ? '✨ Generate Avatar Video' : type === 'bridge' ? '🔗 Generate CTA Bridge' : type === 'am' ? '🎵 Mix Music Into Video' : '🎬 Generate Video');
}

function setStatus(type, state, msg) {
  const box = document.getElementById(`${type}-status`);
  const txt = document.getElementById(`${type}-status-text`);
  box.className = `status-box show ${state}`;
  txt.textContent = msg;
  const prog = document.getElementById(`${type}-prog`);
  if (prog) prog.style.display = state === 'loading' ? 'block' : 'none';
}

function hideResult(type) { document.getElementById(`${type}-result`).classList.remove('show'); }

function showResult(type, videoUrl, cost) {
  const wrap = document.getElementById(`${type}-result`);
  const vid = document.getElementById(`${type}-video`);
  const dl = document.getElementById(`${type}-dl`);
  vid.src = videoUrl;
  dl.href = videoUrl;
  dl.download = videoUrl.split('/').pop();
  wrap.classList.add('show');
  vid.play();
  document.getElementById(`${type}-cost`).textContent = cost ? `Cost: $${parseFloat(cost).toFixed(4)}` : '';
}

// ══════ History ══════
async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    renderHistory(data.history);
    updatePendingBadge(data.history);
    populateAmVideoSelect(data.history);
  } catch {}
}

function updatePendingBadge(history) {
  if (!history) return;
  const count = history.filter(h => h.status === 'pending').length;
  const badge = document.getElementById('pending-badge');
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline' : 'none';
}

function filterHistory(f, el) {
  historyFilter = f;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  loadHistory();
}

function renderHistory(history) {
  const list = document.getElementById('history-list');
  let items = history;
  if (historyFilter !== 'all') items = history.filter(h => h.status === historyFilter);

  if (!items.length) {
    list.innerHTML = `<div class="history-empty">${historyFilter === 'all' ? 'No generations yet.' : `No ${historyFilter} tasks.`}</div>`;
    return;
  }

  list.innerHTML = items.map(h => {
    const isAvatar = h.type === 'avatar';
    const isBridge = h.type === 'bridge';
    const isLipSync = h.type === 'lipsync';
    const isCtaFrame = h.type === 'cta-frame';
    const date = new Date(h.submittedAt).toLocaleString();
    const title = isAvatar
      ? `${h.modelLabel} · ${h.imageName || 'image'} + ${h.audioName || 'audio'}`
      : isBridge
        ? `Bridge · ${h.videoName || 'video'} → ${h.ctaImageName || 'CTA'}`
        : isLipSync
          ? `LipSync · ${h.videoName || 'video'} + ${h.audioName || 'audio'}`
          : isCtaFrame
            ? `CTA Frame · ${h.videoName || 'video'}`
          : `${h.modelLabel} · "${(h.prompt||'').slice(0,60)}${h.prompt?.length>60?'…':''}"`;

    const costStr = h.cost != null ? `$${parseFloat(h.cost).toFixed(4)}` : null;
    const typeIcon = isAvatar ? '🧑‍💼' : isBridge ? '🔗' : isLipSync ? '👄' : isCtaFrame ? '🖼' : '🎥';
    const metaParts = [`${typeIcon} ${h.type.toUpperCase()}`, date];
    if (costStr) metaParts.push(costStr);

    const dotClass = h.status === 'completed' ? 'dot-completed' : h.status === 'pending' ? 'dot-pending' : 'dot-failed';
    const typeBadgeClass = isAvatar ? 'htb-avatar' : isBridge ? 'htb-bridge' : isLipSync ? 'htb-lipsync' : isCtaFrame ? 'htb-lipsync' : 'htb-veo';

    let bodyContent = '';
    if (h.status === 'completed' && isCtaFrame) {
      // CTA Frame entry — no video, just images
      bodyContent = `
        <div class="hist-detail" style="margin-top:8px">
          <div><strong>Video:</strong> ${h.videoName || '—'}</div>
          <div><strong>Submitted:</strong> ${date}</div>
          ${h.completedAt ? `<div><strong>Completed:</strong> ${new Date(h.completedAt).toLocaleString()}</div>` : ''}
          ${h.cost != null ? `<div><strong>Cost:</strong> $${parseFloat(h.cost).toFixed(4)}</div>` : ''}
          <div><strong>UUID:</strong> <span style="font-family:monospace;font-size:10px">${h.taskUUID}</span></div>
        </div>
        <div class="hist-actions" style="margin-top:8px">
          ${h.lastFrameUrl ? `<a class="btn-sm" href="${h.lastFrameUrl}" download="last_frame.jpg">🖼 Last Frame</a>` : ''}
          ${h.ctaImageUrl ? `<a class="btn-sm" href="${h.ctaImageUrl}" download="cta_frame.jpg" style="background:rgba(236,72,153,.2);color:#ec4899">🎯 CTA Image</a>` : ''}
          <button class="btn-sm red" onclick="deleteHistory('${h.taskUUID}')">🗑 Remove</button>
        </div>
        ${h.ctaImageUrl ? `<div style="margin-top:12px;display:flex;gap:12px;align-items:flex-start">
          <div><div style="font-size:11px;color:var(--muted);margin-bottom:4px">Last Frame</div><img src="${h.lastFrameUrl}" style="width:140px;border-radius:6px;border:1px solid var(--border)"></div>
          <div><div style="font-size:11px;color:var(--muted);margin-bottom:4px">CTA Frame</div><img src="${h.ctaImageUrl}" style="width:140px;border-radius:6px;border:2px solid #ec4899"></div>
        </div>` : ''}`;
    } else if (h.status === 'completed' && h.videoUrl) {
      bodyContent = `
        <div class="hist-body-grid">
          <div>
            <div class="hist-detail">
              <div><strong>Model:</strong> ${h.modelLabel}</div>
              <div><strong>Provider:</strong> ${h.provider || '—'}</div>
              ${h.prompt ? `<div><strong>Prompt:</strong> ${h.prompt}</div>` : ''}
              ${isAvatar ? `<div><strong>Image:</strong> ${h.imageName || '—'}</div><div><strong>Audio:</strong> ${h.audioName || '—'}</div>` : ''}
              ${isBridge ? `<div><strong>Video:</strong> ${h.videoName || '—'}</div><div><strong>CTA Image:</strong> ${h.ctaImageName || '—'}</div>` : ''}
              ${isLipSync ? `<div><strong>Video:</strong> ${h.videoName || '—'}</div><div><strong>Audio:</strong> ${h.audioName || '—'}</div>` : ''}
              ${h.duration && !isBridge && !isLipSync ? `<div><strong>Duration:</strong> ${h.duration}s (${h.width}×${h.height})</div>` : ''}
              <div><strong>Submitted:</strong> ${date}</div>
              ${h.completedAt ? `<div><strong>Completed:</strong> ${new Date(h.completedAt).toLocaleString()}</div>` : ''}
              ${h.cost != null ? `<div><strong>Cost:</strong> $${parseFloat(h.cost).toFixed(4)}</div>` : ''}
              <div><strong>UUID:</strong> <span style="font-family:monospace;font-size:10px">${h.taskUUID}</span></div>
            </div>
            <div class="hist-actions">
              <a class="btn-sm green" href="${h.videoUrl}" download>${isBridge ? '⬇ Download Combined' : '⬇ Download'}</a>
              <button class="btn-sm" onclick="playInGallery('${h.videoUrl}')">▶ Play</button>
              ${h.filename ? `<button class="btn-sm" onclick="openCombineWith('${h.filename}')">⛓ Combine</button>` : ''}
              ${isLipSync && h.lastFrameUrl ? `<a class="btn-sm" href="${h.lastFrameUrl}" download="last_frame.jpg">🖼 Last Frame</a>` : ''}
              ${isLipSync && h.ctaImageUrl ? `<a class="btn-sm" href="${h.ctaImageUrl}" download="cta_frame.jpg" style="background:rgba(236,72,153,.2);color:#ec4899">🎯 CTA Image</a>` : ''}
              <button class="btn-sm red" onclick="deleteHistory('${h.taskUUID}')">🗑 Remove</button>
            </div>
            ${(isLipSync) && h.ctaImageUrl ? `<div style="margin-top:10px;display:flex;gap:10px;align-items:flex-start"><div><div style="font-size:11px;color:var(--muted);margin-bottom:4px">Last Frame</div><img src="${h.lastFrameUrl}" style="width:120px;border-radius:6px;border:1px solid var(--border)"></div><div><div style="font-size:11px;color:var(--muted);margin-bottom:4px">CTA Frame</div><img src="${h.ctaImageUrl}" style="width:120px;border-radius:6px;border:1px solid #ec4899"></div></div>` : ''}
          </div>
          <div class="hist-video-wrap">
            <video src="${h.videoUrl}" controls playsinline></video>
          </div>
        </div>`;
    } else if (h.status === 'pending') {
      bodyContent = `
        <div class="hist-detail" style="margin-top:10px">
          ${!isCtaFrame ? `<div><strong>Model:</strong> ${h.modelLabel}</div>` : ''}
          ${h.prompt ? `<div><strong>Prompt:</strong> ${h.prompt}</div>` : ''}
          ${isAvatar ? `<div><strong>Image:</strong> ${h.imageName || '—'}</div><div><strong>Audio:</strong> ${h.audioName || '—'}</div>` : ''}
          ${isBridge ? `<div><strong>Video:</strong> ${h.videoName || '—'}</div><div><strong>CTA Image:</strong> ${h.ctaImageName || '—'}</div>` : ''}
          ${isLipSync ? `<div><strong>Video:</strong> ${h.videoName || '—'}</div><div><strong>Audio:</strong> ${h.audioName || '—'}</div>` : ''}
          ${isCtaFrame ? `<div><strong>Video:</strong> ${h.videoName || '—'}</div>` : ''}
          <div><strong>Submitted:</strong> ${date}</div>
          <div><strong>UUID:</strong> <span style="font-family:monospace;font-size:10px">${h.taskUUID}</span></div>
        </div>
        <div class="pending-actions">
          <button class="btn-sm green" onclick="manualCheck('${h.taskUUID}', this)">🔍 Check Now</button>
          <button class="btn-sm red" onclick="deleteHistory('${h.taskUUID}')">🗑 Remove</button>
          <span class="checking-indicator" id="checking-${h.taskUUID}" style="display:none">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--yellow);animation:pulse 1s infinite"></span>
            Checking...
          </span>
        </div>
        <div class="check-logs" id="check-logs-${h.taskUUID}"></div>`;
    } else { // failed
      bodyContent = `
        <div class="hist-detail" style="margin-top:10px">
          <div><strong>Model:</strong> ${h.modelLabel}</div>
          <div><strong>Submitted:</strong> ${date}</div>
          <div><strong>UUID:</strong> <span style="font-family:monospace;font-size:10px">${h.taskUUID}</span></div>
        </div>
        ${h.error ? `<div class="hist-error">❌ ${h.error}</div>` : ''}
        <div class="pending-actions" style="margin-top:8px">
          <button class="btn-sm green" onclick="manualCheck('${h.taskUUID}', this)">🔍 Check Now</button>
          <button class="btn-sm red" onclick="deleteHistory('${h.taskUUID}')">🗑 Remove</button>
          <span class="checking-indicator" id="checking-${h.taskUUID}" style="display:none">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--yellow);animation:pulse 1s infinite"></span>
            Checking...
          </span>
        </div>
        <div class="check-logs" id="check-logs-${h.taskUUID}"></div>`;
    }

    return `
      <div class="hist-item ${h.status}" id="hist-${h.taskUUID}">
        <div class="hist-header" onclick="toggleHist('${h.taskUUID}')">
          <span class="hist-status-dot ${dotClass}"></span>
          <div class="hist-info">
            <div class="hist-title">${title}</div>
            <div class="hist-meta">${metaParts.join(' · ')}</div>
          </div>
          <div class="hist-badges">
            <span class="hist-type-badge ${typeBadgeClass}">${h.type.toUpperCase()}</span>
            <span style="font-size:11px;padding:2px 6px;border-radius:4px;font-weight:600;background:${h.status==='completed'?'rgba(16,185,129,.15)':h.status==='pending'?'rgba(245,158,11,.15)':'rgba(239,68,68,.15)'};color:${h.status==='completed'?'var(--green)':h.status==='pending'?'var(--yellow)':'var(--red)'}">
              ${h.status === 'completed' ? '✅ Done' : h.status === 'pending' ? '⏳ Pending' : '❌ Failed'}
            </span>
          </div>
          <span class="hist-chevron">›</span>
        </div>
        <div class="hist-body">${bodyContent}</div>
      </div>`;
  }).join('');
}

function toggleHist(uuid) {
  const el = document.getElementById(`hist-${uuid}`);
  el.classList.toggle('open');
}

async function manualCheck(taskUUID, btn) {
  const indicator = document.getElementById(`checking-${taskUUID}`);
  const logBox = document.getElementById(`check-logs-${taskUUID}`);
  if (indicator) indicator.style.display = 'flex';
  if (btn) btn.disabled = true;
  if (logBox) { logBox.style.display = 'block'; logBox.textContent = '⏳ Registering with poller…'; }

  try {
    const res = await fetch(`/api/check/${taskUUID}`, { method: 'POST' });
    const data = await res.json();
    console.log(`[Check ${taskUUID}] Response:`, data);

    if (data.status === 'completed') {
      if (logBox) logBox.textContent = '✅ Already completed.';
      await loadHistory();
      await loadGallery();
      updatePendingBadge(await (await fetch('/api/history')).json().then(d => d.history));
    } else if (data.status === 'checking' || data.status === 'rechecking') {
      if (indicator) indicator.style.display = 'none';
      if (btn) { btn.disabled = false; btn.textContent = '👁 Watching…'; }
      if (logBox) logBox.textContent = data.message || 'Registered with global poller. Completion will appear automatically via SSE.';
      if (data.status === 'rechecking') await loadHistory();
    }
  } catch (err) {
    if (indicator) indicator.style.display = 'none';
    if (btn) { btn.disabled = false; }
    if (logBox) logBox.textContent = `❌ Error: ${err.message}`;
    console.error('Check error:', err);
  }
}

async function deleteHistory(taskUUID) {
  if (!confirm('Remove this entry from history?')) return;
  await fetch(`/api/history/${taskUUID}`, { method: 'DELETE' });
  await loadHistory();
  updatePendingBadge((await (await fetch('/api/history')).json()).history);
}

function toggleAutoPoll() {
  const on = document.getElementById('auto-poll-toggle').checked;
  if (on) {
    // SSE handles real-time completion notifications.
    // Auto-poll just refreshes the history display every 10s as a fallback.
    autoPollInterval = setInterval(async () => {
      await loadHistory();
    }, 10000);
  } else {
    clearInterval(autoPollInterval);
    autoPollInterval = null;
  }
}

// ══════ Gallery ══════
async function loadGallery() {
  try {
    const res = await fetch('/api/videos');
    const data = await res.json();
    renderGallery(data.videos);
  } catch {}
}

function renderGallery(videos) {
  const gal = document.getElementById('gallery');
  if (!videos.length) {
    gal.innerHTML = '<div class="history-empty" style="grid-column:1/-1">No videos yet.</div>';
    return;
  }
  gal.innerHTML = videos.map(v => `
    <div class="gal-item">
      <video src="${v.url}" muted preload="metadata" controls></video>
      <div class="gal-info">
        <span class="gal-type ${v.type === 'avatar' ? 'htb-avatar' : v.type === 'bridge' || v.type === 'combined' ? 'htb-bridge' : 'htb-veo'}">${v.type.toUpperCase()}</span>
        <span class="gal-name">${v.filename}</span>
        <div class="gal-actions">
          <a class="btn-icon" href="${v.url}" download="${v.filename}" title="Download">⬇</a>
          <button class="btn-icon del" onclick="deleteVideo('${v.filename}',this)" title="Delete">🗑</button>
        </div>
      </div>
    </div>`).join('');
}

async function deleteVideo(filename, btn) {
  if (!confirm(`Delete "${filename}"?`)) return;
  const res = await fetch(`/api/videos/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  if (res.ok) { btn.closest('.gal-item').remove(); }
}

function playInGallery(url) {
  showPage2('gallery');
  setTimeout(() => {
    const vids = document.querySelectorAll('#gallery video');
    for (const v of vids) { if (v.src.includes(url.split('/').pop())) { v.scrollIntoView({behavior:'smooth'}); v.play(); break; } }
  }, 100);
}

function showPage2(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(t => { if (t.textContent.toLowerCase().includes(name)) t.classList.add('active'); });
}

// ══════ Combine ══════
function combineOrientChange() {
  const val = document.querySelector('input[name="combine-orient"]:checked')?.value || 'portrait';
  document.getElementById('combine-orient-portrait-lbl').style.borderColor = val === 'portrait' ? 'var(--accent)' : 'var(--border)';
  document.getElementById('combine-orient-landscape-lbl').style.borderColor = val === 'landscape' ? 'var(--accent)' : 'var(--border)';
}
document.addEventListener('DOMContentLoaded', combineOrientChange);

async function loadCombineVideos() {
  try {
    const res = await fetch('/api/videos');
    const data = await res.json();
    const v1 = document.getElementById('combine-v1');
    const v2 = document.getElementById('combine-v2');
    const opts = data.videos.map(v => `<option value="${v.filename}">${v.filename}</option>`).join('');
    v1.innerHTML = '<option value="">— select video —</option>' + opts;
    v2.innerHTML = '<option value="">— select video —</option>' + opts;
  } catch {}
}

function openCombineWith(filename) {
  showPage2('combine');
  loadCombineVideos().then(() => {
    const v1 = document.getElementById('combine-v1');
    v1.value = filename;
  });
}

function handleCtaFrameDrop(event, inputId, zoneId, nameId) {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const input = document.getElementById(inputId);
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  const nameEl = document.getElementById(nameId);
  if (nameEl) nameEl.textContent = file.name;
}

async function submitCtaFrame() {
  const videoInput = document.getElementById('ctaframe-video-input');
  const status = document.getElementById('ctaframe-status');
  const result = document.getElementById('ctaframe-result');
  const btn = document.getElementById('ctaframe-btn');

  if (!videoInput.files[0]) {
    status.style.color = 'var(--yellow)';
    status.textContent = '⚠ Please select a video file.';
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Processing…';
  status.style.color = 'var(--muted)';
  status.textContent = 'Uploading and extracting last frame…';
  result.style.display = 'none';

  try {
    const fd = new FormData();
    fd.append('video', videoInput.files[0]);

    const res = await fetch('/api/generate-cta-frame', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed.');

    status.style.color = 'var(--green)';
    status.textContent = `✅ Submitted (taskUUID: ${data.taskUUID}) — generating CTA image in background…`;

    // Poll for completion by checking history
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const hr = await fetch('/api/history');
        const hd = await hr.json();
        const entry = (hd.history || []).find(h => h.taskUUID === data.taskUUID);
        if (entry && entry.status === 'completed') {
          clearInterval(poll);
          status.textContent = '✅ CTA Frame generated!';
          document.getElementById('ctaframe-lastframe-img').src = entry.lastFrameUrl + '?t=' + Date.now();
          document.getElementById('ctaframe-cta-img').src = entry.ctaImageUrl + '?t=' + Date.now();
          document.getElementById('ctaframe-lastframe-dl').href = entry.lastFrameUrl;
          document.getElementById('ctaframe-cta-dl').href = entry.ctaImageUrl;
          result.style.display = 'block';
        } else if (entry && entry.status === 'failed') {
          clearInterval(poll);
          status.style.color = 'var(--red)';
          status.textContent = `❌ Failed: ${entry.error}`;
        } else if (attempts > 60) {
          clearInterval(poll);
          status.style.color = 'var(--yellow)';
          status.textContent = '⚠ Taking longer than expected — check History tab.';
        }
      } catch {}
    }, 3000);

  } catch (err) {
    status.style.color = 'var(--red)';
    status.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🖼 Generate CTA Frame';
  }
}

async function submitCombine() {
  const v1 = document.getElementById('combine-v1').value;
  const v2 = document.getElementById('combine-v2').value;
  const upload1 = document.getElementById('combine-upload1').files[0];
  const upload2 = document.getElementById('combine-upload2').files[0];
  const status = document.getElementById('combine-status');
  const result = document.getElementById('combine-result');

  const has1 = v1 || upload1;
  const has2 = v2 || upload2;
  if (!has1) { status.textContent = '⚠ Please select or upload the first video.'; status.style.color = 'var(--yellow)'; return; }
  if (!has2) { status.textContent = '⚠ Please select or upload the second video.'; status.style.color = 'var(--yellow)'; return; }

  const btn = document.getElementById('combine-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Combining…';
  status.style.color = 'var(--muted)';
  status.textContent = 'Re-encoding and concatenating…';
  result.classList.remove('show');

  try {
    const fd = new FormData();
    if (upload1) fd.append('upload1', upload1);
    else fd.append('video1', v1);
    if (upload2) fd.append('upload2', upload2);
    else fd.append('video2', v2);
    fd.append('orient', document.querySelector('input[name="combine-orient"]:checked')?.value || 'portrait');

    const res = await fetch('/api/combine', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Combine failed.');
    status.style.color = 'var(--green)';
    status.textContent = `✅ Done! Saved as ${data.filename}`;
    const vid = document.getElementById('combine-video');
    const dl = document.getElementById('combine-dl');
    vid.src = data.url;
    dl.href = data.url;
    dl.download = data.filename;
    result.classList.add('show');
    vid.play();
    loadCombineVideos();
  } catch (err) {
    status.style.color = 'var(--red)';
    status.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '⛓ Combine Videos';
  }
}

// ══════ Story Pipeline ══════
async function loadStoryModels() {
  try {
    const res = await fetch('/api/story-models');
    const data = await res.json();
    storyModels = data.models || [];
    const sel = document.getElementById('story-video-model');
    sel.innerHTML = storyModels.map(m =>
      `<option value="${m.id}" ${m.id === selectedStoryModel ? 'selected' : ''}>${m.label} (${m.cost})</option>`
    ).join('');
  } catch {}
}

async function loadStoryGameContext() {
  try {
    const res = await fetch('/game-context.txt');
    if (res.ok) {
      const text = await res.text();
      document.getElementById('story-game-context').value = text;
    }
  } catch {}
}

// ── Story hero/background image upload helpers ──
let storyHeroFiles = [];     // Array of { file: File, isUploadRef: bool, serverPath?: string, name: string, size: number, thumbUrl: string }
let storyBgFile = null;      // { file: File } or { isUploadRef: true, serverPath, name } or null
let storyMusicFile = null;   // { file: File } or { isUploadRef: true, serverPath, name } or null
let storyNamedHeroes = [];   // string[] — hero names from catalog (no image)
let selectedAngleId = null;  // number | null
let _marketingAngles = [];   // cached from /api/marketing-angles
let _heroCatalogData = [];   // cached from /api/hero-catalog
let _heroCatalogSelected = new Set(); // currently ticked in the modal

// ── Marketing Angle functions ─────────────────────────────────────────────────
async function loadMarketingAngles() {
  try {
    const res = await fetch('/api/marketing-angles');
    if (!res.ok) return;
    const data = await res.json();
    _marketingAngles = data.angles || [];
    renderAngleCards(_marketingAngles);
  } catch (e) {
    console.warn('Could not load marketing angles:', e);
    document.getElementById('angle-card-grid').innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px;grid-column:1/-1">Marketing angles unavailable.</div>';
  }
}

function renderAngleCards(angles) {
  const grid = document.getElementById('angle-card-grid');
  if (!grid) return;
  if (!angles.length) { grid.innerHTML = '<div style="color:var(--muted);font-size:12px;grid-column:1/-1">No angles found.</div>'; return; }
  grid.innerHTML = angles.map(a => {
    const statusClass = a.status === 'in_pipeline' ? 'in-pipeline' : a.status === 'untested_gap' ? 'untested-gap' : 'untested';
    const statusLabel = a.status === 'in_pipeline' ? '▶ In Pipeline' : a.status === 'untested_gap' ? `★ Gap (Priority ${a.test_priority})` : '○ Untested';
    return `<div class="angle-card" id="angle-card-${a.id}" onclick="selectAngle(${a.id})">
      <div class="angle-card-name">${a.name}</div>
      <div class="angle-card-msg">${a.core_message}</div>
      <div class="angle-card-status ${statusClass}">${statusLabel}</div>
    </div>`;
  }).join('');
}

function selectAngle(id) {
  selectedAngleId = id;
  document.querySelectorAll('.angle-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById(`angle-card-${id}`);
  if (card) card.classList.add('selected');
  const actions = document.getElementById('angle-actions');
  actions.style.display = 'flex';
  document.getElementById('video-desc-output').classList.remove('show');
  document.getElementById('video-desc-copy-row').style.display = 'none';
}

function clearAngleSelection() {
  selectedAngleId = null;
  document.querySelectorAll('.angle-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('angle-actions').style.display = 'none';
  document.getElementById('video-desc-output').classList.remove('show');
  document.getElementById('video-desc-copy-row').style.display = 'none';
}

async function generateVideoDescriptionBrief() {
  if (!selectedAngleId) return;
  const gameContext = document.getElementById('story-game-context').value.trim();
  const heroDesc = document.getElementById('story-hero-desc').value.trim();
  const btn = document.getElementById('btn-gen-video-desc');
  const spinner = document.getElementById('gen-desc-spinner');
  const outputBox = document.getElementById('video-desc-output');

  btn.disabled = true;
  spinner.style.display = 'inline-block';
  outputBox.textContent = 'Generating video brief…';
  outputBox.classList.add('show');
  document.getElementById('video-desc-copy-row').style.display = 'none';

  try {
    const res = await fetch('/api/generate-video-desc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ angleId: selectedAngleId, gameContext, heroDesc, namedHeroes: storyNamedHeroes }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');
    outputBox.textContent = data.description;
    document.getElementById('video-desc-copy-row').style.display = 'flex';
  } catch (err) {
    outputBox.textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
  }
}

function copyDescToStory() {
  const desc = document.getElementById('video-desc-output').textContent;
  if (!desc || desc.startsWith('❌')) return;
  document.getElementById('story-text').value = desc;
  const btn = event.currentTarget;
  const orig = btn.textContent;
  btn.textContent = '✅ Copied!';
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

// ── Planning JSON inject ───────────────────────────────────────────────────────
function togglePlanJsonPanel() {
  const panel = document.getElementById('plan-json-panel');
  const btn = document.getElementById('btn-toggle-plan-json');
  const open = panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  btn.style.background = open ? 'rgba(124,58,237,.2)' : 'var(--surface2)';
  btn.style.color = open ? '#a78bfa' : 'var(--muted)';
  btn.style.borderColor = open ? 'rgba(124,58,237,.5)' : 'var(--border)';
  btn.textContent = open ? '📋 Planning JSON ▲' : '📋 Paste Planning JSON';
}

/** Normalize whatever the user pastes into { scenes:[], voiceOverCharacteristics:"" }.
 *  Accepts:
 *   - A bare array:           [ { sceneNumber:1, ... }, ... ]
 *   - An object with scenes:  { "scenes": [...], "voiceOverCharacteristics": "..." }
 *   - An object that IS a scene (single scene wrapped in {}): auto-wraps into array
 * Returns null on parse failure or if no valid scenes found. */
function _normalizePlanInput(raw) {
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }

  let scenes, voiceOver = '';

  if (Array.isArray(parsed)) {
    // Bare array of scenes
    scenes = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.scenes)) {
      // Full object { scenes: [...], voiceOverCharacteristics: "..." }
      scenes = parsed.scenes;
      voiceOver = parsed.voiceOverCharacteristics || '';
    } else if (parsed.sceneNumber !== undefined || parsed.videoPrompt !== undefined) {
      // Single scene object accidentally — wrap it
      scenes = [parsed];
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (!scenes || scenes.length === 0) return null;
  return { scenes, voiceOverCharacteristics: voiceOver };
}

function validatePlanJson() {
  const raw = document.getElementById('plan-json-input').value.trim();
  const statusEl = document.getElementById('plan-json-status');
  if (!raw) { statusEl.style.color = 'var(--muted)'; statusEl.textContent = 'Empty — will use AI planning'; return; }

  // Try to parse raw first for error message
  try { JSON.parse(raw); } catch(e) {
    statusEl.style.color = 'var(--red,#ef4444)'; statusEl.textContent = `❌ JSON parse error: ${e.message}`; return;
  }

  const plan = _normalizePlanInput(raw);
  if (!plan) {
    statusEl.style.color = 'var(--red,#ef4444)'; statusEl.textContent = '❌ Could not find a scenes array — paste an array [...] or { "scenes": [...] }'; return;
  }
  const missingFields = plan.scenes.filter(s => !s.videoPrompt || !s.duration);
  if (missingFields.length > 0) {
    statusEl.style.color = 'orange';
    statusEl.textContent = `⚠ ${missingFields.length} scene(s) missing videoPrompt or duration — still usable`; return;
  }
  const totalSec = plan.scenes.reduce((s,c) => s + (c.duration || 0), 0);
  const note = plan.voiceOverCharacteristics ? '' : ' · voice-over from Voice Desc field';
  statusEl.style.color = 'var(--green)';
  statusEl.textContent = `✅ Valid — ${plan.scenes.length} scenes, total ${totalSec}s${note}`;
}

function clearPlanJson() {
  document.getElementById('plan-json-input').value = '';
  document.getElementById('plan-json-status').textContent = '';
}

/** Build the minimal planning JSON from the current active entry's scenes */
function _buildPlanningJson(entry) {
  if (!entry?.scenes?.length) return null;
  const scenes = entry.scenes.map(s => {
    const out = {
      sceneNumber: s.sceneNumber,
      videoPrompt: s.videoPrompt,
      duration: s.duration,
      useHeroRef: s.useHeroRef || false,
      useBgRef: s.useBgRef || false,
    };
    if (s.imagePrompt) out.imagePrompt = s.imagePrompt;
    if (s.imageBPrompt) out.imageBPrompt = s.imageBPrompt;
    if (s.ctaImagePrompt) out.ctaImagePrompt = s.ctaImagePrompt;
    return out;
  });
  return { scenes, voiceOverCharacteristics: entry.voiceOverCharacteristics || '' };
}

function copyPlanningJson() {
  const wrap = document.getElementById('copy-plan-json-wrap');
  const entry = wrap?._entry;
  const plan = _buildPlanningJson(entry);
  if (!plan) return;
  navigator.clipboard.writeText(JSON.stringify(plan, null, 2)).then(() => {
    const msg = document.getElementById('copy-plan-json-msg');
    msg.textContent = '✅ Copied!';
    setTimeout(() => { msg.textContent = ''; }, 2000);
  });
}

function loadPlanJsonIntoEditor() {
  const wrap = document.getElementById('copy-plan-json-wrap');
  const entry = wrap?._entry;
  const plan = _buildPlanningJson(entry);
  if (!plan) return;
  // Open the panel and populate it
  const panel = document.getElementById('plan-json-panel');
  if (panel.style.display === 'none') togglePlanJsonPanel();
  document.getElementById('plan-json-input').value = JSON.stringify(plan, null, 2);
  validatePlanJson();
  // Scroll left panel into view
  document.getElementById('plan-json-input').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Multi-Hero image management ───────────────────────────────────────────────
const MAX_HERO_IMAGES = 6;

function handleHeroImagesPick(input) {
  const files = Array.from(input.files);
  for (const file of files) {
    if (storyHeroFiles.length >= MAX_HERO_IMAGES) break;
    const thumbUrl = URL.createObjectURL(file);
    storyHeroFiles.push({ file, isUploadRef: false, name: file.name, size: file.size, thumbUrl });
  }
  input.value = '';
  renderHeroPills();
  updateHeroDropzoneVisibility();
}

function renderHeroPills() {
  const list = document.getElementById('hero-pills-list');
  if (!list) return;
  list.innerHTML = storyHeroFiles.map((h, i) => {
    const sizeStr = h.size > 1024 * 1024 ? (h.size / 1024 / 1024).toFixed(1) + ' MB' : (h.size / 1024).toFixed(0) + ' KB';
    const thumb = h.thumbUrl ? `<img src="${h.thumbUrl}" alt="Hero ${i+1}">` : `<span style="font-size:18px">🦸</span>`;
    const shortName = h.name.replace(/^\d+-[\da-f]+-?/, '').slice(0, 18) || `Hero ${i+1}`;
    return `<div class="hero-pill-item">
      ${thumb}
      <span class="pill-label" title="${h.name}">Hero ${i+1} · ${sizeStr}</span>
      <button class="pill-rm" onclick="removeHeroFile(${i})" title="Remove ${shortName}">✕</button>
    </div>`;
  }).join('');
}

function removeHeroFile(index) {
  storyHeroFiles.splice(index, 1);
  renderHeroPills();
  updateHeroDropzoneVisibility();
}

function updateHeroDropzoneVisibility() {
  const dz = document.getElementById('dz-story-hero');
  if (!dz) return;
  const atMax = storyHeroFiles.length >= MAX_HERO_IMAGES;
  dz.style.opacity = atMax ? '0.4' : '';
  dz.querySelector('input[type=file]').disabled = atMax;
}

// ── Hero Catalog Modal ────────────────────────────────────────────────────────
async function openHeroCatalog() {
  if (_heroCatalogData.length === 0) {
    try {
      const res = await fetch('/api/hero-catalog');
      const data = await res.json();
      _heroCatalogData = data.heroes || [];
    } catch { _heroCatalogData = []; }
  }
  _heroCatalogSelected = new Set(storyNamedHeroes);

  const grid = document.getElementById('hero-catalog-grid');
  grid.innerHTML = _heroCatalogData.map(h => {
    const isSel = _heroCatalogSelected.has(h.name);
    return `<div class="hero-catalog-item${isSel ? ' selected' : ''}" onclick="toggleCatalogHero('${h.name.replace(/'/g,"\\'")}', this)">
      <input type="checkbox" class="hc-check" ${isSel ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleCatalogHero('${h.name.replace(/'/g,"\\'")}', this.closest('.hero-catalog-item'))">
      <div class="hc-name">${h.name}</div>
      <div class="hc-class">${h.class}</div>
    </div>`;
  }).join('');

  document.getElementById('hero-catalog-modal').classList.add('show');
}

function toggleCatalogHero(name, cardEl) {
  const cb = cardEl.querySelector('input[type=checkbox]');
  if (_heroCatalogSelected.has(name)) {
    _heroCatalogSelected.delete(name);
    cardEl.classList.remove('selected');
    if (cb) cb.checked = false;
  } else {
    _heroCatalogSelected.add(name);
    cardEl.classList.add('selected');
    if (cb) cb.checked = true;
  }
}

function confirmHeroCatalogSelection() {
  storyNamedHeroes = Array.from(_heroCatalogSelected);
  renderNamedHeroBadges();
  closeHeroCatalog();
}

function closeHeroCatalog() {
  document.getElementById('hero-catalog-modal').classList.remove('show');
}

function renderNamedHeroBadges() {
  const container = document.getElementById('named-heroes-badges');
  if (!container) return;
  container.innerHTML = storyNamedHeroes.map(name =>
    `<span style="background:rgba(6,182,212,.12);color:var(--accent2);border:1px solid rgba(6,182,212,.3);border-radius:4px;font-size:11px;padding:2px 8px;display:inline-flex;align-items:center;gap:5px">
      🦸 ${name}
      <button style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;line-height:1;padding:0" onclick="removeNamedHero('${name.replace(/'/g,"\\'")}')">✕</button>
    </span>`
  ).join('');
}

function removeNamedHero(name) {
  storyNamedHeroes = storyNamedHeroes.filter(n => n !== name);
  renderNamedHeroBadges();
}

function onDurationRangeChange(value) {
  const customDiv = document.getElementById('story-duration-custom');
  customDiv.style.display = value === 'custom' ? 'block' : 'none';
}

function getStoryDurationRange() {
  const val = document.getElementById('story-duration-range').value;
  if (val !== 'custom') return val;
  const min = parseInt(document.getElementById('story-dur-min').value, 10) || 20;
  const max = parseInt(document.getElementById('story-dur-max').value, 10) || 40;
  // Ensure min < max and both are sane
  const safeMin = Math.max(5, Math.min(min, 590));
  const safeMax = Math.max(safeMin + 5, Math.min(max, 600));
  return `${safeMin}-${safeMax}`;
}

function onPipelineModeChange(mode) {
  // Update radio
  document.querySelector(`input[name="pipelineMode"][value="${mode}"]`).checked = true;
  // Update visual selection
  document.getElementById('mode-opt-standard').classList.toggle('mode-selected', mode === 'standard');
  document.getElementById('mode-opt-fast-paced').classList.toggle('mode-selected', mode === 'fast-paced');
  // Show/hide music section
  document.getElementById('story-music-section').style.display = mode === 'fast-paced' ? 'block' : 'none';
  // Clear music file if switching back to standard
  if (mode === 'standard' && storyMusicFile) {
    storyMusicFile = null;
    document.getElementById('story-music-input').value = '';
    document.getElementById('music-label').innerHTML = 'Drop music file or <strong>click to browse</strong>';
  }
}

function handleMusicFilePick(input) {
  if (input.files[0]) {
    const file = input.files[0];
    storyMusicFile = { file, isUploadRef: false, name: file.name };
    document.getElementById('music-label').innerHTML = `🎵 <strong>${file.name}</strong> (${(file.size / 1024).toFixed(0)} KB)`;
  }
}

function handleBridgeMusicFilePick(input) {
  if (input.files[0]) {
    const file = input.files[0];
    bridgeMusicFile = { file, isUploadRef: false, name: file.name };
    document.getElementById('bridge-music-label').innerHTML = `🎵 <strong>${file.name}</strong> (${(file.size / 1024).toFixed(0)} KB)`;
  }
}

function useGameMusic() {
  bridgeMusicFile = { file: null, isUploadRef: true, serverPath: 'uploads/game_music.wav', name: 'game_music.wav' };
  document.getElementById('bridge-music-label').innerHTML = `🎮 <strong>game_music.wav</strong> (from uploads)`;
}

// ── Add Music to Video ────────────────────────────────────────────────────────
let amMusicFile = null; // { file } or { isUploadRef, serverPath, name }

function handleAmMusicPick(input) {
  if (input.files[0]) {
    const file = input.files[0];
    amMusicFile = { file, isUploadRef: false, name: file.name };
    document.getElementById('am-music-label').innerHTML = `🎵 <strong>${file.name}</strong> (${(file.size / 1024).toFixed(0)} KB)`;
  }
}

function populateAmVideoSelect(history) {
  const sel = document.getElementById('am-video-select');
  if (!sel) return;
  const videos = (history || []).filter(h => h.videoUrl && h.status === 'completed');
  sel.innerHTML = '<option value="">— select from output history —</option>' +
    videos.map(h => {
      const label = h.modelLabel || h.type || 'video';
      const time = h.completedAt ? new Date(h.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      return `<option value="${h.videoUrl}">${label} · ${time} · ${h.filename || ''}</option>`;
    }).join('');
}

async function submitAddMusic() {
  const sel = document.getElementById('am-video-select');
  const uploadInput = document.getElementById('am-video-upload');
  const volume = parseFloat(document.getElementById('am-volume').value) / 100;

  // Resolve video source
  const selectedPath = sel.value; // e.g. /output/xxx.mp4
  const uploadedVideo = uploadInput.files[0];
  if (!selectedPath && !uploadedVideo) {
    showAmStatus('error', '⚠ Please select or upload a video.');
    return;
  }
  if (!amMusicFile) {
    showAmStatus('error', '⚠ Please select a music file.');
    return;
  }

  setBtnLoading('am', true);
  showAmStatus('loading', '⏳ Mixing music into video...');
  document.getElementById('am-result').classList.remove('show');

  const fd = new FormData();
  fd.append('volume', volume.toString());

  if (uploadedVideo) {
    fd.append('videoFile', uploadedVideo);
  } else {
    // Strip leading slash and use as relative path
    const relPath = selectedPath.startsWith('/') ? selectedPath.slice(1) : selectedPath;
    fd.append('videoPath', relPath);
  }

  if (amMusicFile.isUploadRef) fd.append('musicFileRef', amMusicFile.serverPath);
  else fd.append('musicFile', amMusicFile.file);

  try {
    const res = await fetch('/api/add-music-to-video', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed.');

    showAmStatus('success', '✅ Music mixed successfully!');
    const vidEl = document.getElementById('am-video');
    const dlEl = document.getElementById('am-dl');
    vidEl.src = data.videoUrl + '?t=' + Date.now();
    dlEl.href = data.videoUrl;
    dlEl.download = data.filename;
    document.getElementById('am-result').classList.add('show');
  } catch (err) {
    showAmStatus('error', `❌ ${err.message}`);
  } finally {
    setBtnLoading('am', false);
  }
}

function showAmStatus(type, msg) {
  const box = document.getElementById('am-status');
  const txt = document.getElementById('am-status-text');
  box.style.display = 'block';
  txt.textContent = msg;
  box.style.borderColor = type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--accent)';
}

// ── Media Picker (re-use already-uploaded files) ──────────────────────────────
let _mpTarget = null;   // 'hero' | 'bg' | 'music'
let _mpFilter = null;   // 'image' | 'audio'
let _mpSelected = null; // { url, filename, type }
let _mpAllFiles = [];   // cached from last fetch

async function openMediaPicker(target, filter) {
  _mpTarget = target;
  _mpFilter = filter;
  _mpSelected = null;

  const titles = { hero: '🦸 Choose Hero Image', bg: '🏞 Choose Background Image', music: '🎵 Choose Music File', 'bridge-music': '🎵 Choose Bridge Music File', 'am-music': '🎵 Choose Music File', 'ss-music': '🎵 Choose Music File' };
  document.getElementById('media-picker-title').textContent = titles[target] || '📂 Choose from Uploads';
  document.getElementById('media-picker-select-btn').disabled = true;
  document.getElementById('media-picker-modal').classList.add('show');

  renderMediaPickerGrid([], true); // show loading state

  try {
    const res = await fetch('/api/uploads');
    const data = await res.json();
    _mpAllFiles = data.files || [];
  } catch {
    _mpAllFiles = [];
  }

  renderMediaPickerFilters();
  renderMediaPickerGrid(_mpAllFiles.filter(f => f.type === _mpFilter));
}

function closeMediaPicker() {
  document.getElementById('media-picker-modal').classList.remove('show');
  _mpTarget = null;
  _mpSelected = null;
}

function renderMediaPickerFilters() {
  // Show toggle only if both image and audio files exist (future-proof)
  document.getElementById('media-picker-filters').innerHTML = '';
}

function renderMediaPickerGrid(files, loading = false) {
  const grid = document.getElementById('media-picker-grid');
  if (loading) {
    grid.innerHTML = '<div class="media-picker-empty">Loading uploads…</div>';
    return;
  }
  if (!files.length) {
    grid.innerHTML = '<div class="media-picker-empty">No previously uploaded files found.<br><small>Upload a file first, then it will appear here.</small></div>';
    return;
  }

  grid.innerHTML = files.map(f => {
    const isImage = f.type === 'image';
    const sizeStr = f.size > 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + ' MB' : (f.size / 1024).toFixed(0) + ' KB';
    const shortName = f.filename.replace(/^\d+-[\da-f]+-?/, '').slice(0, 20) || f.filename.slice(-20);
    const thumb = isImage
      ? `<img src="${f.url}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><div class="mp-icon" style="display:none">🖼</div>`
      : `<div class="mp-icon">🎵</div>`;
    return `<div class="media-picker-item" data-url="${f.url}" data-filename="${f.filename}" data-type="${f.type}" onclick="selectMediaItem(this)">
      ${thumb}
      <div class="mp-name" title="${f.filename}">${shortName}</div>
      <div class="mp-size">${sizeStr}</div>
    </div>`;
  }).join('');
}

function selectMediaItem(el) {
  document.querySelectorAll('.media-picker-item').forEach(i => i.classList.remove('selected'));
  el.classList.add('selected');
  _mpSelected = { url: el.dataset.url, filename: el.dataset.filename, type: el.dataset.type };
  document.getElementById('media-picker-select-btn').disabled = false;
}

// BUG FIX: confirmMediaPick no longer re-uploads files — uses server path reference instead
function confirmMediaPick() {
  if (!_mpSelected || !_mpTarget) return;

  const serverPath = _mpSelected.url;   // e.g. /uploads/1234-abcd.png
  const filename = _mpSelected.filename;
  const sizeStr = '(from uploads)';

  if (_mpTarget === 'hero') {
    // Push as upload reference — no binary re-upload
    if (storyHeroFiles.length < MAX_HERO_IMAGES) {
      storyHeroFiles.push({ file: null, isUploadRef: true, serverPath, name: filename, size: 0, thumbUrl: serverPath });
      renderHeroPills();
      updateHeroDropzoneVisibility();
    }
  } else if (_mpTarget === 'bg') {
    storyBgFile = { file: null, isUploadRef: true, serverPath, name: filename };
    const pill = document.getElementById('pill-story-bg');
    const thumb = document.getElementById('thumb-story-bg');
    const nameEl = document.getElementById('name-story-bg');
    const sizeEl = document.getElementById('size-story-bg');
    const dz = document.getElementById('dz-story-bg');
    thumb.src = serverPath;
    nameEl.textContent = filename;
    sizeEl.textContent = sizeStr;
    pill.classList.add('show');
    dz.style.display = 'none';
  } else if (_mpTarget === 'music') {
    storyMusicFile = { file: null, isUploadRef: true, serverPath, name: filename };
    document.getElementById('music-label').innerHTML = `🎵 <strong>${filename}</strong> (from uploads)`;
  } else if (_mpTarget === 'bridge-music') {
    bridgeMusicFile = { file: null, isUploadRef: true, serverPath, name: filename };
    document.getElementById('bridge-music-label').innerHTML = `🎵 <strong>${filename}</strong> (from uploads)`;
  } else if (_mpTarget === 'am-music') {
    amMusicFile = { file: null, isUploadRef: true, serverPath, name: filename };
    document.getElementById('am-music-label').innerHTML = `🎵 <strong>${filename}</strong> (from uploads)`;
  } else if (_mpTarget === 'ss-music') {
    ssMusicFile = { file: null, isUploadRef: true, serverPath, name: filename };
    document.getElementById('ss-music-label').innerHTML = `🎵 <strong>${filename}</strong> (from uploads)`;
    document.getElementById('ss-volume-row').style.display = '';
    document.getElementById('ss-music-clear-btn').style.display = '';
  }

  closeMediaPicker();
}

function handleStoryImagePick(input, type) {
  // Only used for bg (hero now uses handleHeroImagesPick)
  const file = input.files[0];
  if (!file) return;
  storyBgFile = { file, isUploadRef: false, name: file.name };

  const pill = document.getElementById(`pill-story-${type}`);
  const thumb = document.getElementById(`thumb-story-${type}`);
  const name = document.getElementById(`name-story-${type}`);
  const size = document.getElementById(`size-story-${type}`);
  const dz = document.getElementById(`dz-story-${type}`);

  thumb.src = URL.createObjectURL(file);
  name.textContent = file.name;
  size.textContent = (file.size / 1024).toFixed(0) + ' KB';
  pill.classList.add('show');
  dz.style.display = 'none';
}

function clearStoryImage(type) {
  if (type === 'bg') {
    storyBgFile = null;
    document.getElementById('story-bg-image').value = '';
    document.getElementById('pill-story-bg').classList.remove('show');
    document.getElementById('dz-story-bg').style.display = '';
  }
}

// Drag-and-drop for story image dropzones
['hero', 'bg'].forEach(type => {
  const dz = document.getElementById(`dz-story-${type}`);
  if (!dz) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('over');
    if (type === 'hero') {
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
      for (const file of files) {
        if (storyHeroFiles.length >= MAX_HERO_IMAGES) break;
        storyHeroFiles.push({ file, isUploadRef: false, name: file.name, size: file.size, thumbUrl: URL.createObjectURL(file) });
      }
      renderHeroPills();
      updateHeroDropzoneVisibility();
    } else {
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        const input = document.getElementById('story-bg-image');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        handleStoryImagePick(input, type);
      }
    }
  });
});

async function submitStory() {
  const storyText = document.getElementById('story-text').value.trim();
  const durationRange = getStoryDurationRange();
  const videoModel = document.getElementById('story-video-model').value;
  const gameContext = document.getElementById('story-game-context').value.trim();
  const heroDesc = document.getElementById('story-hero-desc').value.trim();
  const voiceDesc = document.getElementById('story-voice-desc').value.trim();

  // Story text is optional when a valid planning JSON is provided
  const planJsonRaw = document.getElementById('plan-json-input')?.value?.trim();
  const hasPlanJson = !!(_normalizePlanInput(planJsonRaw));
  if (!storyText && !hasPlanJson) {
    setStatus('story', 'error', '⚠ Please enter a story or script, or paste a Planning JSON.');
    return;
  }

  const btn = document.getElementById('btn-story');
  const btnText = document.getElementById('story-btn-text');
  const spinner = document.getElementById('story-spinner');
  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnText.textContent = 'Submitting...';
  setStatus('story', 'loading', 'Submitting story to AI pipeline...');

  try {
    // Use FormData for multipart upload (hero/bg images + text fields)
    const fd = new FormData();
    const pipelineMode = document.querySelector('input[name="pipelineMode"]:checked')?.value || 'standard';
    const runMode = document.querySelector('input[name="runMode"]:checked')?.value || 'auto';
    fd.append('storyText', storyText);
    fd.append('durationRange', durationRange);
    fd.append('videoModel', videoModel);
    fd.append('pipelineMode', pipelineMode);
    fd.append('runMode', runMode);
    fd.append('gameContext', gameContext);
    fd.append('heroDesc', heroDesc);
    fd.append('voiceDesc', voiceDesc);
    // Hero images: binary uploads or upload-refs (no re-upload)
    for (const h of storyHeroFiles) {
      if (h.isUploadRef) fd.append('heroImagePaths[]', h.serverPath);
      else fd.append('heroImages', h.file);
    }
    // Named heroes from catalog
    if (storyNamedHeroes.length > 0) fd.append('namedHeroes', JSON.stringify(storyNamedHeroes));
    // Background image
    if (storyBgFile) {
      if (storyBgFile.isUploadRef) fd.append('bgImageRef', storyBgFile.serverPath);
      else fd.append('bgImage', storyBgFile.file);
    }
    // Music file
    if (storyMusicFile) {
      if (storyMusicFile.isUploadRef) fd.append('musicFileRef', storyMusicFile.serverPath);
      else fd.append('musicFile', storyMusicFile.file);
    }
    // Planning JSON (optional — skips AI planning if valid)
    // Normalize first: accept bare array or full object
    const planJsonRaw = document.getElementById('plan-json-input')?.value?.trim();
    if (planJsonRaw) {
      const normalized = _normalizePlanInput(planJsonRaw);
      if (normalized) fd.append('planningJson', JSON.stringify(normalized));
    }

    const res = await fetch('/api/generate-story', {
      method: 'POST',
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed.');

    activeStoryUUID = data.taskUUID;
    setStatus('story', 'success', `✅ Pipeline started (UUID: ${data.taskUUID}). Watch progress →`);
    startStoryPolling(data.taskUUID);
  } catch (err) {
    setStatus('story', 'error', `❌ ${err.message}`);
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.textContent = '📖 Generate Story Video';
  }
}

function startStoryPolling(taskUUID) {
  stopStoryPolling();
  pollStoryDetail(taskUUID); // immediate first poll
  storyPollInterval = setInterval(() => pollStoryDetail(taskUUID), 3000);
}

function stopStoryPolling() {
  if (storyPollInterval) { clearInterval(storyPollInterval); storyPollInterval = null; }
}

async function pollStoryDetail(taskUUID) {
  try {
    const res = await fetch(`/api/story-history/${taskUUID}`);
    const data = await res.json();
    if (!data.entry) return;
    renderStoryProgress(data.entry);

    // Stop polling if done or paused
    if (data.entry.status === 'completed' || data.entry.status === 'paused' || data.entry.status === 'failed') {
      stopStoryPolling();
    }
  } catch {}
}

function renderStoryProgress(entry) {
  activeStoryUUID = entry.taskUUID;

  // Phase bar
  const phases = ['planning', 'images', 'videos', 'concat', 'done'];
  const currentIdx = phases.indexOf(entry.currentPhase || 'planning');
  document.querySelectorAll('#story-phase-bar .phase-step').forEach((el, i) => {
    el.classList.remove('active', 'done');
    if (i < currentIdx) el.classList.add('done');
    else if (i === currentIdx) el.classList.add('active');
  });

  // Resume bar
  const resumeBar = document.getElementById('story-resume-bar');
  const btnResubmitImg = document.getElementById('btn-resubmit-images');
  const btnResubmitVid = document.getElementById('btn-resubmit-videos');
  if (entry.status === 'paused') {
    resumeBar.style.display = 'flex';
    resumeBar.querySelector('.resume-text').textContent = `⚠ ${entry.error || 'Pipeline paused'}`;
    // Show resubmit-images button only during image phase
    if (btnResubmitImg) {
      btnResubmitImg.style.display = (entry.currentPhase === 'images') ? '' : 'none';
      btnResubmitImg.disabled = false;
      btnResubmitImg.textContent = '🔁 Re-submit All Images';
    }
    // Show resubmit-videos button only during video phase
    if (btnResubmitVid) {
      btnResubmitVid.style.display = (entry.currentPhase === 'videos') ? '' : 'none';
      btnResubmitVid.disabled = false;
      btnResubmitVid.textContent = '🔁 Re-submit All Videos';
    }
  } else {
    resumeBar.style.display = 'none';
    if (btnResubmitImg) { btnResubmitImg.disabled = false; btnResubmitImg.textContent = '🔁 Re-submit All Images'; }
    if (btnResubmitVid) { btnResubmitVid.disabled = false; btnResubmitVid.textContent = '🔁 Re-submit All Videos'; }
  }

  // Voice-over characteristics (auto-generated or user-provided)
  const voiceInfoEl = document.getElementById('story-voice-info');
  if (entry.voiceOverCharacteristics) {
    voiceInfoEl.style.display = 'block';
    voiceInfoEl.innerHTML = `<strong>🎙 Voice-over:</strong> ${entry.voiceOverCharacteristics}`;
  } else {
    voiceInfoEl.style.display = 'none';
  }

  // Copy Planning JSON button — shown once scenes are available
  const planJsonBtnWrap = document.getElementById('copy-plan-json-wrap');
  if (planJsonBtnWrap) {
    if (entry.scenes && entry.scenes.length > 0) {
      planJsonBtnWrap.style.display = 'flex';
      planJsonBtnWrap._entry = entry;
    } else {
      planJsonBtnWrap.style.display = 'none';
    }
  }

  // Scene tracker
  const tracker = document.getElementById('scene-tracker');
  if (!entry.scenes || entry.scenes.length === 0) {
    if (entry.currentPhase === 'planning' && entry.status === 'processing') {
      tracker.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px"><div style="font-size:24px;margin-bottom:6px">🤖</div>AI is planning scenes...</div>';
    } else {
      tracker.innerHTML = '<div class="history-empty" style="padding:20px">No scenes yet.</div>';
    }
  } else {
    const isFastPacedEntry = (entry.pipelineMode === 'fast-paced');
    tracker.innerHTML = entry.scenes.map((s, i) => {
      const vidClass = `ss-${s.videoStatus}`;
      const vidIcon = s.videoStatus === 'completed' ? '✅' : s.videoStatus === 'generating' ? '⏳' : s.videoStatus === 'failed' ? '❌' : '—';

      const isFirstScene = (i === 0);
      const isLastScene = (i === entry.scenes.length - 1);
      const hasCTA = isLastScene && s.ctaImagePrompt;
      const hasImgB = !isFastPacedEntry && isFirstScene && s.imageBPrompt;

      // Image A / main image status
      const imgClass = `ss-${s.imageStatus}`;
      const imgIcon = s.imageStatus === 'completed' ? '✅' : s.imageStatus === 'generating' ? '⏳' : s.imageStatus === 'failed' ? '❌' : '—';

      // Image B status (standard mode, first scene only)
      const imgBIcon = hasImgB ? (s.imageBStatus === 'completed' ? '✅' : s.imageBStatus === 'generating' ? '⏳' : s.imageBStatus === 'failed' ? '❌' : '—') : '';

      // CTA image status (last scene only)
      const ctaIcon = hasCTA ? (s.ctaImageStatus === 'completed' ? '✅' : s.ctaImageStatus === 'generating' ? '⏳' : s.ctaImageStatus === 'failed' ? '❌' : '—') : '';

      const isActive = entry.currentSceneIndex === i && entry.status === 'processing';
      // Fast-paced: no standard "last scene has no image" — all scenes have imageStatus
      const imgActuallyFailed = isFastPacedEntry
        ? (s.imageStatus === 'failed')
        : (!isLastScene && s.imageStatus === 'failed');
      const isFailed = imgActuallyFailed || s.videoStatus === 'failed' || (hasCTA && s.ctaImageStatus === 'failed') || (hasImgB && s.imageBStatus === 'failed');
      const rowClass = isActive ? 'active' : isFailed ? 'failed' : (s.videoStatus === 'completed' ? 'completed' : '');

      const pipelineIdle = (entry.status !== 'processing');

      let actions = '';
      if (isFailed && entry.status === 'paused') {
        actions = `
          <button class="btn-sm" onclick="openEditModal(${i})" title="Edit prompt">✏️</button>
          <button class="btn-sm green" onclick="retryScene(${i})" title="Retry">🔄</button>`;
      }

      // ── Image thumbnails + regen buttons ──
      const imgDone = (isFastPacedEntry || !isLastScene) && s.imageStatus === 'completed' && s.imageUrl;
      const imgBDone = hasImgB && s.imageBStatus === 'completed' && s.imageBUrl;
      const ctaDone = hasCTA && s.ctaImageStatus === 'completed' && s.ctaImageUrl;
      const anyImgDone = imgDone || imgBDone || ctaDone;

      if (imgDone) {
        actions += `<img class="scene-thumb" src="${s.imageUrl}?t=${Date.now()}" onclick="window.open('${s.imageUrl}','_blank')" title="View opening frame" />`;
      }
      if (imgBDone) {
        actions += `<img class="scene-thumb" src="${s.imageBUrl}?t=${Date.now()}" onclick="window.open('${s.imageBUrl}','_blank')" title="View frame B image" style="border:2px solid #4ecdc4" />`;
      }
      if (ctaDone) {
        actions += `<img class="scene-thumb" src="${s.ctaImageUrl}?t=${Date.now()}" onclick="window.open('${s.ctaImageUrl}','_blank')" title="View CTA image" style="border:2px solid var(--accent)" />`;
      }
      // Regen image button — shown when any image is done and pipeline is idle
      if (anyImgDone && pipelineIdle) {
        actions += `<button class="btn-sm" onclick="regenSceneImage(${i})" title="Regenerate image(s) for this scene" style="font-size:10px">🖼 Regen</button>`;
      }

      // ── Video preview + regen button ──
      if (s.videoStatus === 'completed' && s.videoUrl) {
        actions += `<button class="btn-sm" onclick="window.open('${s.videoUrl}','_blank')" title="Preview video">▶</button>`;
        if (pipelineIdle) {
          actions += `<button class="btn-sm" onclick="regenSceneVideo(${i})" title="Regenerate video for this scene" style="font-size:10px">🎬 Regen</button>`;
        }
      }

      const errorMsg = s.imageError || (hasImgB && s.imageBError) || s.videoError || (hasCTA && s.ctaImageError) || '';

      // Reference image badges
      let refBadges = '';
      if (s.useHeroRef) refBadges += '<span class="ref-badge hero" title="Hero reference">🦸</span>';
      if (s.useBgRef) refBadges += '<span class="ref-badge bg" title="BG reference">🏞</span>';
      if (isLastScene) refBadges += '<span class="ref-badge cta" title="CTA frame">🎯</span>';

      // Build status badges based on mode + scene type
      let statusBadges = '';
      if (isFastPacedEntry) {
        if (isLastScene) {
          // Fast-paced last scene: Img A + CTA + Vid
          statusBadges = `
            <span class="scene-step ${imgClass}" title="Opening frame">${imgIcon} Img A</span>
            ${hasCTA ? `<span class="scene-step ss-${s.ctaImageStatus || 'pending'}" title="CTA Image">${ctaIcon} CTA</span>` : ''}
            <span class="scene-step ${vidClass}" title="Video">${vidIcon} Vid</span>`;
        } else {
          // Fast-paced all other scenes: Img + Vid
          statusBadges = `
            <span class="scene-step ${imgClass}" title="Opening frame">${imgIcon} Img</span>
            <span class="scene-step ${vidClass}" title="Video">${vidIcon} Vid</span>`;
        }
      } else if (isFirstScene) {
        // Standard Scene 1: Img A, Img B, Vid
        statusBadges = `
            <span class="scene-step ${imgClass}" title="Image A (opening frame)">${imgIcon} Img A</span>
            ${hasImgB ? `<span class="scene-step ss-${s.imageBStatus || 'pending'}" title="Image B (end frame)">${imgBIcon} Img B</span>` : ''}
            <span class="scene-step ${vidClass}" title="Video">${vidIcon} Vid</span>`;
      } else if (isLastScene) {
        // Standard last scene: CTA, Vid (no Img badge)
        statusBadges = `
            ${hasCTA ? `<span class="scene-step ss-${s.ctaImageStatus || 'pending'}" title="CTA Image">${ctaIcon} CTA</span>` : ''}
            <span class="scene-step ${vidClass}" title="Video">${vidIcon} Vid</span>`;
      } else {
        // Standard middle scenes: Img, Vid
        statusBadges = `
            <span class="scene-step ${imgClass}" title="Image (end frame)">${imgIcon} Img</span>
            <span class="scene-step ${vidClass}" title="Video">${vidIcon} Vid</span>`;
      }

      // Prompt preview — show most relevant prompt
      const promptPreview = (isFastPacedEntry || !isLastScene) ? (s.imagePrompt || '') : (s.ctaImagePrompt || '');

      return `
        <div class="scene-row ${rowClass}">
          <span class="scene-num">${s.sceneNumber}</span>
          <div class="scene-statuses">
            ${statusBadges}
            ${refBadges ? `<span class="scene-refs">${refBadges}</span>` : ''}
          </div>
          <span class="scene-prompt" title="${promptPreview.replace(/"/g,'&quot;')}">${promptPreview.slice(0,50)}...</span>
          <div class="scene-actions">${actions}</div>
        </div>
        ${errorMsg ? `<div class="scene-error" style="margin-left:32px;margin-top:-4px;margin-bottom:4px">❌ ${errorMsg}</div>` : ''}`;
    }).join('');
  }

  // Final video
  const finalDiv = document.getElementById('story-final');
  if (entry.status === 'completed' && entry.finalVideoUrl) {
    finalDiv.style.display = 'block';
    document.getElementById('story-final-video').src = entry.finalVideoUrl + '?t=' + Date.now();
    document.getElementById('story-final-dl').href = entry.finalVideoUrl;
    document.getElementById('story-total-cost').textContent = entry.totalCost ? `Total cost: $${parseFloat(entry.totalCost).toFixed(4)}` : '';
  } else {
    finalDiv.style.display = 'none';
  }
}

async function resumeStory() {
  if (!activeStoryUUID) return;
  try {
    const res = await fetch(`/api/resume-story/${activeStoryUUID}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Resume failed.');
    setStatus('story', 'success', `▶ ${data.message}`);
    startStoryPolling(activeStoryUUID);
  } catch (err) {
    setStatus('story', 'error', `❌ ${err.message}`);
  }
}

async function resubmitAllImages() {
  if (!activeStoryUUID) return;
  const btn = document.getElementById('btn-resubmit-images');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Re-submitting...'; }
  try {
    const res = await fetch(`/api/resubmit-images/${activeStoryUUID}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Re-submit failed.');
    setStatus('story', 'success', `🔁 ${data.message}`);
    startStoryPolling(activeStoryUUID);
  } catch (err) {
    setStatus('story', 'error', `❌ ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '🔁 Re-submit All Images'; }
  }
}

async function resubmitAllVideos() {
  if (!activeStoryUUID) return;
  const btn = document.getElementById('btn-resubmit-videos');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Re-submitting...'; }
  try {
    const res = await fetch(`/api/resubmit-videos/${activeStoryUUID}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Re-submit failed.');
    setStatus('story', 'success', `🔁 ${data.message}`);
    startStoryPolling(activeStoryUUID);
  } catch (err) {
    setStatus('story', 'error', `❌ ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '🔁 Re-submit All Videos'; }
  }
}

async function retryScene(idx) {
  if (!activeStoryUUID) return;
  try {
    const res = await fetch(`/api/retry-scene/${activeStoryUUID}/${idx}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Retry failed.');
    setStatus('story', 'success', `🔄 ${data.message}`);
    startStoryPolling(activeStoryUUID);
  } catch (err) {
    setStatus('story', 'error', `❌ ${err.message}`);
  }
}

async function regenSceneImage(idx) {
  if (!activeStoryUUID) return;
  try {
    const res = await fetch(`/api/regen-image/${activeStoryUUID}/${idx}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Regen failed.');
    setStatus('story', 'loading', `🖼 ${data.message}`);
    startStoryPolling(activeStoryUUID);
  } catch (err) {
    setStatus('story', 'error', `❌ ${err.message}`);
  }
}

async function regenSceneVideo(idx) {
  if (!activeStoryUUID) return;
  try {
    const res = await fetch(`/api/regen-video/${activeStoryUUID}/${idx}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Regen failed.');
    setStatus('story', 'loading', `🎬 ${data.message}`);
    startStoryPolling(activeStoryUUID);
  } catch (err) {
    setStatus('story', 'error', `❌ ${err.message}`);
  }
}

function openEditModal(sceneIdx) {
  editingSceneIndex = sceneIdx;
  // We need to fetch latest scene data
  fetch(`/api/story-history/${activeStoryUUID}`).then(r => r.json()).then(data => {
    const scene = data.entry?.scenes?.[sceneIdx];
    if (!scene) return;
    document.getElementById('edit-modal-scene-num').textContent = scene.sceneNumber;
    document.getElementById('edit-modal-img-prompt').value = scene.imagePrompt || '';
    document.getElementById('edit-modal-vid-prompt').value = scene.videoPrompt || '';
    document.getElementById('edit-prompt-modal').classList.add('show');
  });
}

function closeEditModal() {
  document.getElementById('edit-prompt-modal').classList.remove('show');
  editingSceneIndex = null;
}

async function saveAndRetryScene() {
  if (editingSceneIndex === null || !activeStoryUUID) return;
  const imagePrompt = document.getElementById('edit-modal-img-prompt').value.trim();
  const videoPrompt = document.getElementById('edit-modal-vid-prompt').value.trim();
  closeEditModal();

  try {
    const res = await fetch(`/api/retry-scene/${activeStoryUUID}/${editingSceneIndex}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagePrompt, videoPrompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Retry failed.');
    setStatus('story', 'success', `🔄 ${data.message}`);
    startStoryPolling(activeStoryUUID);
  } catch (err) {
    setStatus('story', 'error', `❌ ${err.message}`);
  }
}

async function loadStoryHistoryList() {
  try {
    const res = await fetch('/api/story-history');
    const data = await res.json();
    renderStoryHistoryList(data.history || []);
  } catch {}
}

function renderStoryHistoryList(history) {
  const list = document.getElementById('story-history-list');
  if (!history.length) {
    list.innerHTML = '<div class="history-empty">No stories yet.</div>';
    return;
  }

  list.innerHTML = history.map(h => {
    const date = new Date(h.submittedAt).toLocaleString();
    const dotClass = h.status === 'completed' ? 'dot-completed' : h.status === 'processing' ? 'dot-pending' : h.status === 'paused' ? 'dot-pending' : h.status === 'pending' ? 'dot-pending' : 'dot-failed';
    const statusLabel = h.status === 'completed' ? '✅ Done' : h.status === 'processing' ? '⏳ Processing' : h.status === 'paused' ? '⏸ Paused' : h.status === 'pending' ? '⏳ Starting' : '❌ Failed';
    const costStr = h.totalCost ? `$${parseFloat(h.totalCost).toFixed(4)}` : '';
    const sceneSummary = h.scenes?.length ? `${h.scenes.filter(s=>s.videoStatus==='completed').length}/${h.scenes.length} scenes done` : 'Planning...';

    return `
      <div class="hist-item ${h.status === 'completed' ? 'completed' : h.status === 'failed' ? 'failed' : 'pending'}">
        <div class="hist-header" onclick="loadStoryDetail('${h.taskUUID}')">
          <span class="hist-status-dot ${dotClass}"></span>
          <div class="hist-info">
            <div class="hist-title">📖 Story${h.pipelineMode === 'fast-paced' ? ' ⚡' : ''} · ${h.scenes?.length || '?'} scenes${h.durationRange ? ` · ${h.durationRange}s` : ''} · ${h.videoModelLabel}</div>
            <div class="hist-meta">${date} · ${sceneSummary} ${costStr ? '· ' + costStr : ''}</div>
          </div>
          <div class="hist-badges">
            <span class="hist-type-badge htb-story">STORY</span>
            <span style="font-size:11px;padding:2px 6px;border-radius:4px;font-weight:600;background:${h.status==='completed'?'rgba(16,185,129,.15)':h.status==='failed'?'rgba(239,68,68,.15)':'rgba(245,158,11,.15)'};color:${h.status==='completed'?'var(--green)':h.status==='failed'?'var(--red)':'var(--yellow)'}">
              ${statusLabel}
            </span>
          </div>
          <span class="hist-chevron">›</span>
        </div>
      </div>`;
  }).join('');
}

async function loadStoryDetail(taskUUID) {
  activeStoryUUID = taskUUID;
  try {
    const res = await fetch(`/api/story-history/${taskUUID}`);
    const data = await res.json();
    if (data.entry) {
      renderStoryProgress(data.entry);
      // If still processing, start polling
      if (data.entry.status === 'processing' || data.entry.status === 'pending') {
        startStoryPolling(taskUUID);
      }
    }
  } catch (err) {
    console.error('Failed to load story detail:', err);
  }
}

async function deleteStoryEntry(taskUUID) {
  if (!confirm('Delete this story and all its generated files?')) return;
  try {
    await fetch(`/api/story-history/${taskUUID}`, { method: 'DELETE' });
    await loadStoryHistoryList();
    if (activeStoryUUID === taskUUID) {
      activeStoryUUID = null;
      document.getElementById('scene-tracker').innerHTML = '<div class="history-empty" style="padding:24px 12px">Submit a story to see scene progress here.</div>';
      document.getElementById('story-final').style.display = 'none';
      document.getElementById('story-resume-bar').style.display = 'none';
    }
  } catch {}
}

// ══════ Split Screen ══════
let ssMusicFile = null; // { file } | { isUploadRef, serverPath, name } | null

function ssSwitchOrientation(which, val) {
  const other = val === 'portrait' ? 'landscape' : 'portrait';
  document.getElementById(`ss-${which}-${val}-card`).classList.add('selected');
  document.getElementById(`ss-${which}-${other}-card`).classList.remove('selected');
  document.getElementById(`ss-${which}-orientation`).value = val;
}

function ssFilePicked(input, which) {
  const file = input.files[0];
  if (!file) return;
  const pill = document.getElementById(`ss-${which}-pill`);
  document.getElementById(`ss-${which}-name`).textContent = file.name;
  document.getElementById(`ss-${which}-size`).textContent = (file.size / 1024 / 1024).toFixed(1) + ' MB';
  pill.classList.add('show');
}

function ssDrop(event, which) {
  event.preventDefault();
  document.getElementById(`ss-${which}-dz`).classList.remove('over');
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const input = document.getElementById(`ss-${which}-input`);
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  ssFilePicked(input, which);
}

function ssClearFile(which) {
  document.getElementById(`ss-${which}-input`).value = '';
  document.getElementById(`ss-${which}-pill`).classList.remove('show');
}

function handleSsMusicFilePick(input) {
  const file = input.files[0];
  if (!file) return;
  ssMusicFile = { file, isUploadRef: false, name: file.name };
  document.getElementById('ss-music-label').innerHTML = `🎵 <strong>${file.name}</strong> (${(file.size/1024).toFixed(0)} KB)`;
  document.getElementById('ss-volume-row').style.display = '';
  document.getElementById('ss-music-clear-btn').style.display = '';
}

function ssClearMusic() {
  ssMusicFile = null;
  document.getElementById('ss-music-input').value = '';
  document.getElementById('ss-music-label').innerHTML = 'Drop music file or <strong>click to browse</strong>';
  document.getElementById('ss-volume-row').style.display = 'none';
  document.getElementById('ss-music-clear-btn').style.display = 'none';
}

function ssSetStatus(type, msg) {
  const box = document.getElementById('ss-status');
  const text = document.getElementById('ss-status-text');
  box.className = 'status-box show ' + type;
  text.textContent = msg;
}

async function submitSplitScreen() {
  const podcastFile = document.getElementById('ss-podcast-input').files[0];
  const ugcFile     = document.getElementById('ss-ugc-input').files[0];
  if (!podcastFile) return ssSetStatus('error', 'Please select a podcast video.');
  if (!ugcFile)     return ssSetStatus('error', 'Please select a UGC video.');

  const podcastOrientation = document.getElementById('ss-podcast-orientation').value;
  const ugcOrientation     = document.getElementById('ss-ugc-orientation').value;
  const musicVolume        = document.getElementById('ss-volume').value;

  const btn     = document.getElementById('ss-submit-btn');
  const spinner = document.getElementById('ss-spinner');
  const btnText = document.getElementById('ss-btn-text');
  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnText.textContent = 'Processing…';
  ssSetStatus('loading', 'Uploading and compositing — this may take a while…');
  document.getElementById('ss-result').classList.remove('show');

  const fd = new FormData();
  fd.append('podcast', podcastFile);
  fd.append('ugc', ugcFile);
  fd.append('podcastOrientation', podcastOrientation);
  fd.append('ugcOrientation', ugcOrientation);
  fd.append('musicVolume', musicVolume);
  if (ssMusicFile) {
    if (ssMusicFile.isUploadRef) fd.append('musicFileRef', ssMusicFile.serverPath);
    else fd.append('music', ssMusicFile.file);
  }

  try {
    const res  = await fetch('/api/splitscreen', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Server error');
    ssSetStatus('success', 'Split screen created!');
    const video = document.getElementById('ss-video');
    const dl    = document.getElementById('ss-dl');
    video.src = data.url;
    dl.href   = data.url;
    dl.download = data.filename;
    document.getElementById('ss-result').classList.add('show');
    video.play().catch(() => {});
  } catch (err) {
    ssSetStatus('error', 'Error: ' + err.message);
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.textContent = '✂️ Create Split Screen';
  }
}

// ══════ Start ══════
setupDropzone('img-input','img-dz','img-pill','img-name','img-size','img-thumb','image');
setupDropzone('aud-input','aud-dz','aud-pill','aud-name','aud-size',null,'audio');
setupDropzone('bvid-input','bvid-dz','bvid-pill','bvid-name','bvid-size',null,'video');
setupDropzone('bcta-input','bcta-dz','bcta-pill','bcta-name','bcta-size','bcta-thumb','image');
// Clear folder selection when user uploads a CTA file
document.getElementById('bcta-input').addEventListener('change', () => {
  if (document.getElementById('bcta-input').files[0]) {
    _bctaFolderUrl = null;
    document.querySelectorAll('.bcta-folder-item').forEach(i => {
      i.style.borderColor = 'var(--border)';
      i.style.boxShadow = '';
    });
  }
});
setupDropzone('ls-vid-input','ls-vid-dz','ls-vid-pill','ls-vid-name','ls-vid-size',null,'video');
setupDropzone('ls-aud-input','ls-aud-dz','ls-aud-pill','ls-aud-name','ls-aud-size',null,'audio');
init();
