// Partykeller Gruppe – App-Logik
const SUPABASE_URL = "https://txucqslsykzfhwugdolt.supabase.co";
const VAPID_PUBLIC = "BMv5gXP4GLGiqiD-lKGOmLbBYS1sob6VXg4frEZ7-Y33BWY4mff-NjikqVDk8q8uuO6pVnIFm3-UwoeR7CHz79s";
const SUPABASE_KEY = "sb_publishable_60QG69Q7CZ6Ai0qrGePH6w_sMXGaSdT";
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MON = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const DAY = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const store = { get(k) { try { return localStorage.getItem(k) } catch { return null } }, set(k, v) { try { localStorage.setItem(k, v) } catch {} } };

let me = null;          // eigenes Mitglied
let S = {};             // alle Daten
let busy = false;

function toast(text, bad = false) {
  const el = $("#toast"); el.textContent = text; el.classList.toggle("bad", bad); el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, bad ? 4000 : 1800);
}
function fail(err) {
  console.error(err);
  const m = String(err?.message || err || "");
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return toast("Keine Verbindung. Prüf dein Internet und versuch es nochmal.", true);
  toast("Hat nicht geklappt: " + m, true);
}
function show(screen) {
  ["loading", "login", "request", "waiting", "app"].forEach(s => $("#screen-" + s).hidden = s !== screen);
  $("#tabs").hidden = screen !== "app";
}
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = iso => { const d = new Date(iso); return `${DAY[d.getDay()]}, ${d.getDate()}. ${MON[d.getMonth()]}`; };

/* ---------- Login ---------- */
let mode = "login";
function setMode(m) {
  mode = m;
  $("#mode-login").classList.toggle("on", m === "login");
  $("#mode-signup").classList.toggle("on", m === "signup");
  $("#login-submit").textContent = m === "login" ? "Einloggen" : "Konto anlegen";
  $("#login-pw").autocomplete = m === "login" ? "current-password" : "new-password";
  $("#login-hint").textContent = m === "login" ? "Mit deiner E-Mail und deinem Passwort." : "Wähl ein Passwort mit mindestens 6 Zeichen. Danach meldest du dich mit deinem Namen bei Gerrit.";
  $("#login-error").hidden = true;
}
$$("[data-mode]").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));

$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#login-email").value.trim(), password = $("#login-pw").value;
  const btn = $("#login-submit"); btn.disabled = true; $("#login-error").hidden = true;
  try {
    const { data, error } = mode === "login"
      ? await db.auth.signInWithPassword({ email, password })
      : await db.auth.signUp({ email, password });
    if (error) throw error;
    if (mode === "signup" && !data.session) {
      showLoginError("Konto angelegt. Bitte bestätige den Link in der E-Mail und log dich dann ein.");
      setMode("login");
      return;
    }
    await boot();
  } catch (err) {
    const m = err.message || "";
    if (/Invalid login credentials/i.test(m)) showLoginError("E-Mail oder Passwort stimmt nicht.");
    else if (/already registered/i.test(m)) { showLoginError("Diese E-Mail hat schon ein Konto. Log dich einfach ein."); setMode("login"); }
    else if (/Password should be/i.test(m)) showLoginError("Das Passwort braucht mindestens 6 Zeichen.");
    else if (/Email not confirmed/i.test(m)) showLoginError("Bitte bestätige zuerst den Link in deiner E-Mail.");
    else showLoginError("Hat nicht geklappt: " + m);
  } finally { btn.disabled = false; }
});
function showLoginError(t) { const el = $("#login-error"); el.textContent = t; el.hidden = false; }

async function logout() { try { presence?.untrack(); } catch {} await db.auth.signOut(); me = null; S = {}; setMode("login"); show("login"); }

/* ---------- Start ---------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return show("login");
  try {
    const { data: mid, error } = await db.rpc("link_me");
    if (error) throw error;
    if (!mid) {
      const { data: req } = await db.from("join_requests").select("name").eq("user_id", session.user.id).maybeSingle();
      if (req) { $("#waiting-name").textContent = req.name; return show("waiting"); }
      return show("request");
    }
    await load(mid);
    me = S.members.find(m => m.id === mid);
    $("#tab-admin").hidden = !me?.is_admin;
    show("app");
    render();
    startRealtime();
  } catch (err) { show("login"); fail(err); }
}

$("#request-form").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#request-name").value.trim(); if (!name) return;
  const { error } = await db.from("join_requests").insert({ name });
  if (error) return fail(error);
  $("#waiting-name").textContent = name; show("waiting");
});

/* ---------- Daten ---------- */
async function load(myId = me?.id) {
  const q = (t, sel = "*") => db.from(t).select(sel);
  const res = await Promise.all([
    q("members", "id,name,bio,is_admin,user_id"), q("events"), q("rsvps"), q("polls"), q("poll_options"), q("poll_votes"),
    q("quotes"), q("rankings"), q("ranking_votes"), q("reactions"), q("chat_reads"),
    db.from("messages").select("*").order("created_at", { ascending: false }).limit(300)
  ]);
  // reactions / chat_reads gibt es erst nach chat2.sql – bis dahin einfach leer lassen
  [9, 10].forEach(i => { if (res[i].error) res[i] = { data: [], error: null }; });
  const err = res.find(r => r.error); if (err) throw err.error;
  const [members, events, rsvps, polls, options, pvotes, quotes, rankings, rvotes, reactions, reads, msgs] = res.map(r => r.data);
  S = { members: members.sort((a, b) => (b.is_admin - a.is_admin) || a.id - b.id), events, rsvps, polls, options, pvotes, quotes, rankings, rvotes, reactions, reads, messages: msgs.reverse(), requests: [] };
  if (members.find(m => m.id === myId)?.is_admin) {
    const { data } = await db.from("join_requests").select("*").order("created_at");
    S.requests = data || [];
  }
  await loadProst();
}
async function refresh() {
  if (busy || !me) return; busy = true;
  try { await load(); me = S.members.find(m => m.id === me.id) || me; render(); } catch (err) { fail(err); } finally { busy = false; }
}
async function run(promise, okText) {
  const { error } = await promise;
  if (error) { fail(error); return false; }
  if (okText) toast(okText);
  await refresh();
  return true;
}
const nameOf = id => S.members.find(m => m.id === id)?.name || "Ehemaliges Mitglied";
const canDelete = createdBy => me && (createdBy === me.id || me.is_admin);

/* ---------- Anzeige ---------- */
function render() { renderPush(); renderChat(); renderMembers(); renderEvents(); renderPolls(); renderQuotes(); renderRanks(); renderAdmin(); renderInstall(); renderProst(); }

function renderMembers() {
  const joined = S.members.filter(m => m.user_id).length;
  $("#members-lead").textContent = `${S.members.length} Leute, ein Keller. ${joined} davon sind schon hier eingeloggt.`;
  $("#members").innerHTML = S.members.map(m => `<div class="member${m.user_id ? "" : " away"}${m.id === me.id ? " mine" : ""}" data-id="${m.id}">
    <div class="av">${esc(m.name[0])}</div>
    <div class="txt"><strong>${esc(m.name)}</strong><span class="${m.bio ? "bio" : ""}">${esc(m.bio || (m.user_id ? "Steckbrief folgt" : "noch nicht dabei"))}</span></div></div>`).join("");
  if (document.activeElement !== $("#bio-input")) $("#bio-input").value = me.bio || "";
  if (presence) renderStatus();
}

