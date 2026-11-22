// ── State ──
let me = null;
let currentConversationId = null;
let currentModel = null;
let systemPrompt = localStorage.getItem('systemPrompt') || '';
let generating = false;

// WebLLM engine (the AI runs here, in the browser)
let engine = null;
let engineModel = null;
let webllmModPromise = null;

const SYSTEM_PROMPT =
  'You are RishiAI, a helpful AI assistant. When you produce a complete, ' +
  'self-contained document, web page, or code file (especially HTML or SVG), ' +
  'put it in a single fenced code block with a correct language tag (e.g. ```html) ' +
  'so the interface can render it as a live, previewable artifact. Keep prose outside the code block.';

// Preferred models, best-first. We match these against WebLLM's live model list
// so the IDs are always valid for whatever library version loads.
const MODEL_PREFS = [
  { match: 'Llama-3.2-1B-Instruct', label: 'Llama 3.2 1B · fastest (~0.9 GB)' },
  { match: 'Qwen2.5-1.5B-Instruct', label: 'Qwen2.5 1.5B · balanced (~1.1 GB)' },
  { match: 'Llama-3.2-3B-Instruct', label: 'Llama 3.2 3B · smarter (~2.3 GB)' },
  { match: 'Phi-3.5-mini-instruct', label: 'Phi-3.5 mini · smarter (~2.2 GB)' },
];
const MODEL_FALLBACK = [
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B · fastest (~0.9 GB)' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 1.5B · balanced (~1.1 GB)' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B · smarter (~2.3 GB)' },
];
let modelOptions = []; // [{id,label}]

const $ = (id) => document.getElementById(id);

marked.setOptions({
  breaks: true,
  highlight: (code, lang) => {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    } catch (_) { return code; }
  },
});

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || ''));
}

// ── Theme ──
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
}
applyTheme(localStorage.getItem('theme') || 'light');
$('btn-theme').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
};

// ── WebLLM loading ──
function loadWebllm() {
  if (!webllmModPromise) webllmModPromise = import('https://esm.run/@mlc-ai/web-llm');
  return webllmModPromise;
}

function modelLabel(id) {
  const m = modelOptions.find((o) => o.id === id);
  return m ? m.label : id;
}

function setModelStatus(text, pct) {
  const el = $('model-status');
  el.classList.remove('hidden');
  el.innerHTML = `<span>${escapeHtml(text)}</span><div class="ms-bar"><div class="ms-fill" style="width:${pct || 0}%"></div></div>`;
}
function hideModelStatus() { $('model-status').classList.add('hidden'); }

async function ensureEngine(modelId) {
  if (engine && engineModel === modelId) return engine;
  if (!('gpu' in navigator) || !navigator.gpu) {
    const e = new Error('NO_WEBGPU'); e.code = 'NO_WEBGPU'; throw e;
  }
  const webllm = await loadWebllm();
  if (engine) { try { await engine.unload(); } catch (_) {} engine = null; engineModel = null; }
  setModelStatus('Preparing ' + modelLabel(modelId) + '… first load downloads the model (once).', 1);
  engine = await webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (r) => {
      const pct = Math.round((r.progress || 0) * 100);
      setModelStatus((r.text || 'Loading model') + (pct ? ' · ' + pct + '%' : ''), pct);
    },
  });
  engineModel = modelId;
  hideModelStatus();
  return engine;
}

// Build the model picker from WebLLM's live catalog (falls back if offline).
async function initModels() {
  const sel = $('model-select');
  modelOptions = [];
  try {
    const webllm = await loadWebllm();
    const list = (webllm.prebuiltAppConfig && webllm.prebuiltAppConfig.model_list) || [];
    const ids = list.map((m) => m.model_id);
    for (const pref of MODEL_PREFS) {
      const hit = ids.find((id) => id.includes(pref.match) && id.includes('q4f16_1')) ||
                  ids.find((id) => id.includes(pref.match));
      if (hit && !modelOptions.some((o) => o.id === hit)) modelOptions.push({ id: hit, label: pref.label });
    }
  } catch (_) { /* offline / import failed — use fallback below */ }
  if (modelOptions.length === 0) modelOptions = MODEL_FALLBACK.slice();

  sel.innerHTML = '';
  modelOptions.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = o.id; opt.textContent = o.label;
    sel.appendChild(opt);
  });
  currentModel = modelOptions[0].id;
  sel.value = currentModel;
  sel.onchange = () => { currentModel = sel.value; }; // engine reloads lazily on next send
}

