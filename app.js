// ── State ──
let me = null;
let currentConversationId = null;
let currentModel = null;
let systemPrompt = localStorage.getItem('systemPrompt') || '';
let abortController = null;

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
  currentModel = data.defaultModel;
  $('auth-screen').classList.add('hidden');
  $('app').classList.remove('hidden');

  // Model picker
  const sel = $('model-select');
  sel.innerHTML = '';
  (data.models || []).forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    if (m === currentModel) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.onchange = () => { currentModel = sel.value; };

  $('user-name').textContent = me.name + (me.email ? ` · ${me.email}` : '');
  renderQuota(data.quota);
  await loadConversations();
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
  $('empty-state').classList.add('hidden');
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

// Turn qualifying code blocks in a rendered message into artifact cards.
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
    if (!isWeb && !big) return; // keep short snippets inline

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
  if (!text || abortController) return;

  addMessage('user', text);
  input.value = '';
  input.style.height = 'auto';
  $('banner').classList.add('hidden');

  const assistantBody = addMessage('assistant', '');
  assistantBody.classList.add('cursor-blink');
  let full = '';

  toggleSending(true);
  abortController = new AbortController();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: currentConversationId, message: text, model: currentModel, systemPrompt }),
      signal: abortController.signal,
    });

    if (res.status === 429) {
      const err = await res.json();
      assistantBody.closest('.msg').remove();
      showBanner(err.error || 'Limit reached.');
      await refreshQuota();
      return;
    }
    if (!res.ok || !res.body) { assistantBody.textContent = 'Error contacting server.'; return; }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const lines = part.split('\n');
        const event = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim();
        const dataLine = (lines.find((l) => l.startsWith('data:')) || '').slice(5).trim();
        if (!dataLine) continue;
        const payload = JSON.parse(dataLine);
        if (event === 'meta') { currentConversationId = payload.conversationId; }
        else if (event === 'delta') {
          full += payload.text;
          assistantBody.classList.remove('cursor-blink');
          assistantBody.innerHTML = renderMarkdown(full);
          scrollDown();
        } else if (event === 'error') { assistantBody.innerHTML = renderMarkdown('⚠️ ' + payload.error); }
      }
    }
    assistantBody.classList.remove('cursor-blink');
    assistantBody.innerHTML = renderMarkdown(full);
    processArtifacts(assistantBody);
    addCopyButton(assistantBody.closest('.msg'), () => full);
    await loadConversations();
    await refreshQuota();
  } catch (err) {
    if (err.name === 'AbortError') { assistantBody.classList.remove('cursor-blink'); }
    else { assistantBody.textContent = 'Connection error.'; }
  } finally {
    toggleSending(false);
    abortController = null;
  }
};

$('btn-stop').onclick = () => { if (abortController) abortController.abort(); };

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