function renderEvents() {
  const t = today();
  const sorted = [...S.events].sort((a, b) => a.day.localeCompare(b.day));
  const upcoming = sorted.filter(e => e.day >= t), past = sorted.filter(e => e.day < t).reverse().slice(0, 10);
  $("#events").innerHTML = upcoming.length ? upcoming.map(eventHTML).join("") : `<div class="empty">Noch kein Treffen geplant. Leg oben das nächste an.</div>`;
  $("#past-wrap").hidden = !past.length;
  $("#past-label").textContent = `Vergangene Treffen (${past.length})`;
  $("#events-past").innerHTML = past.map(eventHTML).join("");
}
function eventHTML(e) {
  const d = new Date(e.day + "T12:00");
  const rs = S.rsvps.filter(r => r.event_id === e.id);
  const yes = rs.filter(r => r.status === "yes").map(r => r.member_id), no = rs.filter(r => r.status === "no").map(r => r.member_id);
  const mine = rs.find(r => r.member_id === me.id)?.status;
  const open = S.members.length - yes.length - no.length;
  const pills = (ids, cls) => `<div class="names">${ids.map(id => `<span class="name${cls}${id === me.id ? " me" : ""}">${esc(nameOf(id))}</span>`).join("")}</div>`;
  return `<article class="event"><div class="date"><small>${DAY[d.getDay()]}</small><b>${d.getDate()}</b><small>${MON[d.getMonth()]}</small></div>
  <div style="min-width:0"><h3>${esc(e.title)}</h3>${e.info ? `<p class="info">${esc(e.info)}</p>` : `<p class="info"></p>`}
    <div class="rsvp">
      <button class="chip${mine === "yes" ? " on" : ""}" data-rsvp="${e.id}" data-s="yes">Bin dabei</button>
      <button class="chip${mine === "no" ? " on" : ""}" data-rsvp="${e.id}" data-s="no">Kann nicht</button>
    </div>
    <div class="guests"><span class="glabel">${yes.length} ${yes.length === 1 ? "kommt" : "kommen"}</span>${yes.length ? pills(yes, "") : `<span class="count">Noch keine Zusagen</span>`}</div>
    ${no.length ? `<div class="guests"><span class="glabel">${no.length} ${no.length === 1 ? "kann" : "können"} nicht</span>${pills(no, " off")}</div>` : ""}
    <div class="foot"><span class="count">${open > 0 ? `${open} haben sich noch nicht gemeldet` : "Alle haben sich gemeldet"}</span>${delBtn("event", e.id, e.created_by)}</div>
  </div></article>`;
}
function delBtn(kind, id, createdBy) {
  return canDelete(createdBy) ? `<button class="link danger" data-del="${kind}" data-id="${id}">Löschen</button>` : "";
}

function renderPolls() {
  const polls = [...S.polls].sort((a, b) => b.created_at.localeCompare(a.created_at));
  $("#polls").innerHTML = polls.length ? polls.map(p => {
    const opts = S.options.filter(o => o.poll_id === p.id).sort((a, b) => a.id - b.id);
    const votes = S.pvotes.filter(v => v.poll_id === p.id), total = votes.length;
    const mine = votes.find(v => v.member_id === me.id)?.option_id;
    return `<div class="poll"><h3>${esc(p.question)}</h3>
      ${opts.map(o => { const n = votes.filter(v => v.option_id === o.id).length;
        return `<button class="opt${mine === o.id ? " mine" : ""}" data-vote="${p.id}" data-o="${o.id}"><div class="bar" style="width:${total ? Math.round(n / total * 100) : 0}%"></div><span>${esc(o.label)}</span><span class="n">${n}</span></button>`; }).join("")}
      <div class="foot"><span class="by">${total} ${total === 1 ? "Stimme" : "Stimmen"} · von ${esc(nameOf(p.created_by))}</span>${delBtn("poll", p.id, p.created_by)}</div></div>`;
  }).join("") : `<div class="empty">Noch keine Abstimmung. Starte oben die erste.</div>`;
}

function renderQuotes() {
  const sel = $("#quote-who"), cur = sel.value;
  sel.innerHTML = S.members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
  if (cur) sel.value = cur;
  const qs = [...S.quotes].sort((a, b) => b.created_at.localeCompare(a.created_at));
  $("#quotes").innerHTML = qs.length ? qs.map(q => `<figure class="quote"><p>${esc(q.text)}</p>
    <footer class="foot"><span><b>${esc(nameOf(q.said_by))}</b> · ${fmtDate(q.created_at)}</span>${delBtn("quote", q.id, q.created_by)}</footer></figure>`).join("")
    : `<div class="empty">Die Wand ist noch leer. Wer hat zuletzt was Legendäres gesagt?</div>`;
}

