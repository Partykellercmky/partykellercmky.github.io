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

async function logout() { await db.auth.signOut(); me = null; S = {}; setMode("login"); show("login"); }

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
    q("quotes"), q("rankings"), q("ranking_votes")
  ]);
  const err = res.find(r => r.error); if (err) throw err.error;
  const [members, events, rsvps, polls, options, pvotes, quotes, rankings, rvotes] = res.map(r => r.data);
  S = { members: members.sort((a, b) => (b.is_admin - a.is_admin) || a.id - b.id), events, rsvps, polls, options, pvotes, quotes, rankings, rvotes, requests: [] };
  if (members.find(m => m.id === myId)?.is_admin) {
    const { data } = await db.from("join_requests").select("*").order("created_at");
    S.requests = data || [];
  }
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
function render() { renderPush(); renderMembers(); renderEvents(); renderPolls(); renderQuotes(); renderRanks(); renderAdmin(); renderInstall(); }

function renderMembers() {
  const joined = S.members.filter(m => m.user_id).length;
  $("#members-lead").textContent = `${S.members.length} Leute, ein Keller. ${joined} davon sind schon hier eingeloggt.`;
  $("#members").innerHTML = S.members.map(m => `<div class="member${m.user_id ? "" : " away"}${m.id === me.id ? " mine" : ""}">
    <div class="av">${esc(m.name[0])}</div>
    <div class="txt"><strong>${esc(m.name)}</strong><span class="${m.bio ? "bio" : ""}">${esc(m.bio || (m.user_id ? "Steckbrief folgt" : "noch nicht dabei"))}</span></div></div>`).join("");
  if (document.activeElement !== $("#bio-input")) $("#bio-input").value = me.bio || "";
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
  card.hidden = false; btn.hidden = false; card.classList.remove("on");
  if (isIOS && !isStandalone()) { text.textContent = "Leg die App zuerst auf den Home-Bildschirm und öffne sie von dort. Dann kannst du Benachrichtigungen einschalten."; btn.hidden = true; return; }
  if (!pushSupported) { text.textContent = "Dein Browser kann leider keine Benachrichtigungen empfangen."; btn.hidden = true; return; }
  if (Notification.permission === "denied") { text.textContent = "Benachrichtigungen sind blockiert. Du kannst sie in den Einstellungen deines Handys für diese App wieder erlauben."; btn.hidden = true; return; }
  pushOn = !!(await currentSub()) && Notification.permission === "granted";
  card.classList.toggle("on", pushOn);
  text.textContent = pushOn ? "Sind auf diesem Gerät an: neue Termine, Erinnerungen am Vortag und neue Abstimmungen." : "Bekomm Bescheid bei neuen Terminen, neuen Abstimmungen und am Tag vor einem Treffen.";
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

/* ---------- Aktionen ---------- */
const pendingDelete = new Set();
document.addEventListener("click", async e => {
  const t = e.target.closest("button, [data-tab]"); if (!t) return;
  if (t.dataset.tab) {
    $$("[data-tab]").forEach(b => b.setAttribute("aria-selected", b === t));
    $$(".view").forEach(v => v.hidden = v.id !== "view-" + t.dataset.tab);
    store.set("pk-tab", t.dataset.tab);
    window.scrollTo({ top: 0 });
    return;
  }
  const a = t.dataset.action;
  if (a === "logout") return logout();
  if (a === "push-toggle") return togglePush();
  if (a === "recheck") return boot();
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
    const table = { event: "events", poll: "polls", quote: "quotes", rank: "rankings" }[t.dataset.del];
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
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 60000);

/* Letzten Bereich merken */
const hashTab = location.hash.slice(1);
const lastTab = ["termine", "wall", "gruppe", "admin"].includes(hashTab) ? hashTab : store.get("pk-tab");
if (lastTab && (lastTab !== "admin" || hashTab === "admin")) { const b = document.querySelector(`[data-tab="${lastTab}"]`); if (b) b.click(); }

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
db.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") show("login"); });
boot();