// ── Boot ──
async function boot() {
  const res = await fetch('/api/me');
  const data = await res.json();
  if (!data.user) {
    $('auth-screen').classList.remove('hidden');
    $('app').classList.add('hidden');
    $('btn-google').style.display = data.googleEnabled ? '' : 'none';
    return;
  }
  me = data.user;
  $('auth-screen').classList.add('hidden');
  $('app').classList.remove('hidden');

  await initModels();

  $('user-name').textContent = me.name + (me.email ? ` · ${me.email}` : '');
  renderQuota(data.quota);
  await loadConversations();

  if (!('gpu' in navigator) || !navigator.gpu) {
    showBanner('Heads up: this browser can’t run the in-browser model (no WebGPU). Use Chrome or Edge on a desktop/laptop to chat.');
  }
}

function renderQuota(q) {
  $('plan-badge').textContent = (q.tier || 'free').toUpperCase();
  let text = '';
  if (q.tier === 'free') {
    text = `${q.messagesUsed || 0}/${q.messagesLimit} messages today`;
    if (!q.allowed && q.reason) text = q.reason;
  } else if (q.tier === 'pro') {
    text = q.allowed ? 'Pro · available until 6pm SGT' : (q.reason || 'Closed until midnight SGT');
  } else if (q.tier === 'max') {
    text = 'Max · unlimited';
  }
  $('quota').textContent = text;
  $('btn-upgrade').style.display = q.tier === 'max' ? 'none' : '';
}

// ── Auth actions ──
$('btn-guest').onclick = async () => {
  await fetch('/api/auth/guest', { method: 'POST' });
  boot();
};
$('btn-google').onclick = () => { window.location.href = '/api/auth/google'; };
$('btn-logout').onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
};