function renderRanks() {
  const rs = [...S.rankings].sort((a, b) => b.created_at.localeCompare(a.created_at));
  $("#ranks").innerHTML = rs.length ? rs.map(r => {
    const votes = S.rvotes.filter(v => v.ranking_id === r.id);
    const tally = {}; votes.forEach(v => tally[v.nominee_id] = (tally[v.nominee_id] || 0) + 1);
    const list = Object.entries(tally).map(([id, n]) => [+id, n]).sort((a, b) => b[1] - a[1]);
    const max = list[0]?.[1] || 1, mine = votes.find(v => v.voter_id === me.id)?.nominee_id;
    return `<div class="rank"><h3>${esc(r.question)}</h3>
      ${list.length ? `<ol>${list.map(([id, n], k) => `<li><span class="pos">${k + 1}</span><div><div class="who"><span>${esc(nameOf(id))}</span><span class="count">${n}</span></div><div class="track"><div style="width:${n / max * 100}%"></div></div></div></li>`).join("")}</ol>` : `<p class="count">Noch keine Stimmen.</p>`}
      <div class="vote"><label for="rk-${r.id}">Deine Stimme</label><select id="rk-${r.id}" data-rank="${r.id}"><option value="">Auswählen …</option>${S.members.map(m => `<option value="${m.id}"${mine === m.id ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
      <div class="foot"><span class="by">${votes.length} ${votes.length === 1 ? "Stimme" : "Stimmen"} · von ${esc(nameOf(r.created_by))}</span>${delBtn("rank", r.id, r.created_by)}</div></div>`;
  }).join("") : `<div class="empty">Noch kein Ranking. Starte oben das erste.</div>`;
}

function renderAdmin() {
  if (!me.is_admin) return;
  const free = S.members.filter(m => !m.user_id);
  const badge = $("#req-badge"); badge.hidden = !S.requests.length; badge.textContent = S.requests.length;
  $("#requests").innerHTML = S.requests.length ? S.requests.map(r => {
    const guess = free.find(m => m.name.toLowerCase() === r.name.trim().toLowerCase());
    return `<div class="req"><div><b>${esc(r.name)}</b><div class="mail">${esc(r.email)}</div></div>
      <label class="count" for="req-${r.id}">Ist in der Gruppe:</label>
      <select id="req-${r.id}">${free.map(m => `<option value="${m.id}"${guess?.id === m.id ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
      <div class="row"><button class="btn" data-approve="${r.id}"${free.length ? "" : " disabled"}>Freischalten</button><button class="link danger" data-reject="${r.id}">Ablehnen</button></div></div>`;
  }).join("") : `<div class="empty">Keine offenen Anfragen.</div>`;
  $("#logins").innerHTML = S.members.map(m => `<div class="login-row"><span>${esc(m.name)} <span class="count">· ${m.user_id ? "eingeloggt" : "noch nicht dabei"}</span></span>
    ${m.user_id && !m.is_admin ? `<button class="link danger" data-unlink="${m.id}">Login lösen</button>` : ""}</div>`).join("");
}

function renderInstall() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const hidden = store.get("pk-install-hidden") === "1";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  $("#install-card").hidden = standalone || hidden;
  const samsung = /SamsungBrowser/i.test(navigator.userAgent);
  $("#install-text").textContent = ios
    ? "In Safari unten auf Teilen tippen und dann auf „Zum Home-Bildschirm“."
    : samsung
      ? "Unten rechts auf das Menü (drei Striche) tippen, dann „Seite hinzufügen zu“ und „Startbildschirm“."
      : "Oben rechts auf die drei Punkte tippen, dann „App installieren“ oder „Zum Startbildschirm hinzufügen“. Im Samsung-Browser: Menü unten rechts, „Seite hinzufügen zu“, „Startbildschirm“.";
}


/* ---------- Push-Benachrichtigungen ---------- */
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let pushOn = false;
async function currentSub() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function renderPush() {
  const card = $("#push-card"), text = $("#push-text"), btn = $("#push-btn");
  $("#chat-push-row").hidden = true; $("#prost-push-row").hidden = true;
  card.hidden = false; btn.hidden = false; card.classList.remove("on");
  if (isIOS && !isStandalone()) { text.textContent = "Leg die App zuerst auf den Home-Bildschirm und öffne sie von dort. Dann kannst du Benachrichtigungen einschalten."; btn.hidden = true; return; }
  if (!pushSupported) { text.textContent = "Dein Browser kann leider keine Benachrichtigungen empfangen."; btn.hidden = true; return; }
  if (Notification.permission === "denied") { text.textContent = "Benachrichtigungen sind blockiert. Du kannst sie in den Einstellungen deines Handys für diese App wieder erlauben."; btn.hidden = true; return; }
  const sub = await currentSub();
  pushOn = !!sub && Notification.permission === "granted";
  // Geraet bei jedem Start einmal beim Server auffrischen (falls es dort fehlt)
  if (pushOn && !renderPush.synced) {
    renderPush.synced = true;
    const j = sub.toJSON();
    db.rpc("save_push", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth }).then(({ error }) => { if (error) console.warn(error); });
  }
  card.classList.toggle("on", pushOn);
  text.textContent = pushOn ? "Sind auf diesem Gerät an: neue Termine, Erinnerungen am Vortag, neue Abstimmungen und Antworten auf dein Prost." : "Bekomm Bescheid bei neuen Terminen, Abstimmungen, Chat-Nachrichten und am Tag vor einem Treffen.";
  $("#chat-push-row").hidden = !pushOn;
  $("#prost-push-row").hidden = !pushOn || !S.prostReady;
  if (pushOn) {
    // Spalte "prost" gibt es erst nach prost.sql
    let { data, error } = await db.from("push_subscriptions").select("chat,prost").eq("endpoint", sub.endpoint).maybeSingle();
    if (error) ({ data } = await db.from("push_subscriptions").select("chat").eq("endpoint", sub.endpoint).maybeSingle());
    $("#chat-push").checked = data ? data.chat !== false : true;
    $("#prost-push").checked = data ? data.prost !== false : true;
  }
  btn.textContent = pushOn ? "Ausschalten" : "Aktivieren";
  btn.classList.toggle("ghost", pushOn);
}
function b64ToBytes(b64) {
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function togglePush() {
  const btn = $("#push-btn"); btn.disabled = true;
  try {
    if (pushOn) {
      const sub = await currentSub();
      if (sub) { await db.rpc("remove_push", { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
      toast("Benachrichtigungen aus");
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("Ohne Erlaubnis geht es leider nicht.", true); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC) });
      const j = sub.toJSON();
      const { error } = await db.rpc("save_push", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
      if (error) throw error;
      toast("Benachrichtigungen an");
    }
  } catch (err) { fail(err); }
  finally { btn.disabled = false; renderPush(); }
}


/* ---------- Chat ---------- */
const REACTS = { up: "👍", love: "❤️", lol: "😂", wow: "😮", sad: "😢", cheers: "🍻" };
const chatVisible = () => !$("#view-chat").hidden && !$("#screen-app").hidden && document.visibilityState === "visible";
const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
const toBottom = () => requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
const fmtTime = iso => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const listNames = ids => {
  const n = ids.map(nameOf);
  return n.length <= 1 ? (n[0] || "") : n.slice(0, -1).join(", ") + " und " + n[n.length - 1];
};
function dayLabel(iso) {
  const d = new Date(iso), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return "Heute";
  if (d.toDateString() === y.toDateString()) return "Gestern";
  return fmtDate(iso);
}

/* Erwaehnungen: @Name oder @alle */
function mentionRe() {
  const names = [...S.members.map(m => m.name), "alle"].sort((a, b) => b.length - a.length).map(escRe);
  return new RegExp(`(^|\\s)@(${names.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}
function findMentions(text) {
  const ids = new Set(); let all = false;
  for (const m of text.matchAll(mentionRe())) {
    const n = m[2].toLowerCase();
    if (n === "alle") { all = true; continue; }
    const mem = S.members.find(x => x.name.toLowerCase() === n);
    if (mem && mem.id !== me.id) ids.add(mem.id);
  }
  return { mentions: [...ids], mention_all: all };
}
function fmtText(text, re) {
  return esc(text).replace(re, (all, pre, name) => `${pre}<span class="mention">@${name}</span>`);
}

/* Wer zaehlt fuer die Haken: alle eingeloggten Mitglieder ausser dem Absender */
const readsOf = id => S.reads?.find(r => r.member_id === id) || { delivered_id: 0, read_id: 0 };
const othersFor = author => S.members.filter(m => m.user_id && m.id !== author).map(m => m.id);
function readState(m) {
  const others = m.whisper_to ? S.members.filter(x => x.id === m.whisper_to && x.user_id).map(x => x.id) : othersFor(m.member_id);
  const read = others.filter(id => readsOf(id).read_id >= m.id);
  const got = others.filter(id => Math.max(readsOf(id).delivered_id, readsOf(id).read_id) >= m.id);
  return { others, read, got };
}
function ticks(m) {
  const { others, read, got } = readState(m);
  const one = `<path d="M2 8.5l3.2 3.2L12 5"/>`, two = `<path d="M1 8.5l3.2 3.2L11 5"/><path d="M6.5 11.2l.5.5L14 5"/>`;
  if (!others.length || got.length < others.length) return `<svg class="ticks" viewBox="0 0 15 15" aria-label="gesendet">${one}</svg>`;
  const all = read.length === others.length;
  return `<svg class="ticks${all ? " read" : ""}" viewBox="0 0 15 15" aria-label="${all ? "von allen gelesen" : "zugestellt"}">${two}</svg>`;
}

let replyTo = null, editing = null, whisperTo = null, sheetMsg = null;
function renderChat() {
  if (!S.messages || !me) return;
  const stick = chatVisible() && nearBottom();
  const re = mentionRe();
  let lastDay = "", lastWho = null, html = "";
  for (const m of S.messages) {
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay) { html += `<div class="chat-day">${dayLabel(m.created_at)}</div>`; lastDay = day; lastWho = null; }
    const mine = m.member_id === me.id;
    const atMe = !mine && (m.mention_all || (m.mentions || []).includes(me.id));
    let quote = "";
    if (m.reply_to) {
      const o = S.messages.find(x => x.id === m.reply_to);
      quote = o
        ? `<span class="quote" data-jump="${o.id}"><b>${esc(o.member_id === me.id ? "Du" : nameOf(o.member_id))}</b><span>${esc(o.text.slice(0, 120))}</span></span>`
        : `<span class="quote gone"><span>Nachricht nicht mehr verfügbar</span></span>`;
    }
    const rs = (S.reactions || []).filter(r => r.message_id === m.id);
    const counts = {};
    rs.forEach(r => counts[r.kind] = (counts[r.kind] || 0) + 1);
    const chips = Object.keys(REACTS).filter(k => counts[k]).map(k => `<span>${REACTS[k]}${counts[k] > 1 ? `<small>${counts[k]}</small>` : ""}</span>`).join("");
    const myR = rs.some(r => r.member_id === me.id);
    html += `<div class="msg${mine ? " mine" : ""}" id="m-${m.id}">${!mine && lastWho !== m.member_id ? `<span class="who">${esc(nameOf(m.member_id))}</span>` : ""}
      <div class="bubble${atMe ? " at-me" : ""}${m.whisper_to ? " whisper" : ""}" data-msg="${m.id}" role="button" tabindex="0">${m.whisper_to ? `<span class="wh-label">${mine ? "Geflüstert an " + esc(nameOf(m.whisper_to)) : "Flüstert dir zu"}</span>` : ""}${quote}<span class="txt">${fmtText(m.text, re)}</span><span class="meta">${m.edited_at ? "bearbeitet · " : ""}${fmtTime(m.created_at)}${mine ? ticks(m) : ""}</span></div>
      ${chips ? `<button type="button" class="reacts${myR ? " me" : ""}" data-msg="${m.id}" aria-label="Reaktionen ansehen">${chips}</button>` : ""}</div>`;
    lastWho = m.member_id;
  }
  const last = S.messages[S.messages.length - 1];
  if (last) {
    const { others, read } = readState(last);
    if (others.length && read.length) {
      const names = read.slice(0, 4).map(id => id === me.id ? "dir" : nameOf(id));
      const more = read.length - names.length;
      html += `<div class="seen-by">${read.length === others.length ? "Von allen gelesen" : "Gelesen von " + names.join(", ") + (more > 0 ? ` und ${more} weiteren` : "")}</div>`;
    }
  }
  $("#chat-list").innerHTML = html || `<div class="empty">Noch ist es still im Keller. Schreib die erste Nachricht.</div>`;
  if (chatVisible()) { if (stick || !renderChat.done) toBottom(); renderChat.done = true; }
  markChat();
  updateChatBadge();
  if (sheetMsg) renderSheet();
}
function lastMsgId() { return S.messages?.length ? S.messages[S.messages.length - 1].id : 0; }
function seenId() { return Math.max(+(store.get("pk-chat-seen") || 0), readsOf(me?.id).read_id); }
function updateChatBadge() {
  const seen = seenId();
  const n = (S.messages || []).filter(m => m.id > seen && m.member_id !== me?.id).length;
  const b = $("#chat-badge"); b.hidden = !n || chatVisible(); b.textContent = n > 99 ? "99+" : n;
}

/* Zugestellt / gelesen an den Server melden */
const sentMark = { d: 0, r: 0 };
let markTimer = null;
function markChat() {
  if (!me || !S.messages) return;
  const top = lastMsgId(), d = top, r = chatVisible() ? top : 0;
  if (r) store.set("pk-chat-seen", String(r));
  if (d <= sentMark.d && r <= sentMark.r) return;
  clearTimeout(markTimer);
  markTimer = setTimeout(async () => {
    const nd = Math.max(d, sentMark.d), nr = Math.max(r, sentMark.r);
    const { error } = await db.rpc("mark_chat", { p_delivered: nd, p_read: nr });
    if (!error) { sentMark.d = nd; sentMark.r = nr; }
  }, 400);
}

/* Nachricht antippen: Reaktionen und Aktionen */
function openSheet(id) { sheetMsg = id; renderSheet(); $("#msg-sheet").hidden = false; }
function closeSheet() { sheetMsg = null; $("#msg-sheet").hidden = true; }
function renderSheet() {
  const m = S.messages.find(x => x.id === sheetMsg);
  if (!m) return closeSheet();
  const mine = m.member_id === me.id, rs = S.reactions.filter(r => r.message_id === m.id);
  const myKind = rs.find(r => r.member_id === me.id)?.kind;
  const who = Object.keys(REACTS).map(k => {
    const ids = rs.filter(r => r.kind === k).map(r => r.member_id);
    return ids.length ? `<div>${REACTS[k]} ${esc(ids.map(id => id === me.id ? "Du" : nameOf(id)).join(", "))}</div>` : "";
  }).join("");
  let info = "";
  if (mine) {
    const { others, read, got } = readState(m);
    const delivered = got.filter(id => !read.includes(id)), open = others.filter(id => !got.includes(id));
    info = `<div class="sheet-info">
      <div><svg class="ticks read" viewBox="0 0 15 15"><path d="M1 8.5l3.2 3.2L11 5"/><path d="M6.5 11.2l.5.5L14 5"/></svg> <b>Gelesen:</b> ${read.length ? esc(listNames(read)) : "noch niemand"}</div>
      <div><svg class="ticks" viewBox="0 0 15 15"><path d="M1 8.5l3.2 3.2L11 5"/><path d="M6.5 11.2l.5.5L14 5"/></svg> <b>Zugestellt:</b> ${delivered.length ? esc(listNames(delivered)) : "–"}</div>
      ${open.length ? `<div><svg class="ticks" viewBox="0 0 15 15"><path d="M2 8.5l3.2 3.2L12 5"/></svg> <b>Noch nicht angekommen:</b> ${esc(listNames(open))}</div>` : ""}
    </div>`;
  }
  const can = mine || me.is_admin;
  $("#msg-sheet .sheet-card").innerHTML = `
    <div class="sheet-preview"><b>${esc(mine ? "Du" : nameOf(m.member_id))}</b> ${esc(m.text.slice(0, 160))}</div>
    <div class="react-row">${Object.entries(REACTS).map(([k, e]) => `<button type="button" class="${myKind === k ? "on" : ""}" data-react="${k}" aria-label="Reaktion ${k}">${e}</button>`).join("")}</div>
    ${who ? `<div class="sheet-who">${who}</div>` : ""}
    ${info}
    <div class="sheet-acts">
      <button type="button" data-act="reply">${m.whisper_to ? "Zurückflüstern" : "Antworten"}</button>
      ${!mine && !m.whisper_to ? `<button type="button" data-act="whisper">${esc(nameOf(m.member_id))} etwas zuflüstern</button>` : ""}
      <button type="button" data-act="copy">Kopieren</button>
      ${mine ? `<button type="button" data-act="edit">Bearbeiten</button>` : ""}
      ${can ? `<button type="button" class="danger" data-act="del">Löschen</button>` : ""}
      <button type="button" class="muted" data-act="close">Schließen</button>
    </div>`;
}
async function react(kind) {
  const id = sheetMsg, cur = S.reactions.find(r => r.message_id === id && r.member_id === me.id);
  S.reactions = S.reactions.filter(r => !(r.message_id === id && r.member_id === me.id));
  let q;
  if (cur?.kind === kind) q = db.from("reactions").delete().match({ message_id: id, member_id: me.id });
  else { S.reactions.push({ message_id: id, member_id: me.id, kind }); q = db.from("reactions").upsert({ message_id: id, member_id: me.id, kind }); }
  closeSheet(); renderChat();
  const { error } = await q; if (error) { fail(error); refresh(); }
}
function renderCompose() {
  const bar = $("#compose-bar"), titles = [];
  let text = "";
  if (editing !== null) {
    titles.push("Nachricht bearbeiten"); text = S.messages.find(x => x.id === editing)?.text || "";
  } else {
    if (whisperTo) { titles.push("Flüstern an " + nameOf(whisperTo)); text = "Nur ihr beide seht diese Nachricht"; }
    if (replyTo) {
      const o = S.messages.find(x => x.id === replyTo);
      titles.push("Antwort an " + (o?.member_id === me.id ? "dich selbst" : nameOf(o?.member_id)));
      text = o?.text || "";
    }
  }
  bar.hidden = !titles.length;
  bar.classList.toggle("edit", editing !== null);
  bar.classList.toggle("whisper", editing === null && !!whisperTo);
  $("#cb-title").textContent = titles.join(" · ");
  $("#cb-text").textContent = text.slice(0, 120);
  $("#chat-send").textContent = editing !== null ? "Speichern" : whisperTo ? "Flüstern" : "Senden";
  $("#whisper-btn").classList.toggle("on", !!whisperTo && editing === null);
  $("#chat-input").placeholder = whisperTo && editing === null ? "Psst … nur " + nameOf(whisperTo) + " sieht das" : "Nachricht …";
}
function setCompose(mode, m) {
  const input = $("#chat-input");
  if (!mode) { replyTo = null; editing = null; whisperTo = null; }
  if (mode === "reply") { editing = null; replyTo = m.id; if (m.whisper_to) whisperTo = m.member_id === me.id ? m.whisper_to : m.member_id; }
  if (mode === "edit") { replyTo = null; whisperTo = null; editing = m.id; input.value = m.text; }
  if (mode === "whisper") { editing = null; whisperTo = m; }
  renderCompose();
  if (mode) input.focus();
}
function cancelCompose() { const wasEdit = editing !== null; setCompose(null); if (wasEdit) $("#chat-input").value = ""; }
let pendingDel = false;
document.getElementById("msg-sheet").addEventListener("click", async e => {
  if (e.target.id === "msg-sheet") return closeSheet();
  const b = e.target.closest("button"); if (!b) return;
  const m = S.messages.find(x => x.id === sheetMsg); if (!m) return closeSheet();
  if (b.dataset.react) return react(b.dataset.react);
  const a = b.dataset.act;
  if (a === "close") return closeSheet();
  if (a === "reply") { closeSheet(); return setCompose("reply", m); }
  if (a === "edit") { closeSheet(); return setCompose("edit", m); }
  if (a === "whisper") { closeSheet(); return setCompose("whisper", m.member_id); }
  if (a === "copy") { try { await navigator.clipboard.writeText(m.text); toast("Kopiert"); } catch { toast("Kopieren ging nicht", true); } return closeSheet(); }
  if (a === "del") {
    if (!pendingDel) { pendingDel = true; b.textContent = "Wirklich löschen?"; setTimeout(() => { pendingDel = false; if (b.isConnected) b.textContent = "Löschen"; }, 4000); return; }
    pendingDel = false; closeSheet();
    const { error } = await db.from("messages").delete().eq("id", m.id);
    if (error) return fail(error);
    S.messages = S.messages.filter(x => x.id !== m.id); renderChat(); toast("Gelöscht");
  }
});

/* Klicks im Chatverlauf: Nachricht oeffnen, zum Zitat springen */
$("#chat-list").addEventListener("click", e => {
  if (swipe.moved) return;
  const j = e.target.closest("[data-jump]");
  if (j) {
    const el = document.getElementById("m-" + j.dataset.jump);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
    return;
  }
  const b = e.target.closest("[data-msg]"); if (b) openSheet(+b.dataset.msg);
});
$("#chat-list").addEventListener("keydown", e => {
  const b = e.target.closest(".bubble[data-msg]");
  if (b && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openSheet(+b.dataset.msg); }
});

/* Nach rechts wischen = antworten (wie bei WhatsApp) */
const swipe = { el: null, x: 0, y: 0, dx: 0, moved: false };
$("#chat-list").addEventListener("touchstart", e => {
  const b = e.target.closest(".bubble"); swipe.moved = false;
  if (!b) return; swipe.el = b; swipe.x = e.touches[0].clientX; swipe.y = e.touches[0].clientY; swipe.dx = 0;
}, { passive: true });
$("#chat-list").addEventListener("touchmove", e => {
  if (!swipe.el) return;
  const dx = e.touches[0].clientX - swipe.x, dy = e.touches[0].clientY - swipe.y;
  if (Math.abs(dy) > 30 && Math.abs(dy) > Math.abs(dx)) { swipe.el.style.transform = ""; swipe.el = null; return; }
  if (dx > 8) { swipe.moved = true; swipe.dx = dx; swipe.el.style.transform = `translateX(${Math.min(dx, 80)}px)`; swipe.el.classList.toggle("swipe-ok", dx > 60); }
}, { passive: true });
$("#chat-list").addEventListener("touchend", () => {
  if (!swipe.el) return;
  const el = swipe.el; el.style.transform = ""; el.classList.remove("swipe-ok"); swipe.el = null;
  if (swipe.dx > 60) { const m = S.messages.find(x => x.id === +el.dataset.msg); if (m) setCompose("reply", m); }
  setTimeout(() => swipe.moved = false, 50);
});

/* Online und "schreibt gerade" */
let presence = null, amTyping = false, typingTimer = null;
function startPresence() {
  if (presence || !me) return;
  presence = db.channel("partykeller-online", { config: { presence: { key: String(me.id) } } });
  presence.on("presence", { event: "sync" }, renderStatus)
    .subscribe(st => { if (st === "SUBSCRIBED") trackMe(); });
}
function trackMe() {
  if (!presence) return;
  if (document.visibilityState !== "visible") { presence.untrack(); return; }
  presence.track({ typing: amTyping && !$("#view-chat").hidden });
}
function setTyping(on) {
  clearTimeout(typingTimer);
  if (on) typingTimer = setTimeout(() => setTyping(false), 4000);
  if (on === amTyping) return;
  amTyping = on; trackMe();
}
function onlineList() {
  const st = presence?.presenceState() || {};
  return Object.entries(st).map(([k, v]) => ({ id: +k, typing: v.some(x => x.typing) })).filter(o => o.id !== me?.id && S.members?.some(m => m.id === o.id));
}
function renderStatus() {
  const on = onlineList(), el = $("#chat-status");
  const typing = on.filter(o => o.typing).map(o => o.id);
  if (typing.length) { el.innerHTML = `<span class="typing"><i></i><i></i><i></i></span> ${esc(listNames(typing))} ${typing.length > 1 ? "schreiben" : "schreibt"} …`; el.className = "chat-status is-typing"; }
  else if (on.length) { el.innerHTML = `<span class="dot"></span> Online: ${esc(listNames(on.map(o => o.id)))}`; el.className = "chat-status"; }
  else { el.textContent = "Gerade ist sonst niemand online"; el.className = "chat-status quiet"; }
  const ids = new Set(on.map(o => o.id));
  $$("#members .member").forEach(div => div.classList.toggle("online", ids.has(+div.dataset.id)));
}

/* @-Vorschlaege beim Tippen */
function mentionQuery() {
  const input = $("#chat-input"), upto = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = upto.match(/(^|\s)@([^\s@]{0,20})$/);
  return m ? { q: m[2], start: upto.length - m[2].length - 1 } : null;
}
function renderMentionList() {
  const box = $("#mention-list"), mq = mentionQuery();
  box.dataset.mode = "";
  if (!mq || whisperTo) { box.hidden = true; return; }
  const q = mq.q.toLowerCase();
  const opts = [{ id: 0, name: "alle" }, ...S.members.filter(m => m.id !== me.id && m.user_id)]
    .filter(m => m.name.toLowerCase().startsWith(q)).slice(0, 8);
  if (!opts.length) { box.hidden = true; return; }
  box.innerHTML = opts.map(m => `<button type="button" data-mention="${esc(m.name)}">@${esc(m.name)}</button>`).join("");
  box.hidden = false;
}
$("#mention-list").addEventListener("mousedown", e => e.preventDefault());
function openWhisperPicker() {
  const box = $("#mention-list");
  const opts = S.members.filter(m => m.id !== me.id && m.user_id);
  if (!opts.length) return toast("Noch niemand außer dir ist eingeloggt.");
  box.innerHTML = `<span class="wh-hint">Flüstern an:</span>` + opts.map(m => `<button type="button" class="wh" data-whisper="${m.id}">${esc(m.name)}</button>`).join("");
  box.dataset.mode = "whisper"; box.hidden = false;
}
function closeList() { const box = $("#mention-list"); box.hidden = true; box.dataset.mode = ""; }
$("#whisper-btn").addEventListener("click", () => {
  if (editing !== null) return;
  if (whisperTo) { whisperTo = null; renderCompose(); return; }
  if ($("#mention-list").dataset.mode === "whisper" && !$("#mention-list").hidden) return closeList();
  openWhisperPicker();
});
$("#mention-list").addEventListener("click", e => {
  const w = e.target.closest("[data-whisper]");
  if (w) { closeList(); return setCompose("whisper", +w.dataset.whisper); }
  const b = e.target.closest("[data-mention]"); const mq = mentionQuery(); if (!b || !mq) return;
  const input = $("#chat-input"), pos = input.selectionStart ?? input.value.length;
  const ins = "@" + b.dataset.mention + " ";
  input.value = input.value.slice(0, mq.start) + ins + input.value.slice(pos);
  const c = mq.start + ins.length; input.setSelectionRange(c, c); input.focus();
  $("#mention-list").hidden = true;
});
$("#chat-input").addEventListener("input", e => { renderMentionList(); setTyping(!!e.target.value.trim()); });
$("#chat-input").addEventListener("keydown", e => { if (e.key === "Escape") { $("#mention-list").hidden = true; if (replyTo || editing !== null || whisperTo) cancelCompose(); } });
$("#chat-input").addEventListener("blur", () => setTimeout(() => { if ($("#mention-list").dataset.mode !== "whisper") $("#mention-list").hidden = true; }, 150));
$("#compose-bar").addEventListener("click", e => { if (e.target.closest("[data-act=cb-cancel]")) cancelCompose(); });

/* Platz unter dem Verlauf an die Hoehe des Eingabebereichs anpassen */
if ("ResizeObserver" in window) new ResizeObserver(([e]) => {
  const stick = chatVisible() && nearBottom();
  $("#chat-list").style.paddingBottom = Math.round(e.target.offsetHeight + 24) + "px";
  if (stick) toBottom();
}).observe($("#chat-form"));

/* Live-Verbindung */
let chatChannel = null;
const upsertBy = (arr, row, same) => { const i = arr.findIndex(x => same(x, row)); if (i >= 0) arr[i] = row; else arr.push(row); };
async function startRealtime() {
  startPresence();
  startProstRealtime();
  if (chatChannel) return;
  const { data: { session } } = await db.auth.getSession();
  if (session) { try { await db.realtime.setAuth(session.access_token); } catch {} }
  chatChannel = db.channel("partykeller-chat")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, ({ new: m }) => {
      if (!S.messages || S.messages.some(x => x.id === m.id)) return;
      S.messages.push(m); renderChat();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, ({ new: m }) => {
      if (!S.messages) return; const i = S.messages.findIndex(x => x.id === m.id); if (i >= 0) { S.messages[i] = m; renderChat(); }
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, ({ old }) => {
      if (!S.messages) return;
      S.messages = S.messages.filter(x => x.id !== old.id); renderChat();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "reactions" }, ({ eventType, new: n, old }) => {
      if (!S.reactions) return;
      const same = (a, b) => a.message_id === b.message_id && a.member_id === b.member_id;
      if (eventType === "DELETE") S.reactions = S.reactions.filter(r => !same(r, old));
      else upsertBy(S.reactions, n, same);
      renderChat();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "chat_reads" }, ({ eventType, new: n }) => {
      if (!S.reads || eventType === "DELETE") return;
      upsertBy(S.reads, n, (a, b) => a.member_id === b.member_id); renderChat();
    })
    .subscribe();
}

/* Senden / Speichern */
$("#chat-form").addEventListener("submit", async e => {
  e.preventDefault();
  const input = $("#chat-input"), text = input.value.trim(); if (!text) return;
  const btn = $("#chat-send"); btn.disabled = true;
  closeList();
  if (editing !== null) {
    const id = editing;
    const { data, error } = await db.from("messages").update({ text }).eq("id", id).select().single();
    btn.disabled = false;
    if (error) return fail(error);
    const i = S.messages.findIndex(x => x.id === id); if (i >= 0) S.messages[i] = data;
    input.value = ""; setCompose(null); renderChat(); toast("Geändert");
    return;
  }
  const row = { member_id: me.id, text, reply_to: replyTo, ...findMentions(text) };
  if (whisperTo) Object.assign(row, { whisper_to: whisperTo, mentions: [], mention_all: false });
  let { data, error } = await db.from("messages").insert(row).select().single();
  if (error && /column/i.test(error.message || "")) {
    btn.disabled = false;
    if (whisperTo) return toast("Flüstern ist noch nicht eingerichtet (chat3.sql fehlt).", true);
    ({ data, error } = await db.from("messages").insert({ member_id: me.id, text }).select().single());
  }
  btn.disabled = false;
  if (error) return fail(error);
  input.value = ""; input.focus(); setTyping(false); setCompose(null);
  if (!S.messages.some(x => x.id === data.id)) S.messages.push(data);
  renderChat(); toBottom();
});
$("#chat-push").addEventListener("change", async e => {
  const sub = await currentSub(); if (!sub) return;
  const { error } = await db.rpc("set_push_chat", { p_endpoint: sub.endpoint, p_on: e.target.checked });
  if (error) { e.target.checked = !e.target.checked; return fail(error); }
  toast(e.target.checked ? "Chat-Benachrichtigungen an" : "Chat stummgeschaltet (Erwähnungen und Antworten kommen trotzdem)");
});

/* ---------- Prost (wie Beer With Me) ---------- */
const DRINKS = {
  bier: { e: "🍺", l: "Bier" }, radler: { e: "🍋", l: "Radler" }, wein: { e: "🍷", l: "Wein" },
  sekt: { e: "🥂", l: "Sekt" }, longdrink: { e: "🍹", l: "Longdrink" }, cocktail: { e: "🍸", l: "Cocktail" },
  shot: { e: "🥃", l: "Shot" }, alkfrei: { e: "🧃", l: "Alkoholfrei" }, wasser: { e: "💧", l: "Wasser" }
};
let prostHours = +(store.get("pk-prost-hours") || 3);
let prostPeriod = store.get("pk-prost-period") || "month";
const P = () => S.prost || { sessions: [], drinks: [], joins: [] };
const isLive = s => new Date(s.ends_at) > new Date();
const drinksOf = sid => P().drinks.filter(d => d.session_id === sid).sort((a, b) => a.id - b.id);
const joinsOf = sid => P().joins.filter(j => j.session_id === sid);
const mySession = () => me && P().sessions.find(s => s.member_id === me.id && isLive(s));
const liveOthers = () => P().sessions.filter(s => isLive(s) && s.member_id !== me?.id).sort((a, b) => b.started_at.localeCompare(a.started_at));
const prostVisible = () => !$("#view-prost").hidden && !$("#screen-app").hidden;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function drinkSummary(list) {
  const c = {}; list.forEach(d => c[d.kind] = (c[d.kind] || 0) + 1);
  return Object.keys(DRINKS).filter(k => c[k]).map(k => `${c[k]}× ${DRINKS[k].l}`).join(", ");
}
function mapUrl(s) {
  return isIOS ? `https://maps.apple.com/?q=${encodeURIComponent(nameOf(s.member_id))}&ll=${s.lat},${s.lng}`
    : `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`;
}

/* Laden: Strichliste kann ueber 1000 Zeilen haben, darum seitenweise */
async function fetchAll(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) return { data: null, error };
    out.push(...data);
    if (data.length < 1000) return { data: out, error: null };
  }
}
async function loadProst() {
  const since = new Date(Date.now() - 400 * 864e5).toISOString();
  const recent = new Date(Date.now() - 2 * 864e5).toISOString();
  const [ss, ds, js] = await Promise.all([
    fetchAll(() => db.from("prost_sessions").select("*").gte("started_at", since).order("id")),
    fetchAll(() => db.from("prost_drinks").select("id,session_id,member_id,kind,created_at").gte("created_at", since).order("id")),
    db.from("prost_joins").select("*").gte("created_at", recent)
  ]);
  // Tabellen gibt es erst nach prost.sql – bis dahin zeigt der Bereich einen Hinweis
  S.prostReady = !ss.error;
  S.prost = S.prostReady ? { sessions: ss.data, drinks: ds.data || [], joins: js.data || [] } : { sessions: [], drinks: [], joins: [] };
}

/* Anzeige */
function renderProst() {
  if (!me || !S.prost) return;
  $("#prost-setup").hidden = S.prostReady; $("#prost-body").hidden = !S.prostReady;
  const live = liveOthers();
  const badge = $("#prost-badge"); badge.hidden = !live.length; badge.textContent = live.length;
  if (!S.prostReady) return;
  const mine = mySession();
  $("#prost-off").hidden = !!mine;
  $("#prost-mine").hidden = !mine;
  if (mine) $("#prost-mine").innerHTML = mineHTML(mine);
  $("#prost-live").innerHTML = live.length ? live.map(liveHTML).join("")
    : `<div class="empty">${mine ? "Außer dir ist gerade niemand unterwegs." : "Gerade ist niemand unterwegs. Mach du den Anfang."}</div>`;
  renderProstStats();
  renderProstHistory();
  if (prostVisible()) renderProstMap();
}
function mineHTML(s) {
  const ds = drinksOf(s.id), js = joinsOf(s.id);
  const coming = js.filter(j => j.kind === "coming").map(j => j.member_id), cheers = js.filter(j => j.kind === "cheers").map(j => j.member_id);
  return `<div class="pm-head"><span class="live-dot"></span><b>Du bist unterwegs</b></div>
    <p class="count">seit ${fmtTime(s.started_at)} · sichtbar bis ${fmtTime(s.ends_at)}${s.place ? " · " + esc(s.place) : ""}</p>
    <div class="pm-count"><b>${ds.length}</b><span>${ds.length === 1 ? "Getränk" : "Getränke"}${ds.length ? `<small>${esc(drinkSummary(ds))}</small>` : ""}</span></div>
    <span class="label">Noch eins? Antippen zählt mit.</span>
    <div class="drink-quick">${Object.entries(DRINKS).map(([k, d]) => `<button type="button" class="drink-b" data-drink="${k}" aria-label="${d.l} zählen"><span>${d.e}</span>${d.l}</button>`).join("")}</div>
    ${coming.length ? `<p class="pm-who"><b>Kommen vorbei:</b> ${esc(listNames(coming))}</p>` : ""}
    ${cheers.length ? `<p class="pm-who"><b>Prost von:</b> ${esc(listNames(cheers))}</p>` : ""}
    <div class="pm-acts">
      <button class="btn ghost" type="button" data-action="prost-extend">+1 Stunde</button>
      <button class="btn" type="button" data-action="prost-end">Ich geh nach Hause</button>
    </div>
    ${ds.length ? `<button class="link" type="button" data-action="prost-undo">Letztes Getränk zurücknehmen</button>` : ""}`;
}
function liveHTML(s) {
  const ds = drinksOf(s.id), js = joinsOf(s.id), myJ = js.find(j => j.member_id === me.id)?.kind;
  const coming = js.filter(j => j.kind === "coming").map(j => j.member_id);
  const last = ds[ds.length - 1];
  return `<article class="live">
    <div class="av">${esc(nameOf(s.member_id)[0])}</div>
    <div class="live-txt">
      <h3>${esc(nameOf(s.member_id))}${last ? ` <span class="live-drink" title="${DRINKS[last.kind]?.l || ""}">${DRINKS[last.kind]?.e || ""}</span>` : ""}</h3>
      <p class="count">seit ${fmtTime(s.started_at)} · ${plural(ds.length, "Getränk", "Getränke")}${s.place ? " · " + esc(s.place) : ""}</p>
      ${s.lat != null ? `<a class="maplink" href="${mapUrl(s)}" target="_blank" rel="noopener">Route in Karten-App öffnen</a>` : ""}
      <div class="rsvp">
        <button class="chip${myJ === "coming" ? " on" : ""}" type="button" data-join="${s.id}" data-k="coming">Ich komme!</button>
        <button class="chip${myJ === "cheers" ? " on" : ""}" type="button" data-join="${s.id}" data-k="cheers">Prost!</button>
      </div>
      ${coming.length ? `<p class="count live-coming">Kommen vorbei: ${esc(coming.map(id => id === me.id ? "du" : nameOf(id)).join(", "))}</p>` : ""}
    </div></article>`;
}
function periodStart(p) {
  const n = new Date();
  if (p === "week") return new Date(n.getTime() - 7 * 864e5);
  if (p === "month") return new Date(n.getFullYear(), n.getMonth(), 1);
  return new Date(n.getFullYear(), 0, 1);
}
function renderProstStats() {
  $$("#prost-period [data-period]").forEach(b => b.classList.toggle("on", b.dataset.period === prostPeriod));
  const from = periodStart(prostPeriod);
  const ss = P().sessions.filter(s => new Date(s.started_at) >= from), ids = new Set(ss.map(s => s.id));
  const ds = P().drinks.filter(d => ids.has(d.session_id));
  const per = {};
  ss.forEach(s => (per[s.member_id] ||= { n: 0, d: 0 }).n++);
  ds.forEach(d => (per[d.member_id] ||= { n: 0, d: 0 }).d++);
  const list = Object.entries(per).map(([id, v]) => ({ id: +id, ...v })).sort((a, b) => b.n - a.n || b.d - a.d);
  if (!list.length) { $("#prost-stats").innerHTML = `<div class="empty">In diesem Zeitraum wurde noch nicht angestoßen.</div>`; return; }
  const kinds = {}; ds.forEach(d => kinds[d.kind] = (kinds[d.kind] || 0) + 1);
  const fav = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0]?.[0];
  const max = list[0].n || 1;
  $("#prost-stats").innerHTML = `<div class="rank prost-stats">
    <p class="count">${plural(ss.length, "Runde", "Runden")} · ${plural(ds.length, "Getränk", "Getränke")}${fav ? ` · am häufigsten: ${DRINKS[fav].l}` : ""}</p>
    <ol>${list.map((r, k) => `<li${r.id === me.id ? ' class="mine"' : ""}><span class="pos">${k + 1}</span><div>
      <div class="who"><span>${esc(nameOf(r.id))}</span><span class="count">${plural(r.n, "Runde", "Runden")} · ${plural(r.d, "Getränk", "Getränke")}</span></div>
      <div class="track"><div style="width:${r.n / max * 100}%"></div></div></div></li>`).join("")}</ol></div>`;
}
function renderProstHistory() {
  const mine = P().sessions.filter(s => s.member_id === me.id && !isLive(s)).sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 8);
  $("#prost-history").innerHTML = mine.length ? mine.map(s => {
    const ds = drinksOf(s.id);
    return `<div class="hist"><div class="hist-txt"><b>${dayLabel(s.started_at)}</b> <span class="count">${fmtTime(s.started_at)} bis ${fmtTime(s.ends_at)}</span>
      ${s.place ? `<div class="count">${esc(s.place)}</div>` : ""}<div class="hist-d">${ds.length ? esc(drinkSummary(ds)) : "Nichts gezählt"}</div></div>
      ${delBtn("prost", s.id, s.member_id)}</div>`;
  }).join("") : `<div class="empty">Noch keine Runde. Wenn du "Ich geh nach Hause" tippst, landet sie hier.</div>`;
}

