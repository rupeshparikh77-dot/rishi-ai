/* RishiAI — frontend. Talks to the backend for auth, Claude, and Stripe. */
(function () {
  "use strict";

  var state = {
    me: null,            // publicUser from /api/me
    config: null,
    mode: "chat",
    modelId: "rishi-core",
    effort: "medium",
    turns: [],
    coworkDraft: "",
    busy: false
  };

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

  function renderMarkdown(text) {
    var out = [], parts = String(text).split(/```/), i;
    for (i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        out.push("<pre><code>" + escapeHtml(parts[i].replace(/^[a-zA-Z0-9]*\n/, "")) + "</code></pre>");
      } else {
        var paras = parts[i].split(/\n{2,}/);
        for (var j = 0; j < paras.length; j++) {
          var p = paras[j].trim(); if (!p) continue;
          p = escapeHtml(p).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\n/g, "<br>");
          out.push("<p>" + p + "</p>");
        }
      }
    }
    return out.join("");
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
      if (Array.isArray(s.turns)) state.turns = s.turns.slice(-40);
    } catch (e) {}
    // clamp model to one that's allowed
    var m = modelById(state.modelId);
    if (!m || !m.allowed) {
      var all = models();
      for (var i = all.length - 1; i >= 0; i--) if (all[i].allowed) { state.modelId = all[i].id; break; }
    }
  }
  function savePrefs() {
    try { localStorage.setItem(prefsKey(), JSON.stringify({ modelId: state.modelId, effort: state.effort, mode: state.mode, coworkDraft: state.coworkDraft, turns: state.turns.slice(-40) })); } catch (e) {}
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
    $("#composer-meta").innerHTML = "<b>" + escapeHtml(m.name) + "</b> · " + state.effort.charAt(0).toUpperCase() + state.effort.slice(1) + " effort";
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
      throw { code: err.error || ("http_" + resp.status), minPlan: err.minPlan };
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
    state.turns.push({ role: "user", content: text });
    input.value = ""; autosize(); savePrefs(); renderThread();
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
        "You are RishiAI, a helpful, warm and precise AI assistant. Answer clearly and concisely. Use short paragraphs, **bold** for key terms and ```code fences``` for code. You are RishiAI; if asked, say so.",
        function (full) { ct.innerHTML = renderMarkdown(full); thread.scrollTop = thread.scrollHeight; });
      ct.innerHTML = renderMarkdown(res.text + (res.truncated ? "\n\n_(response cut short — raise effort or ask for less.)_" : ""));
      state.turns.push({ role: "assistant", content: res.text }); savePrefs();
    } catch (e) {
      ct.innerHTML = renderMarkdown(errorText(e));
      if (e && e.partial) state.turns.push({ role: "assistant", content: e.partial });
      savePrefs();
    } finally { state.busy = false; setBusy(false); currentCtl = null; }
  }

  function errorText(e) {
    var c = e && e.code;
    if (c === "cancelled" || (e && e.name === "AbortError")) return "_Stopped._";
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
    renderModels(); renderThread(); restoreCowork(); renderTopbar(); renderAccount(); updateMeta(); setMode(state.mode);
    updateSendEnabled();
    $("#input").focus();
  }

  async function logout() {
    if (state.busy && currentCtl) currentCtl.abort();
    await api("/api/auth/logout", { method: "POST" }).catch(function () {});
    state.me = null; state.turns = []; state.coworkDraft = "";
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
  function newChat() { if (state.busy && currentCtl) currentCtl.abort(); state.turns = []; savePrefs(); renderThread(); $("#input").focus(); }

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