// ── Conversations ──
async function loadConversations() {
  const res = await fetch('/api/conversations');
  const list = await res.json();
  const el = $('conv-list');
  el.innerHTML = '';
  list.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id == currentConversationId ? ' active' : '');
    item.innerHTML = `<span>${escapeHtml(c.title)}</span><span class="del" title="Delete">✕</span>`;
    item.querySelector('span').onclick = () => openConversation(c.id);
    item.onclick = (e) => { if (!e.target.classList.contains('del')) openConversation(c.id); };
    item.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/conversations/${c.id}`, { method: 'DELETE' });
      if (c.id == currentConversationId) newChat();
      loadConversations();
    };
    el.appendChild(item);
  });
}

async function openConversation(id) {
  currentConversationId = id;
  const res = await fetch(`/api/conversations/${id}`);
  const data = await res.json();
  $('messages').innerHTML = '';
  data.messages.forEach((m) => addMessage(m.role, m.content));
  loadConversations();
  closeSidebar();
}

function newChat() {
  currentConversationId = null;
  $('messages').innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.innerHTML = '<div class="logo-dot big"></div><h2>How can I help you today?</h2>';
  $('messages').appendChild(empty);
  loadConversations();
}
$('btn-new').onclick = newChat;

// ── Rendering messages ──
function addMessage(role, content) {
  const empty = $('messages').querySelector('.empty-state');
  if (empty) empty.remove();
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `
    <div class="role">${role === 'user' ? 'You' : 'AI'}</div>
    <div class="body"></div>`;
  const body = wrap.querySelector('.body');
  if (role === 'assistant') {
    body.innerHTML = renderMarkdown(content);
    processArtifacts(body);
    addCopyButton(wrap, () => content);
  } else {
    body.textContent = content;
  }
  $('messages').appendChild(wrap);
  scrollDown();
  return body;
}

function addCopyButton(wrap, getText) {
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.onclick = () => { navigator.clipboard.writeText(getText()); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1200); };
  actions.appendChild(copy);
  wrap.querySelector('.body').appendChild(actions);
}

function scrollDown() { const m = $('messages'); m.scrollTop = m.scrollHeight; }
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ── Artifacts (Claude-style live preview panel) ──
const artifacts = {};
let artifactSeq = 0;

function processArtifacts(bodyEl) {
  bodyEl.querySelectorAll('pre').forEach((pre) => {
    const codeEl = pre.querySelector('code');
    if (!codeEl) return;
    const code = codeEl.textContent || '';
    const m = (codeEl.className || '').match(/language-([\w-]+)/);
    const lang = m ? m[1].toLowerCase() : '';
    const lines = code.split('\n').length;
    const isWeb = ['html', 'svg', 'xml'].includes(lang) || /^\s*(<!doctype html|<html[\s>]|<svg[\s>])/i.test(code);
    const big = lines >= 15;
    if (!isWeb && !big) return;

    const id = 'a' + (++artifactSeq);
    const kind = isWeb ? 'web' : 'code';
    const title = isWeb ? 'Live preview' : ((lang || 'code') + ' file');
    artifacts[id] = { code, lang, kind, title };

    const card = document.createElement('div');
    card.className = 'artifact-card';
    card.innerHTML = `<span class="art-ic">${kind === 'web' ? '🖼️' : '📄'}</span>` +
      `<span class="art-meta"><b>${escapeHtml(title)}</b><small>${escapeHtml(lang || 'text')} · ${lines} lines</small></span>` +
      `<span class="art-open">Open ›</span>`;
    card.onclick = () => openArtifact(id);
    pre.replaceWith(card);
  });
}

function openArtifact(id) {
  const a = artifacts[id];
  if (!a) return;
  $('artifact-panel').classList.remove('hidden');
  $('artifact-panel').dataset.id = id;
  $('artifact-title').textContent = a.title;

  const codeHost = $('artifact-code').querySelector('code');
  codeHost.className = a.lang ? 'language-' + a.lang : '';
  codeHost.textContent = a.code;
  try { hljs.highlightElement(codeHost); } catch (_) {}

  if (a.kind === 'web') {
    const hasDoc = /<!doctype|<html[\s>]/i.test(a.code);
    $('artifact-frame').srcdoc = hasDoc ? a.code
      : `<!doctype html><meta charset="utf-8"><body style="margin:0;font-family:sans-serif">${a.code}</body>`;
    $('tab-preview').style.display = '';
    setArtifactTab('preview');
  } else {
    $('tab-preview').style.display = 'none';
    setArtifactTab('code');
  }
  closeSidebar();
}

function setArtifactTab(tab) {
  $('artifact-frame').classList.toggle('hidden', tab !== 'preview');
  $('artifact-code').classList.toggle('hidden', tab !== 'code');
  $('tab-preview').classList.toggle('active', tab === 'preview');
  $('tab-code').classList.toggle('active', tab === 'code');
}

$('tab-preview').onclick = () => setArtifactTab('preview');
$('tab-code').onclick = () => setArtifactTab('code');
$('artifact-close').onclick = () => $('artifact-panel').classList.add('hidden');
$('artifact-copy').onclick = () => {
  const a = artifacts[$('artifact-panel').dataset.id];
  if (a) navigator.clipboard.writeText(a.code);
};
$('artifact-download').onclick = () => {
  const a = artifacts[$('artifact-panel').dataset.id];
  if (!a) return;
  const ext = a.kind === 'web' ? 'html' : (a.lang || 'txt');
  const url = URL.createObjectURL(new Blob([a.code], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url; link.download = `artifact.${ext}`; link.click();
  URL.revokeObjectURL(url);
};

// ── Sending ──
const input = $('input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
});

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || generating) return;

  if (!('gpu' in navigator) || !navigator.gpu) {
    showBanner('This browser can’t run the in-browser model (no WebGPU). Use Chrome or Edge on a desktop/laptop.');
    return;
  }

  const userBody = addMessage('user', text);
  input.value = '';
  input.style.height = 'auto';
  $('banner').classList.add('hidden');

  // Step 1: save the user message + enforce quota, get conversation history.
  let data;
  try {
    const r = await fetch('/api/chat/user', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: currentConversationId, message: text }),
    });
    if (r.status === 429) {
      const err = await r.json();
      userBody.closest('.msg').remove();
      showBanner(err.error || 'Limit reached.');
      await refreshQuota();
      return;
    }
    if (!r.ok) { userBody.closest('.msg').remove(); showBanner('Server error saving message.'); return; }
    data = await r.json();
  } catch (_) {
    userBody.closest('.msg').remove();
    showBanner('Connection error.');
    return;
  }
  currentConversationId = data.conversationId;

  // Step 2: generate the reply locally, in the browser.
  const assistantBody = addMessage('assistant', '');
  assistantBody.classList.add('cursor-blink');
  let full = '';
  generating = true;
  toggleSending(true);

  try {
    const eng = await ensureEngine(currentModel);
    const msgs = [{ role: 'system', content: SYSTEM_PROMPT + (systemPrompt ? '\n\n' + systemPrompt : '') }];
    data.messages.forEach((m) => msgs.push({ role: m.role, content: m.content }));

    const chunks = await eng.chat.completions.create({
      messages: msgs, stream: true, temperature: 0.7, max_tokens: 1024,
    });
    for await (const chunk of chunks) {
      const d = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) || '';
      if (d) {
        full += d;
        assistantBody.classList.remove('cursor-blink');
        assistantBody.innerHTML = renderMarkdown(full);
        scrollDown();
      }
    }
  } catch (err) {
    assistantBody.classList.remove('cursor-blink');
    if (err && err.code === 'NO_WEBGPU') {
      assistantBody.innerHTML = renderMarkdown('⚠️ This browser can’t run the model (no WebGPU). Use Chrome or Edge on a desktop/laptop.');
    } else if (!/interrupt/i.test(String(err && err.message))) {
      assistantBody.innerHTML = renderMarkdown('⚠️ Model error: ' + escapeHtml(String(err && err.message || 'unknown')));
    }
    hideModelStatus();
  }

  assistantBody.classList.remove('cursor-blink');
  if (full) {
    assistantBody.innerHTML = renderMarkdown(full);
    processArtifacts(assistantBody);
    addCopyButton(assistantBody.closest('.msg'), () => full);
    // Step 3: persist the assistant reply.
    try {
      await fetch('/api/chat/assistant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: currentConversationId, content: full }),
      });
    } catch (_) {}
  }

  generating = false;
  toggleSending(false);
  await loadConversations();
  await refreshQuota();
};

$('btn-stop').onclick = () => {
  if (engine && generating) { try { engine.interruptGenerate(); } catch (_) {} }
};

function toggleSending(sending) {
  $('btn-send').classList.toggle('hidden', sending);
  $('btn-stop').classList.toggle('hidden', !sending);
}

async function refreshQuota() {
  const res = await fetch('/api/me');
  const data = await res.json();
  if (data.quota) renderQuota(data.quota);
}

function showBanner(text) { const b = $('banner'); b.textContent = text; b.classList.remove('hidden'); }

// ── Settings modal ──
$('btn-settings').onclick = () => { $('system-prompt').value = systemPrompt; $('settings-modal').classList.remove('hidden'); };
$('settings-cancel').onclick = () => $('settings-modal').classList.add('hidden');
$('settings-save').onclick = () => {
  systemPrompt = $('system-prompt').value;
  localStorage.setItem('systemPrompt', systemPrompt);
  $('settings-modal').classList.add('hidden');
};

// ── Upgrade modal ──
$('btn-upgrade').onclick = () => $('upgrade-modal').classList.remove('hidden');
$('upgrade-cancel').onclick = () => $('upgrade-modal').classList.add('hidden');
document.querySelectorAll('.plan button[data-tier]').forEach((btn) => {
  btn.onclick = async () => {
    const res = await fetch('/api/billing/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: btn.dataset.tier }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else alert(data.error || 'Could not start checkout.');
  };
});
$('btn-portal').onclick = async () => {
  const res = await fetch('/api/billing/portal', { method: 'POST' });
  const data = await res.json();
  if (data.url) window.location.href = data.url;
  else alert(data.error || 'No subscription to manage.');
};

// ── Mobile sidebar ──
$('btn-menu').onclick = () => $('sidebar').classList.toggle('open');
function closeSidebar() { $('sidebar').classList.remove('open'); }

boot();