/* Karte (Leaflet wird erst geladen, wenn jemand seinen Standort teilt) */
let leafletP = null, pMap = null, pLayer = null, pMapKey = "";
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (!leafletP) leafletP = new Promise((res, rej) => {
    const css = document.createElement("link"); css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"; document.head.appendChild(css);
    const js = document.createElement("script"); js.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    js.onload = res; js.onerror = () => { leafletP = null; rej(new Error("Karte konnte nicht geladen werden")); };
    document.head.appendChild(js);
  });
  return leafletP;
}
async function renderProstMap() {
  const pts = P().sessions.filter(s => isLive(s) && s.lat != null && s.lng != null);
  const el = $("#prost-map"); el.hidden = !pts.length;
  if (!pts.length) { pMapKey = ""; return; }
  try { await loadLeaflet(); } catch { el.hidden = true; return; }
  if (!pMap) {
    pMap = L.map(el, { zoomControl: false, scrollWheelZoom: false });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(pMap);
    pLayer = L.layerGroup().addTo(pMap);
  }
  pMap.invalidateSize();
  pLayer.clearLayers();
  pts.forEach(s => {
    const n = drinksOf(s.id).length;
    L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "pin" + (s.member_id === me.id ? " mine" : ""), html: `<span>${esc(nameOf(s.member_id)[0])}</span>`, iconSize: [36, 36], iconAnchor: [18, 18], popupAnchor: [0, -16] }) })
      .bindPopup(`<b>${esc(s.member_id === me.id ? "Du" : nameOf(s.member_id))}</b>${s.place ? "<br>" + esc(s.place) : ""}<br>${plural(n, "Getränk", "Getränke")} seit ${fmtTime(s.started_at)}`)
      .addTo(pLayer);
  });
  const key = pts.map(s => `${s.id}:${s.lat},${s.lng}`).join("|");
  if (key !== pMapKey) { pMapKey = key; pMap.fitBounds(L.latLngBounds(pts.map(s => [s.lat, s.lng])), { padding: [40, 40], maxZoom: 15 }); }
}

