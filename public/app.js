/* RishiAI — frontend. Talks to the backend for auth, Claude, and Stripe. */
(function () {
  "use strict";

  var state = {
    me: null,            // publicUser from /api/me
    config: null,
    mode: "chat",
    modelId: "rishi-core",
    effort: "medium",
    turns: [],           // current open chat's messages
    chats: [],           // chat index metadata (newest first)
    chatId: null,        // id of the open chat (null = unsaved new chat)
    coworkDraft: "",
    busy: false
  };

  function genId() { return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
  var chatQuery = "";   // current search filter
  var editingId = null; // chat id being renamed inline

  function $(s, r) { return (r || document).querySelector(s); }
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    opts.credentials = "same-origin";
    return fetch(path, opts);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  function planRank(p) { var r = { free: 0, pro: 1, max: 2 }; return r[p] || 0; }
  function models() { return (state.me && state.me.models) || []; }
  function modelById(id) { var m = models(); for (var i = 0; i < m.length; i++) if (m[i].id === id) return m[i]; return m[1] || m[0]; }
  function planName(k) { return (state.me && state.me.plans && state.me.plans[k]) ? state.me.plans[k].name : k; }
  function planPrice(k) { return (state.me && state.me.plans && state.me.plans[k]) ? state.me.plans[k].price : 0; }
  function displayName() {
    if (!state.me) return "there";
    var n = (state.me.name || "").trim();
    if (n) return n.split(" ")[0];
    return (state.me.email || "there").split("@")[0];
  }
  function trialActive() { return state.me && state.me.trialEnds > Date.now(); }
  function trialDaysLeft() { return Math.max(0, Math.ceil((state.me.trialEnds - Date.now()) / 86400000)); }
  function fmtDate(ms) { try { return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch (e) { return new Date(ms).toDateString(); } }

  var toastTimer;
  function toast(msg) { var t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2400); }

  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  var LOCK_SVG = '<svg class="lock-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

  // Inline formatting on a single run of text (escapes first).
  function inlineMd(s) {
    s = escapeHtml(s);
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return "\x01C" + (codes.length - 1) + "\x01"; });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      var safe = /^(https?:|mailto:)/i.test(u) ? u.replace(/"/g, "%22") : "#";
      return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + t + "</a>";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\x01C(\d+)\x01/g, function (_, i) { return "<code>" + codes[+i] + "</code>"; });
    return s;
  }
  function splitRow(l) {
    return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
  }
  function renderTable(header, rows) {
    var hs = splitRow(header), out = '<div class="table-wrap"><table><thead><tr>';
    hs.forEach(function (c) { out += "<th>" + inlineMd(c) + "</th>"; });
    out += "</tr></thead><tbody>";
    rows.forEach(function (r) {
      var cs = splitRow(r); out += "<tr>";
      for (var k = 0; k < hs.length; k++) out += "<td>" + inlineMd(cs[k] || "") + "</td>";
      out += "</tr>";
    });
    return out + "</tbody></table></div>";
  }
  function renderCodeBlock(b) {
    var lang = (b.lang || "").trim();
    var attr = lang ? ' data-lang="' + escapeHtml(lang) + '"' : "";
    return '<div class="code-block"' + attr + '><div class="code-bar"><span class="code-lang">' +
      escapeHtml(lang || "text") + '</span><span class="code-acts"></span></div><pre><code>' +
      escapeHtml(b.code) + "</code></pre></div>";
  }
  function isTableSep(l) { return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(l); }

  function renderMarkdown(text) {
    text = String(text).replace(/\r\n?/g, "\n");
    var blocks = [];
    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push({ lang: (lang || "").trim(), code: code.replace(/\n$/, "") });
      return "\n\x00CB" + (blocks.length - 1) + "\x00\n";
    });
    var lines = text.split("\n"), html = [], i = 0;
    function special(l) {
      return /^\s*(#{1,6}\s|>|[-*+]\s|\d+\.\s)/.test(l) ||
        /^\x00CB\d+\x00$/.test(l.trim()) ||
        /^\s*([-*_])\s*(\1\s*){2,}$/.test(l);
    }
    while (i < lines.length) {
      var line = lines[i];
      var cb = /^\x00CB(\d+)\x00$/.exec(line.trim());
      if (cb) { html.push(renderCodeBlock(blocks[+cb[1]])); i++; continue; }
      if (!line.trim()) { i++; continue; }
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { html.push("<hr>"); i++; continue; }
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { var lv = h[1].length; html.push("<h" + lv + ">" + inlineMd(h[2].trim()) + "</h" + lv + ">"); i++; continue; }
      if (line.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var header = line; i += 2; var rows = [];
        while (i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim() && !/^\x00CB/.test(lines[i].trim())) { rows.push(lines[i]); i++; }
        html.push(renderTable(header, rows)); continue;
      }
      if (/^\s*>\s?/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        html.push("<blockquote>" + renderMarkdown(q.join("\n")) + "</blockquote>"); continue;
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        var ordered = /^\s*\d+\.\s+/.test(line), items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push("<li>" + inlineMd(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "")) + "</li>"); i++;
        }
        html.push((ordered ? "<ol>" : "<ul>") + items.join("") + (ordered ? "</ol>" : "</ul>")); continue;
      }
      var para = [];
      while (i < lines.length && lines[i].trim() && !special(lines[i]) &&
             !(lines[i].indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        para.push(lines[i]); i++;
      }
      if (para.length) html.push("<p>" + inlineMd(para.join("\n")).replace(/\n/g, "<br>") + "</p>");
    }
    return html.join("");
  }

  /* ---------- code block tools: copy / download / shareable link ---------- */
  var LANG_EXT = {
    html: "html", htm: "html", svg: "svg", xml: "xml", css: "css",
    js: "js", javascript: "js", ts: "ts", typescript: "ts", json: "json",
    py: "py", python: "py", csv: "csv", md: "md", markdown: "md",
    sql: "sql", sh: "sh", bash: "sh", yaml: "yaml", yml: "yaml", txt: "txt", text: "txt",
  };
  function filenameFor(lang) {
    var ext = LANG_EXT[(lang || "").toLowerCase()] || "txt";
    var base = ext === "html" ? "page" : ext === "svg" ? "image" : ext === "csv" ? "data" : "file";
    return base + "." + ext;
  }
  function isPreviewable(lang) { var e = LANG_EXT[(lang || "").toLowerCase()]; return e === "html" || e === "svg"; }
  function downloadText(text, filename) {
    try {
      var blob = new Blob([text], { type: "text/plain" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    } catch (e) { toast("Download failed."); }
  }
  function mkCodeBtn(label) {
    var b = el("button", "code-act-btn", label); b.type = "button"; return b;
  }

  // Per-chat stable artifact links: key (filename) -> artifact id, so a
  // refined version updates the same URL instead of minting a new one.
  function slotsKey() { return "rishiai.artslots." + (state.me ? state.me.email : "anon") + "." + (state.chatId || "none"); }
  function getSlots() {
    try { return JSON.parse(localStorage.getItem(slotsKey()) || "{}"); } catch (e) { return {}; }
  }
  function setSlot(key, id) {
    try { var s = getSlots(); s[key] = id; localStorage.setItem(slotsKey(), JSON.stringify(s)); } catch (e) {}
  }

  // Build a single working HTML page from an HTML block plus any sibling
  // CSS/JS blocks in the same message (multi-file -> one page).
  function mergeDoc(htmlCode, cssList, jsList) {
    var doc = htmlCode;
    var styleTag = cssList.length ? "<style>\n" + cssList.join("\n") + "\n</style>" : "";
    var scriptTag = jsList.length ? "<script>\n" + jsList.join("\n") + "\n<\/script>" : "";
    if (/<\/head>/i.test(doc) && styleTag) doc = doc.replace(/<\/head>/i, styleTag + "\n</head>");
    else if (styleTag && /<html[\s>]/i.test(doc)) doc = doc.replace(/(<html[^>]*>)/i, "$1\n<head>" + styleTag + "</head>");
    else if (styleTag) doc = styleTag + "\n" + doc;
    if (/<\/body>/i.test(doc) && scriptTag) doc = doc.replace(/<\/body>/i, scriptTag + "\n</body>");
    else if (scriptTag) doc = doc + "\n" + scriptTag;
    // If it's a bare fragment, wrap it so it renders predictably.
    if (!/<html[\s>]/i.test(doc)) {
      doc = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body>" + doc + "</body></html>";
    }
    return doc;
  }

  async function shareArtifact(key, filename, content, btn) {
    var slots = getSlots();
    var existing = slots[key];
    var w = window.open("about:blank", "_blank");
    try {
      var resp, created = !existing;
      if (existing) {
        resp = await api("/api/artifacts/" + encodeURIComponent(existing), { method: "PUT", body: JSON.stringify({ filename: filename, content: content }) });
        if (resp.status === 404) { created = true; resp = await api("/api/artifacts", { method: "POST", body: JSON.stringify({ filename: filename, content: content }) }); }
      } else {
        resp = await api("/api/artifacts", { method: "POST", body: JSON.stringify({ filename: filename, content: content }) });
      }
      var d = await resp.json();
      if (d.url) {
        setSlot(key, d.id);
        if (w) w.location = d.url; else window.location = d.url;
        toast(created ? "Shareable link created." : "Updated the existing link.");
      } else { if (w) w.close(); toast(d.error === "too_large" ? "File too large to link." : "Couldn't create link."); }
    } catch (e) { if (w) w.close(); toast("Couldn't create link."); }
  }

  function enhanceCodeBlocks(container) {
    if (!container) return;
    // Gather all blocks in this message for CSS/JS merging.
    var allBlocks = Array.prototype.map.call(container.querySelectorAll(".code-block"), function (cb) {
      return { lang: (cb.getAttribute("data-lang") || "").toLowerCase(), code: cb.querySelector("code").textContent };
    });
    var cssList = allBlocks.filter(function (b) { return LANG_EXT[b.lang] === "css"; }).map(function (b) { return b.code; });
    var jsList = allBlocks.filter(function (b) { return LANG_EXT[b.lang] === "js"; }).map(function (b) { return b.code; });

    container.querySelectorAll(".code-block").forEach(function (cb) {
      var acts = cb.querySelector(".code-acts");
      if (!acts || acts.getAttribute("data-done")) return;
      acts.setAttribute("data-done", "1");
      var code = cb.querySelector("code").textContent;
      var lang = (cb.getAttribute("data-lang") || "").toLowerCase();
      var ext = LANG_EXT[lang] || "txt";
      var previewable = ext === "html" || ext === "svg";

      // The content used for preview AND for the shareable link.
      var docContent = ext === "html" ? mergeDoc(code, cssList, jsList) : code;

      // Copy / Download (always).
      var copy = mkCodeBtn("Copy");
      copy.addEventListener("click", function () {
        if (navigator.clipboard && navigator.clipboard.writeText)
          navigator.clipboard.writeText(code).then(function () { toast("Copied."); }).catch(function () { toast("Copy failed."); });
      });
      acts.appendChild(copy);
      var dl = mkCodeBtn("Download");
      dl.addEventListener("click", function () { downloadText(code, filenameFor(lang)); });
      acts.appendChild(dl);

      if (!previewable) return;

      // Preview / Code toggle + inline sandboxed iframe (like Claude's artifact view).
      var op = mkCodeBtn("Open link");
      op.addEventListener("click", function () { shareArtifact(filenameFor(lang), filenameFor(lang), docContent, op); });
      acts.appendChild(op);

      var pre = cb.querySelector("pre");
      var bar = cb.querySelector(".code-bar");
      var tabs = el("div", "code-tabs");
      var tPrev = el("button", "code-tab active", "Preview"); tPrev.type = "button";
      var tCode = el("button", "code-tab", "Code"); tCode.type = "button";
      tabs.appendChild(tPrev); tabs.appendChild(tCode);
      bar.insertBefore(tabs, bar.firstChild.nextSibling); // after the language label

      var frame = document.createElement("iframe");
      frame.className = "code-preview";
      frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals");
      frame.setAttribute("title", "Preview");
      frame.srcdoc = docContent;
      cb.insertBefore(frame, pre);
      pre.hidden = true; // default to preview

      tPrev.addEventListener("click", function () { pre.hidden = true; frame.hidden = false; tPrev.classList.add("active"); tCode.classList.remove("active"); });
      tCode.addEventListener("click", function () { pre.hidden = false; frame.hidden = true; tCode.classList.add("active"); tPrev.classList.remove("active"); });
    });
  }

  /* ---------- local per-browser prefs (model/effort/mode/draft) ---------- */
  function prefsKey() { return "rishiai.prefs." + (state.me ? state.me.email : "anon"); }
  function loadPrefs() {
    try {
      var s = JSON.parse(localStorage.getItem(prefsKey()) || "{}");
      if (s.modelId) state.modelId = s.modelId;
      if (s.effort) state.effort = s.effort;
      if (s.mode) state.mode = s.mode;
      if (typeof s.coworkDraft === "string") state.coworkDraft = s.coworkDraft;
    } catch (e) {}
    // clamp model to one that's allowed
    var m = modelById(state.modelId);
    if (!m || !m.allowed) {
      var all = models();
      for (var i = all.length - 1; i >= 0; i--) if (all[i].allowed) { state.modelId = all[i].id; break; }
    }
  }
  function savePrefs() {
    try { localStorage.setItem(prefsKey(), JSON.stringify({ modelId: state.modelId, effort: state.effort, mode: state.mode, coworkDraft: state.coworkDraft })); } catch (e) {}
  }

  /* ---------- rendering ---------- */
  function renderModels() {
    var list = $("#model-list"); list.innerHTML = "";
    models().forEach(function (m) {
      var row = el("button", "model-row" + (m.id === state.modelId ? " active" : "") + (m.allowed ? "" : " locked"));
      row.innerHTML = '<span class="model-dot"></span><span class="model-meta">' +
        '<span class="model-name">' + escapeHtml(m.name) + '<span class="tier-chip">' + escapeHtml(m.chip) + '</span>' + (m.allowed ? "" : LOCK_SVG) + '</span>' +
        '<span class="model-desc">' + escapeHtml(m.desc) + '</span></span>';
      row.addEventListener("click", function () {
        if (!m.allowed) { openPlans("Unlock " + m.name + " with " + planName(m.minPlan) + "."); return; }
        state.modelId = m.id; savePrefs(); renderModels(); renderTopbar(); updateMeta();
      });
      list.appendChild(row);
    });
  }
  function renderTopbar() {
    $("#mode-title").textContent = state.mode === "chat" ? "Chat" : "Co-work";
    $("#active-model-label").textContent = " · " + modelById(state.modelId).name;
    $("#current-plan-name").textContent = planName(state.me.plan);
    document.querySelectorAll("#effort button").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-effort") === state.effort); });
    document.querySelectorAll(".mode-btn").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-mode") === state.mode); });
    $("#open-plans").textContent = state.me.plan === "max" ? "Manage plan" : "Upgrade plan";
  }
  function renderAccount() {
    var ava = $("#account-ava");
    if (state.me.picture) ava.innerHTML = '<img src="' + escapeHtml(state.me.picture) + '" alt="">';
    else ava.textContent = (displayName().charAt(0) || "?").toUpperCase();
    $("#account-name").textContent = displayName();
    var label = planName(state.me.plan) + " plan";
    if (state.me.comp) label = planName(state.me.plan) + " · complimentary";
    else if (trialActive()) label = planName(state.me.plan) + " trial · " + trialDaysLeft() + "d left";
    $("#account-plan").textContent = label;
  }
  function updateMeta() {
    var m = modelById(state.modelId);
    var base = "<b>" + escapeHtml(m.name) + "</b> · " + state.effort.charAt(0).toUpperCase() + state.effort.slice(1) + " effort";
    $("#composer-meta").innerHTML = base + usageMetaSuffix();
    enforceUsage();
  }
  function usageMetaSuffix() {
    var u = state.usage; if (!u || u.unlimited) return "";
    if (u.plan === "free") {
      if (u.blocked) return ' · <span class="usage-warn">Hourly limit reached · resets ' + fmtUntil(u.resetAt) + "</span>";
      return ' · <span class="usage-dim">' + u.remaining + " of " + u.limit + " left this hour</span>";
    }
    if (u.plan === "pro") {
      if (u.open) return ' · <span class="usage-dim">Pro open · closes ' + fmtUntil(u.resetAt) + "</span>";
      return ' · <span class="usage-warn">Pro opens ' + fmtUntil(u.resetAt) + "</span>";
    }
    return "";
  }
  function enforceUsage() {
    var u = state.usage;
    var blocked = !!(u && !u.unlimited && u.blocked);
    var input = $("#input"), send = $("#send");
    if (!input) return;
    if (blocked && !state.busy) {
      input.disabled = true;
      input.placeholder = u.plan === "pro"
        ? "Pro is open 12am–6pm (Singapore) · reopens " + fmtUntil(u.resetAt)
        : "Free limit reached (" + (u.limit || 10) + "/hour) · resets " + fmtUntil(u.resetAt);
      if (send) send.disabled = true;
    } else {
      input.disabled = false;
      input.placeholder = "Message RishiAI…";
      updateSendEnabled();
    }
  }
  function fmtUntil(ms) {
    if (!ms) return "soon";
    var d = ms - Date.now(); if (d <= 0) return "now";
    var mins = Math.round(d / 60000);
    if (mins < 60) return "in " + mins + "m";
    var h = Math.floor(mins / 60), m = mins % 60;
    return "in " + h + "h" + (m ? " " + m + "m" : "");
  }
  var usageTimer = null;
  async function loadUsage() {
    try { var r = await api("/api/usage"); if (r.ok) state.usage = await r.json(); } catch (e) {}
    updateMeta();
    scheduleUsageRecheck(state.usage && state.usage.resetAt);
  }
  function scheduleUsageRecheck(resetAt) {
    if (usageTimer) { clearTimeout(usageTimer); usageTimer = null; }
    if (!resetAt) return;
    var d = resetAt - Date.now();
    if (d <= 0) { loadUsage(); return; }
    usageTimer = setTimeout(loadUsage, Math.min(d + 1500, 15 * 60000)); // cap re-check at 15 min
  }
  function handleUsageError(e) {
    state.usage = { plan: e.plan || "free", unlimited: false, blocked: true, reason: e.reason, resetAt: e.resetAt,
                    limit: 10, remaining: 0, open: false };
    updateMeta();
    scheduleUsageRecheck(e.resetAt);
  }

  function renderThread() {
    var thread = $("#thread");
    if (state.turns.length === 0) {
      thread.innerHTML = "";
      var w = el("div", "welcome");
      w.innerHTML = '<div class="mark">R</div><h2>How can I help, ' + escapeHtml(displayName()) + '?</h2>' +
        '<p>Start typing below to begin a conversation.</p><div class="suggestions">' +
        '<button class="sugg" data-q="Explain the difference between supervised and unsupervised learning, with one example each."><b>Explain a concept</b><span>Supervised vs unsupervised learning</span></button>' +
        '<button class="sugg" data-q="Draft a polite email declining a meeting invite because of a scheduling conflict."><b>Draft an email</b><span>Decline a meeting, politely</span></button>' +
        '<button class="sugg" data-q="Write a Python function that checks whether a string is a palindrome, ignoring punctuation and case."><b>Write some code</b><span>Palindrome checker in Python</span></button>' +
        '<button class="sugg" data-q="Give me 5 creative, catchy names for a sustainable coffee brand, with a one-line rationale each."><b>Brainstorm</b><span>Names for a coffee brand</span></button></div>';
      thread.appendChild(w);
      w.querySelectorAll(".sugg").forEach(function (b) { b.addEventListener("click", function () { $("#input").value = b.getAttribute("data-q"); autosize(); send(); }); });
      return;
    }
    thread.innerHTML = "";
    var inner = el("div", "thread-inner");
    state.turns.forEach(function (t) { inner.appendChild(bubble(t.role, t.content)); });
    thread.appendChild(inner);
    enhanceCodeBlocks(inner);
    thread.scrollTop = thread.scrollHeight;
  }
  function bubble(role, content) {
    var wrap = el("div", "msg " + (role === "user" ? "user" : "ai"));
    var av = el("div", "avatar", role === "user" ? "Y" : "R");
    var body = el("div", "body");
    body.appendChild(el("div", "who", role === "user" ? "You" : "RishiAI"));
    var ct = el("div", "content");
    if (role === "user") ct.textContent = content; else ct.innerHTML = content ? renderMarkdown(content) : "";
    body.appendChild(ct); wrap.appendChild(av); wrap.appendChild(body);
    return wrap;
  }

  /* ---------- streaming chat via SSE over fetch ---------- */
  var currentCtl = null;
  function buildMessages() {
    return state.turns.slice(-16).map(function (t) { return { role: t.role, content: t.content }; });
  }

  async function streamChat(messages, systemPrompt, onDelta) {
    var m = modelById(state.modelId);
    currentCtl = new AbortController();
    var resp = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: messages, modelId: state.modelId, effort: state.effort, system: systemPrompt }),
      signal: currentCtl.signal
    });
    if (!resp.ok) {
      var err = {}; try { err = await resp.json(); } catch (e) {}
      throw { code: err.error || ("http_" + resp.status), minPlan: err.minPlan, reason: err.reason, resetAt: err.resetAt, plan: err.plan };
    }
    var reader = resp.body.getReader();
    var dec = new TextDecoder();
    var buf = "", full = "", result = { truncated: false };
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var lines = buf.split("\n");
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.slice(0, 5) !== "data:") continue;
        var payload = line.slice(5).trim();
        if (!payload) continue;
        var evt; try { evt = JSON.parse(payload); } catch (e) { continue; }
        if (evt.delta) { full += evt.delta; onDelta(full); }
        else if (evt.error) { throw { code: evt.error, partial: full }; }
        else if (evt.done) { result.truncated = !!evt.truncated; }
      }
    }
    result.text = full;
    return result;
  }

  function send() {
    if (state.busy) return;
    var input = $("#input"); var text = input.value.trim(); if (!text) return;
    if (!state.chatId) state.chatId = genId();
    state.turns.push({ role: "user", content: text });
    input.value = ""; autosize(); renderThread();
    var thread = $("#thread"), inner = $(".thread-inner", thread);
    var aiWrap = bubble("assistant", ""); var ct = $(".content", aiWrap);
    ct.innerHTML = '<span class="cursor"></span>';
    inner.appendChild(aiWrap); thread.scrollTop = thread.scrollHeight;
    runChat(ct, thread);
  }

  async function runChat(ct, thread) {
    state.busy = true; setBusy(true);
    try {
      var res = await streamChat(buildMessages(),
        "You are RishiAI, a helpful, warm and precise AI assistant. Answer clearly and concisely with short paragraphs and **bold** for key terms. Use Markdown tables (| col | col |) for any tabular or comparative data. When you write code or create a file (a web page, script, data file, SVG, etc.), put it in a fenced code block tagged with its language or extension (```html, ```python, ```csv, ```svg …) — the app turns these into Copy / Download / shareable-link buttons. You are RishiAI; if asked, say so.",
        function (full) { ct.innerHTML = renderMarkdown(full); thread.scrollTop = thread.scrollHeight; });
      ct.innerHTML = renderMarkdown(res.text + (res.truncated ? "\n\n_(response cut short — raise effort or ask for less.)_" : ""));
      enhanceCodeBlocks(ct);
      state.turns.push({ role: "assistant", content: res.text }); saveCurrentChat();
      loadUsage();
    } catch (e) {
      if (e && e.code === "usage_limited") { handleUsageError(e); ct.innerHTML = renderMarkdown(errorText(e)); }
      else { ct.innerHTML = renderMarkdown(errorText(e)); enhanceCodeBlocks(ct); if (e && e.partial) { state.turns.push({ role: "assistant", content: e.partial }); saveCurrentChat(); } }
    } finally { state.busy = false; setBusy(false); currentCtl = null; }
  }

  function errorText(e) {
    var c = e && e.code;
    if (c === "cancelled" || (e && e.name === "AbortError")) return "_Stopped._";
    if (c === "usage_limited") {
      if (e.reason === "pro_window") return "**Pro hours are 12:00am–6:00pm (Singapore time).** It reopens " + fmtUntil(e.resetAt) + ". Upgrade to MAX for unlimited, any time.";
      return "**You've used all 10 messages this hour on Free.** Resets " + fmtUntil(e.resetAt) + ". Upgrade to Pro or MAX for more.";
    }
    if (c === "model_locked" || c === "http_403") return "_That model needs a higher plan._ Upgrade to use it.";
    if (c === "not_authenticated" || c === "http_401") { setTimeout(gateAuth, 600); return "_Your session expired — please sign in again._"; }
    if (c === "rate_limited") return "_Usage limit reached for now. Try again shortly._";
    if (c === "claude_not_configured" || c === "auth_error") return "_Claude isn't configured on the server yet._ Add your ANTHROPIC_API_KEY in Replit Secrets.";
    if (c === "bad_model") return "_That model id isn't available._ Update the model's API id in server.js.";
    return (e && e.partial ? e.partial + "\n\n" : "") + "_Something interrupted that response._ Please try again.";
  }

  function setBusy(busy) {
    var s = $("#send");
    if (busy) { s.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'; s.setAttribute("aria-label", "Stop"); s.disabled = false; }
    else { s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>'; s.setAttribute("aria-label", "Send"); updateSendEnabled(); }
  }
  function updateSendEnabled() { if (!state.busy) $("#send").disabled = $("#input").value.trim().length === 0; }

  /* ---------- co-work ---------- */
  async function coworkRun() {
    if (state.busy) return;
    var instr = $("#cowork-input").value.trim();
    if (!instr) { toast("Describe what to create first."); return; }
    var canvas = $("#cowork-canvas"); canvas.classList.remove("empty"); canvas.textContent = "Thinking…";
    var runBtn = $("#cowork-run"); runBtn.disabled = true; runBtn.innerHTML = "Working…";
    state.busy = true;
    var prompt = state.coworkDraft
      ? "CURRENT DRAFT:\n" + state.coworkDraft.slice(0, 12000) + "\n\nREVISION INSTRUCTION:\n" + instr + "\n\nReturn the full revised draft."
      : "TASK:\n" + instr + "\n\nReturn the complete draft.";
    try {
      var res = await streamChat([{ role: "user", content: prompt }],
        "You are RishiAI in Co-work mode: a collaborative writing and building assistant. Produce a clean, well-structured draft the user can use directly. Output only the deliverable (no preamble). Use clear headings and lists where helpful.",
        function (full) { canvas.textContent = full; canvas.scrollTop = canvas.scrollHeight; });
      state.coworkDraft = res.text; canvas.textContent = res.text;
      $("#cowork-copy").hidden = false; $("#cowork-input").value = "";
      $("#cowork-input").placeholder = "Refine the draft… e.g. 'Make it shorter and add a timeline.'";
      savePrefs();
    } catch (e) { canvas.textContent = errorText(e).replace(/[_*`]/g, ""); }
    finally { state.busy = false; runBtn.disabled = false; runBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z"/></svg> Generate draft'; }
  }
  function restoreCowork() {
    if (state.coworkDraft) { var c = $("#cowork-canvas"); c.classList.remove("empty"); c.textContent = state.coworkDraft; $("#cowork-copy").hidden = false; $("#cowork-input").placeholder = "Refine the draft… e.g. 'Make it shorter and add a timeline.'"; }
  }

  /* ---------- mode ---------- */
  function setMode(mode) {
    state.mode = mode; savePrefs();
    $("#chat-view").style.display = mode === "chat" ? "flex" : "none";
    $("#cowork-view").style.display = mode === "cowork" ? "flex" : "none";
    renderTopbar(); closeSidebar();
  }

  /* ---------- plans & checkout (real Stripe) ---------- */
  var PLAN_FEATURES = {
    free: ["Rishi Flash & Rishi Core models", "Chat and Co-work modes", "Low / Medium / High effort", "Standard response speed"],
    pro: ["Everything in Free", "Unlocks Rishi Pro model", "Priority response speed", "Longer Co-work drafts"],
    max: ["Everything in Pro", "Unlocks Rishi Max (Opus-class)", "Highest reasoning effort", "Fastest priority access"]
  };
  function openPlans(reason) {
    var sheet = $("#sheet");
    sheet.innerHTML = '<div class="sheet-head"><div><h2>Choose your plan</h2><p>' + (reason ? escapeHtml(reason) + " " : "") + 'Unlock more capable models and higher effort.</p></div><button class="close-x" id="close-sheet" aria-label="Close">×</button></div><div class="plans" id="plans-grid"></div>';
    var grid = $("#plans-grid", sheet);
    ["free", "pro", "max"].forEach(function (key) {
      var card = el("div", "plan" + (key === "pro" ? " featured" : ""));
      var feats = PLAN_FEATURES[key].map(function (f) { return '<li>' + CHECK_SVG + '<span>' + f + '</span></li>'; }).join("");
      var isCurrent = state.me.plan === key;
      var action;
      if (isCurrent) action = '<div class="current-tag">✓ Your current plan</div>';
      else if (planRank(key) < planRank(state.me.plan)) action = (state.me.comp ? '' : '<button class="btn ghost" data-manage="1">Manage plan</button>');
      else action = '<button class="btn" data-select="' + key + '">' + (key === "free" ? "Downgrade" : "Start free trial") + '</button>';
      if (key === "free" && !isCurrent && !state.me.comp) action = '<button class="btn ghost" data-manage="1">Manage plan</button>';
      var trialLine = key !== "free" ? '<div class="trial-line">✓ 1-month free trial</div>' : '<div class="free-line">Free forever</div>';
      card.innerHTML = (key === "pro" ? '<span class="ribbon">Most popular</span>' : "") +
        '<div class="pname">' + planName(key) + '</div>' +
        '<div class="price">$' + planPrice(key) + '<small>/month</small></div>' + trialLine +
        '<ul>' + feats + '</ul>' + action;
      grid.appendChild(card);
    });
    grid.querySelectorAll("[data-select]").forEach(function (b) { b.addEventListener("click", function () { startCheckout(b.getAttribute("data-select")); }); });
    grid.querySelectorAll("[data-manage]").forEach(function (b) { b.addEventListener("click", openPortal); });
    $("#close-sheet", sheet).addEventListener("click", function () { showOverlay(false); });
    showOverlay(true);
  }

  async function startCheckout(plan) {
    if (state.me.comp) { toast("You already have complimentary MAX access."); return; }
    toast("Opening secure checkout…");
    try {
      var resp = await api("/api/checkout", { method: "POST", body: JSON.stringify({ plan: plan, trial: true }) });
      var data = await resp.json();
      if (data.url) { window.location.href = data.url; }
      else if (data.error === "stripe_not_configured") toast("Stripe isn't configured on the server yet.");
      else toast("Could not start checkout.");
    } catch (e) { toast("Could not start checkout."); }
  }
  async function openPortal() {
    try {
      var resp = await api("/api/portal", { method: "POST" });
      var data = await resp.json();
      if (data.url) window.location.href = data.url;
      else toast(data.error === "no_customer" ? "No billing account yet." : "Billing portal unavailable.");
    } catch (e) { toast("Billing portal unavailable."); }
  }
  function showOverlay(show) { $("#overlay").classList.toggle("show", show); }

  /* ---------- auth ---------- */
  function gateAuth() { $("#app").hidden = true; $("#login").classList.add("show"); initGoogle(); }

  async function onGoogleCredential(response) {
    try {
      var resp = await api("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: response.credential }) });
      var data = await resp.json();
      if (data.user) { state.me = data.user; afterLogin(); }
      else toast("Sign-in failed. Please try again.");
    } catch (e) { toast("Sign-in failed. Please try again."); }
  }

  var googleTries = 0;
  function initGoogle() {
    if (!state.config || !state.config.googleClientId) {
      var fb = $("#login-fallback"); fb.hidden = false;
      fb.textContent = "Google sign-in isn't configured yet. Add GOOGLE_CLIENT_ID in Replit Secrets, then reload.";
      return;
    }
    if (!(window.google && google.accounts && google.accounts.id)) {
      if (googleTries++ < 40) return void setTimeout(initGoogle, 150);
      $("#login-fallback").hidden = false;
      $("#login-fallback").textContent = "Couldn't load Google sign-in. Check your connection and reload.";
      return;
    }
    google.accounts.id.initialize({ client_id: state.config.googleClientId, callback: onGoogleCredential });
    google.accounts.id.renderButton($("#g-button"), { theme: "outline", size: "large", shape: "pill", text: "continue_with", width: 300 });
    google.accounts.id.prompt();
  }

  function afterLogin() {
    $("#login").classList.remove("show");
    $("#app").hidden = false;
    loadPrefs();
    state.chatId = null; state.turns = [];
    renderModels(); renderThread(); renderChatList(); restoreCowork();
    renderTopbar(); renderAccount(); updateMeta(); setMode(state.mode);
    updateSendEnabled();
    loadChats();
    loadUsage();
    $("#input").focus();
  }

  async function logout() {
    if (state.busy && currentCtl) currentCtl.abort();
    await api("/api/auth/logout", { method: "POST" }).catch(function () {});
    state.me = null; state.turns = []; state.chats = []; state.chatId = null; state.coworkDraft = "";
    showOverlay(false); closeSidebar();
    gateAuth();
  }

  /* ---------- composer / theme / sidebar ---------- */
  function autosize() { var t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; updateSendEnabled(); }
  function initTheme() { var s; try { s = localStorage.getItem("rishiai.theme"); } catch (e) {} if (s === "dark" || s === "light") document.documentElement.setAttribute("data-theme", s); updateThemeIcon(); }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme");
    var isDark = cur ? cur === "dark" : (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
    var next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("rishiai.theme", next); } catch (e) {}
    updateThemeIcon();
  }
  function updateThemeIcon() {
    var cur = document.documentElement.getAttribute("data-theme");
    var isDark = cur ? cur === "dark" : (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
    var icon = $("#theme-icon");
    if (icon) icon.innerHTML = isDark ? '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>' : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  }
  function openSidebar() { $("#sidebar").classList.add("open"); $("#scrim").classList.add("show"); }
  function closeSidebar() { $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); }
  function newChat() {
    if (state.busy && currentCtl) currentCtl.abort();
    state.chatId = null; state.turns = []; editingId = null;
    setMode("chat"); renderThread(); renderChatList();
    $("#input").focus();
  }

  /* ---------- chat history (server-side, unlimited) ---------- */
  function relTime(ms) {
    var d = Date.now() - ms;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    if (d < 604800000) return Math.floor(d / 86400000) + "d ago";
    return fmtDate(ms);
  }
  async function loadChats() {
    try {
      var resp = await api("/api/chats");
      if (resp.ok) { var d = await resp.json(); state.chats = (d.chats || []); }
    } catch (e) { state.chats = []; }
    renderChatList();
  }
  function renderChatList() {
    var box = $("#chat-list"); if (!box) return;
    box.innerHTML = "";
    $("#chat-count").textContent = state.chats.length ? String(state.chats.length) : "";
    // Show the search box once there are a few chats to sift through.
    var searchWrap = $("#chat-search-wrap");
    if (searchWrap) searchWrap.hidden = state.chats.length < 3;

    if (!state.chats.length) { box.appendChild(el("div", "chat-empty", "No chats yet")); return; }

    var q = chatQuery.trim().toLowerCase();
    var list = q
      ? state.chats.filter(function (c) { return (c.title || "").toLowerCase().indexOf(q) >= 0; })
      : state.chats;
    if (!list.length) { box.appendChild(el("div", "chat-empty", "No chats match “" + chatQuery + "”")); return; }

    list.forEach(function (c) {
      var row = el("div", "chat-item" + (c.id === state.chatId ? " active" : ""));

      if (editingId === c.id) {
        var inp = el("input", "chat-rename-input");
        inp.type = "text"; inp.value = c.title || "";
        inp.setAttribute("aria-label", "Rename chat");
        var commit = function (save) {
          if (editingId !== c.id) return;
          editingId = null;
          if (save) { var nt = inp.value.trim(); if (nt && nt !== c.title) return void renameChat(c.id, nt); }
          renderChatList();
        };
        inp.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); commit(true); }
          else if (e.key === "Escape") { e.preventDefault(); commit(false); }
        });
        inp.addEventListener("blur", function () { commit(true); });
        row.appendChild(inp);
        box.appendChild(row);
        setTimeout(function () { inp.focus(); inp.select(); }, 0);
        return;
      }

      var main = el("button", "chat-item-main");
      main.innerHTML = '<span class="chat-item-title"></span><span class="chat-item-time"></span>';
      $(".chat-item-title", main).textContent = c.title || "New chat";
      $(".chat-item-time", main).textContent = relTime(c.updatedAt || c.createdAt);
      main.title = c.title || "";
      main.addEventListener("click", function () { openChat(c.id); });

      var actions = el("div", "chat-actions");
      var ren = el("button", "chat-act rename");
      ren.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
      ren.setAttribute("aria-label", "Rename chat"); ren.title = "Rename";
      ren.addEventListener("click", function (e) { e.stopPropagation(); editingId = c.id; deleteChat._armed = null; renderChatList(); });

      var del = el("button", "chat-act del");
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
      del.setAttribute("aria-label", "Delete chat"); del.title = "Delete";
      if (deleteChat._armed === c.id) { del.style.color = "#dc2626"; del.style.opacity = "1"; del.title = "Tap again to confirm"; }
      del.addEventListener("click", function (e) { e.stopPropagation(); deleteChat(c); });

      actions.appendChild(ren); actions.appendChild(del);
      row.appendChild(main); row.appendChild(actions);
      box.appendChild(row);
    });
  }
  async function renameChat(id, title) {
    // Optimistic: update local meta immediately, then persist.
    state.chats = state.chats.map(function (c) { return c.id === id ? Object.assign({}, c, { title: title }) : c; });
    renderChatList();
    try {
      var resp = await api("/api/chats/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify({ title: title }) });
      if (resp.ok) {
        var d = await resp.json();
        if (d.chat) {
          // Update the meta in place (don't bump to top on a rename).
          state.chats = state.chats.map(function (c) { return c.id === id ? Object.assign({}, c, d.chat) : c; });
          renderChatList();
        }
      }
    } catch (e) { toast("Couldn't rename the chat."); }
  }
  async function openChat(id) {
    if (id === state.chatId) { closeSidebar(); return; }
    if (state.busy && currentCtl) currentCtl.abort();
    try {
      var resp = await api("/api/chats/" + encodeURIComponent(id));
      if (!resp.ok) { toast("Couldn't open that chat."); return; }
      var d = await resp.json();
      state.chatId = id; editingId = null;
      state.turns = (d.chat && d.chat.turns) || [];
      setMode("chat"); renderThread(); renderChatList(); closeSidebar();
    } catch (e) { toast("Couldn't open that chat."); }
  }
  function deleteChat(c) {
    // Two-step delete: first click arms, second confirms (no blocking dialog).
    if (deleteChat._armed === c.id) {
      deleteChat._armed = null;
      api("/api/chats/" + encodeURIComponent(c.id), { method: "DELETE" }).catch(function () {});
      state.chats = state.chats.filter(function (x) { return x.id !== c.id; });
      if (state.chatId === c.id) { state.chatId = null; state.turns = []; renderThread(); }
      renderChatList(); toast("Chat deleted.");
    } else {
      deleteChat._armed = c.id;
      toast("Tap delete again to confirm.");
      renderChatList();
      setTimeout(function () { if (deleteChat._armed === c.id) { deleteChat._armed = null; renderChatList(); } }, 3000);
    }
  }
  function upsertChatMeta(meta) {
    state.chats = state.chats.filter(function (c) { return c.id !== meta.id; });
    state.chats.unshift(meta);
  }
  async function saveCurrentChat() {
    if (!state.chatId || state.turns.length === 0) return;
    try {
      var resp = await api("/api/chats/" + encodeURIComponent(state.chatId), {
        method: "PUT",
        body: JSON.stringify({ turns: state.turns })
      });
      if (resp.ok) { var d = await resp.json(); if (d.chat) { upsertChatMeta(d.chat); renderChatList(); } }
    } catch (e) { /* best-effort; chat stays in memory for this view */ }
  }

  /* ---------- checkout return handling ---------- */
  async function handleCheckoutReturn() {
    var q = new URLSearchParams(location.search);
    var co = q.get("checkout");
    if (!co) return;
    if (co === "success") {
      var sid = q.get("session_id");
      if (sid) {
        try {
          var resp = await api("/api/checkout/confirm", { method: "POST", body: JSON.stringify({ sessionId: sid }) });
          var data = await resp.json();
          if (data.user) state.me = data.user;
        } catch (e) {}
      }
      toast("You're subscribed — enjoy your trial!");
    } else if (co === "cancel") {
      toast("Checkout canceled.");
    }
    history.replaceState({}, "", location.pathname);
  }

  /* ---------- boot ---------- */
  function wire() {
    document.querySelectorAll(".mode-btn").forEach(function (b) { b.addEventListener("click", function () { setMode(b.getAttribute("data-mode")); }); });
    document.querySelectorAll("#effort button").forEach(function (b) { b.addEventListener("click", function () { state.effort = b.getAttribute("data-effort"); savePrefs(); renderTopbar(); updateMeta(); }); });
    var input = $("#input");
    input.addEventListener("input", autosize);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!state.busy) send(); } });
    $("#send").addEventListener("click", function () { if (state.busy) { if (currentCtl) currentCtl.abort(); } else send(); });
    $("#cowork-run").addEventListener("click", coworkRun);
    document.querySelectorAll(".cowork-chip").forEach(function (c) { c.addEventListener("click", function () { var ci = $("#cowork-input"); ci.value = c.getAttribute("data-brief") + ci.value; ci.focus(); }); });
    $("#cowork-copy").addEventListener("click", function () {
      var txt = state.coworkDraft || "";
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { toast("Copied."); }).catch(selectCanvas);
      else selectCanvas();
    });
    function selectCanvas() { var r = document.createRange(); r.selectNodeContents($("#cowork-canvas")); var s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("Draft selected — press Ctrl/Cmd+C."); }
    $("#open-plans").addEventListener("click", function () { openPlans(); });
    $("#overlay").addEventListener("click", function (e) { if (e.target === $("#overlay")) showOverlay(false); });
    $("#theme-btn").addEventListener("click", toggleTheme);
    $("#new-chat").addEventListener("click", newChat);
    var ncs = $("#new-chat-side"); if (ncs) ncs.addEventListener("click", newChat);
    var cs = $("#chat-search"), csc = $("#chat-search-clear");
    if (cs) cs.addEventListener("input", function () {
      chatQuery = cs.value;
      if (csc) csc.hidden = !cs.value;
      renderChatList();
    });
    if (csc) csc.addEventListener("click", function () {
      chatQuery = ""; cs.value = ""; csc.hidden = true; renderChatList(); cs.focus();
    });
    $("#hamburger").addEventListener("click", openSidebar);
    $("#scrim").addEventListener("click", closeSidebar);
    $("#logout-btn").addEventListener("click", logout);
  }

  async function boot() {
    initTheme(); wire();
    try { state.config = await (await api("/api/config")).json(); } catch (e) { state.config = { googleClientId: "" }; }
    var me = null;
    try { me = (await (await api("/api/me")).json()).user; } catch (e) {}
    $("#boot").hidden = true;
    if (me) { state.me = me; await handleCheckoutReturn(); afterLogin(); if (state.me) renderAccount(); }
    else { gateAuth(); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