/* Prost rufen */
function renderHours() { $$("#prost-hours [data-hours]").forEach(b => b.classList.toggle("on", +b.dataset.hours === prostHours)); }
function openProstSheet() {
  const last = store.get("pk-prost-kind") || "bier";
  $("#prost-kinds").innerHTML = Object.entries(DRINKS).map(([k, d]) => `<label class="drink"><input type="radio" name="prost-kind" value="${k}"${k === last ? " checked" : ""}><span class="d-in"><span class="e">${d.e}</span>${d.l}</span></label>`).join("");
  $("#prost-place").value = store.get("pk-prost-place") || "";
  $("#prost-geo").checked = store.get("pk-prost-geo") === "1";
  $("#prost-notify").checked = true;
  renderHours();
  $("#prost-sheet").hidden = false;
}
const closeProstSheet = () => $("#prost-sheet").hidden = true;
$("#prost-sheet").addEventListener("click", e => { if (e.target.id === "prost-sheet") closeProstSheet(); });
const getPos = () => new Promise((res, rej) => navigator.geolocation
  ? navigator.geolocation.getCurrentPosition(res, rej, { timeout: 10000, maximumAge: 120000 }) : rej(new Error("kein GPS")));

$("#prost-form").addEventListener("submit", async e => {
  e.preventDefault();
  const kind = document.querySelector('input[name="prost-kind"]:checked')?.value;
  if (!kind) return toast("Wähl erst ein Getränk aus.", true);
  const place = $("#prost-place").value.trim(), geo = $("#prost-geo").checked, notify = $("#prost-notify").checked;
  store.set("pk-prost-kind", kind); store.set("pk-prost-place", place); store.set("pk-prost-geo", geo ? "1" : "0");
  const btn = $("#prost-go"); btn.disabled = true;
  let lat = null, lng = null;
  if (geo) {
    btn.textContent = "Suche Standort …";
    try { const p = await getPos(); lat = +p.coords.latitude.toFixed(4); lng = +p.coords.longitude.toFixed(4); }
    catch { toast("Standort ging nicht. Prost geht trotzdem raus.", true); }
  }
  btn.textContent = "Prost rufen";
  const ok = await run(db.rpc("start_prost", { p_kind: kind, p_place: place, p_lat: lat, p_lng: lng, p_hours: prostHours, p_notify: notify }),
    notify ? "Prost! Alle wissen Bescheid." : "Prost!");
  btn.disabled = false;
  if (ok) { closeProstSheet(); window.scrollTo({ top: 0, behavior: "smooth" }); }
});

/* Strichliste und Runde steuern */
async function addDrink(kind) {
  const s = mySession(); if (!s) return;
  const tmp = { id: Number.MAX_SAFE_INTEGER - P().drinks.length, session_id: s.id, member_id: me.id, kind, created_at: new Date().toISOString() };
  P().drinks.push(tmp); renderProst();
  if (navigator.vibrate) navigator.vibrate(30);
  await run(db.from("prost_drinks").insert({ session_id: s.id, member_id: me.id, kind }), `+1 ${DRINKS[kind].l}`);
}
async function prostAction(a) {
  if (a === "prost-open") return openProstSheet();
  if (a === "prost-close") return closeProstSheet();
  const s = mySession(); if (!s) return;
  if (a === "prost-end") return run(db.from("prost_sessions").update({ ends_at: new Date().toISOString() }).eq("id", s.id), "Gut heimkommen!");
  if (a === "prost-extend") {
    const cap = new Date(s.started_at).getTime() + 12 * 36e5;
    const next = Math.min(Math.max(new Date(s.ends_at).getTime(), Date.now()) + 36e5, cap);
    if (next <= new Date(s.ends_at).getTime()) return toast("Länger als 12 Stunden geht eine Runde nicht.", true);
    return run(db.from("prost_sessions").update({ ends_at: new Date(next).toISOString() }).eq("id", s.id), "Eine Stunde länger sichtbar");
  }
  if (a === "prost-undo") {
    const last = drinksOf(s.id).filter(d => d.member_id === me.id).pop(); if (!last) return;
    return run(db.from("prost_drinks").delete().eq("id", last.id), "Zurückgenommen");
  }
}
async function answerProst(sid, kind) {
  const cur = joinsOf(sid).find(j => j.member_id === me.id);
  if (cur?.kind === kind) return run(db.from("prost_joins").delete().eq("id", cur.id), "Zurückgenommen");
  return run(db.rpc("answer_prost", { p_session: sid, p_kind: kind }), kind === "coming" ? "Ist Bescheid gegeben" : "Prost zurück!");
}
$("#prost-push").addEventListener("change", async e => {
  const sub = await currentSub(); if (!sub) return;
  const { error } = await db.rpc("set_push_prost", { p_endpoint: sub.endpoint, p_on: e.target.checked });
  if (error) { e.target.checked = !e.target.checked; return fail(error); }
  toast(e.target.checked ? "Prost-Meldungen an" : "Prost-Meldungen aus (Antworten auf dein Prost kommen trotzdem)");
});

/* Live: wenn jemand Prost ruft, zaehlt oder antwortet */
let prostChannel = null, prostTimer = null;
function startProstRealtime() {
  if (prostChannel || !S.prostReady) return;
  const changed = () => { clearTimeout(prostTimer); prostTimer = setTimeout(async () => { try { await loadProst(); renderProst(); } catch {} }, 400); };
  prostChannel = db.channel("partykeller-prost");
  ["prost_sessions", "prost_drinks", "prost_joins"].forEach(table => prostChannel.on("postgres_changes", { event: "*", schema: "public", table }, changed));
  prostChannel.subscribe();
}

/* ---------- Aktionen ---------- */
const pendingDelete = new Set();
document.addEventListener("click", async e => {
  const t = e.target.closest("button, [data-tab]"); if (!t || t.closest("#chat-list, #msg-sheet, #chat-form")) return;
  if (t.dataset.tab) {
    $$("[data-tab]").forEach(b => b.setAttribute("aria-selected", b === t));
    $$(".view").forEach(v => v.hidden = v.id !== "view-" + t.dataset.tab);
    store.set("pk-tab", t.dataset.tab);
    if (t.dataset.tab === "prost") renderProstMap();
    if (t.dataset.tab === "chat") { renderChat.done = false; if (S.messages) renderChat(); renderStatus(); } else { window.scrollTo({ top: 0 }); closeSheet(); setTyping(false); }
    updateChatBadge();
    return;
  }
  const a = t.dataset.action;
  if (a === "logout") return logout();
  if (a === "push-toggle") return togglePush();
  if (a === "recheck") return boot();
  if (a && a.startsWith("prost-")) return prostAction(a);
  if (t.dataset.hours) { prostHours = +t.dataset.hours; store.set("pk-prost-hours", prostHours); return renderHours(); }
  if (t.dataset.period) { prostPeriod = t.dataset.period; store.set("pk-prost-period", prostPeriod); return renderProstStats(); }
  if (t.dataset.drink) return addDrink(t.dataset.drink);
  if (t.dataset.join) return answerProst(+t.dataset.join, t.dataset.k);
  if (a === "hide-install") { store.set("pk-install-hidden", "1"); $("#install-card").hidden = true; return; }
  if (a === "add-opt") {
    const n = $$(".poll-opt").length; if (n >= 6) return toast("Mehr als 6 Antworten gehen nicht.");
    $("#poll-opts").insertAdjacentHTML("beforeend", `<input class="poll-opt" id="poll-opt-${n + 1}" maxlength="60" placeholder="Antwort ${n + 1}" aria-label="Antwort ${n + 1}">`);
    return;
  }
  if (t.dataset.rsvp) {
    const event_id = +t.dataset.rsvp, status = t.dataset.s;
    const cur = S.rsvps.find(r => r.event_id === event_id && r.member_id === me.id);
    if (cur?.status === status) return run(db.from("rsvps").delete().match({ event_id, member_id: me.id }), "Zurückgenommen");
    return run(db.from("rsvps").upsert({ event_id, member_id: me.id, status }), status === "yes" ? "Zugesagt" : "Abgesagt");
  }
  if (t.dataset.vote) {
    const poll_id = +t.dataset.vote, option_id = +t.dataset.o;
    const cur = S.pvotes.find(v => v.poll_id === poll_id && v.member_id === me.id);
    if (cur?.option_id === option_id) return run(db.from("poll_votes").delete().match({ poll_id, member_id: me.id }), "Stimme zurückgenommen");
    return run(db.from("poll_votes").upsert({ poll_id, member_id: me.id, option_id }), "Stimme gezählt");
  }
  if (t.dataset.del) {
    const key = t.dataset.del + t.dataset.id;
    if (!pendingDelete.has(key)) {
      pendingDelete.add(key); t.textContent = "Wirklich löschen?";
      setTimeout(() => { pendingDelete.delete(key); if (t.isConnected) t.textContent = "Löschen"; }, 4000);
      return;
    }
    pendingDelete.delete(key);
    const table = { event: "events", poll: "polls", quote: "quotes", rank: "rankings", msg: "messages", prost: "prost_sessions" }[t.dataset.del];
    return run(db.from(table).delete().eq("id", +t.dataset.id), "Gelöscht");
  }
  if (t.dataset.approve) {
    const sel = $("#req-" + t.dataset.approve);
    return run(db.rpc("approve_request", { req_id: +t.dataset.approve, target_member: +sel.value }), "Freigeschaltet");
  }
  if (t.dataset.reject) return run(db.from("join_requests").delete().eq("id", +t.dataset.reject), "Anfrage abgelehnt");
  if (t.dataset.unlink) return run(db.rpc("unlink_member", { target_member: +t.dataset.unlink }), "Login gelöst");
});

document.addEventListener("change", e => {
  const s = e.target.closest("[data-rank]"); if (!s) return;
  const ranking_id = +s.dataset.rank;
  if (!s.value) return run(db.from("ranking_votes").delete().match({ ranking_id, voter_id: me.id }), "Stimme zurückgenommen");
  run(db.from("ranking_votes").upsert({ ranking_id, voter_id: me.id, nominee_id: +s.value }), "Stimme gezählt");
});

$("#bio-form").addEventListener("submit", async e => {
  e.preventDefault(); $("#bio-input").blur();
  run(db.rpc("set_my_bio", { new_bio: $("#bio-input").value }), "Steckbrief gespeichert");
});

$("#event-form").addEventListener("submit", async e => {
  e.preventDefault();
  const ok = await run(db.from("events").insert({ title: $("#ev-title").value.trim(), day: $("#ev-day").value, info: $("#ev-info").value.trim(), created_by: me.id }), "Termin angelegt");
  if (ok) { e.target.reset(); $("#new-event").open = false; }
});

$("#poll-form").addEventListener("submit", async e => {
  e.preventDefault();
  const labels = $$(".poll-opt").map(i => i.value.trim()).filter(Boolean);
  if (labels.length < 2) return toast("Es braucht mindestens 2 Antworten.", true);
  const { data, error } = await db.from("polls").insert({ question: $("#poll-q").value.trim(), created_by: me.id }).select("id").single();
  if (error) return fail(error);
  const ok = await run(db.from("poll_options").insert(labels.map(label => ({ poll_id: data.id, label }))), "Abstimmung gestartet");
  if (ok) { e.target.reset(); $$(".poll-opt").slice(2).forEach(i => i.remove()); $("#new-poll").open = false; }
});

$("#quote-form").addEventListener("submit", async e => {
  e.preventDefault();
  const ok = await run(db.from("quotes").insert({ text: $("#quote-text").value.trim(), said_by: +$("#quote-who").value, created_by: me.id }), "Hängt an der Wand");
  if (ok) $("#quote-text").value = "";
});

$("#rank-form").addEventListener("submit", async e => {
  e.preventDefault();
  const ok = await run(db.from("rankings").insert({ question: $("#rank-q").value.trim(), created_by: me.id }), "Ranking gestartet");
  if (ok) { e.target.reset(); $("#new-rank").open = false; }
});

$("#add-member-form").addEventListener("submit", async e => {
  e.preventDefault();
  const ok = await run(db.rpc("add_member", { member_name: $("#add-member-name").value }), "Mitglied hinzugefügt");
  if (ok) e.target.reset();
});

/* Beim Zurueckkehren in die App neu laden, damit alle das Gleiche sehen */
document.addEventListener("visibilitychange", () => {
  trackMe();
  if (document.visibilityState === "visible") { refresh(); if (S.messages) renderChat(); }
});
setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 60000);

/* Letzten Bereich merken */
const hashTab = location.hash.slice(1);
const lastTab = ["termine", "prost", "chat", "wall", "gruppe", "admin"].includes(hashTab) ? hashTab : store.get("pk-tab");
if (lastTab && (lastTab !== "admin" || hashTab === "admin")) { const b = document.querySelector(`[data-tab="${lastTab}"]`); if (b) b.click(); }

/* Antippen einer Benachrichtigung bei offener App: passenden Bereich zeigen */
window.addEventListener("hashchange", () => {
  const b = document.querySelector(`[data-tab="${location.hash.slice(1)}"]`);
  if (b && !b.hidden && !$("#screen-app").hidden) b.click();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
db.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") show("login"); });
boot();
