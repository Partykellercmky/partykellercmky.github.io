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
  if (typeof updateHeader === "function") updateHeader();
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
    showView(initialView());
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
  await loadNews();
  await loadSongs();
  await loadPhotos();
  await loadBirthdays();
  await loadMemories();
  await loadSnaps();
}
async function loadBirthdays() {
  const { data, error } = await db.from("members").select("id,bday_day,bday_month,bday_year");
  // Spalten gibt es erst nach geburtstag.sql
  S.bdayReady = !error;
  for (const b of data || []) Object.assign(S.members.find(m => m.id === b.id) || {}, b);
}
async function loadPhotos() {
  const { data, error } = await db.from("event_photos").select("*").order("id");
  // Tabelle gibt es erst nach fotos.sql
  S.photosReady = !error; S.photos = data || [];
}
async function loadSongs() {
  const [s, v] = await Promise.all([db.from("event_songs").select("*"), db.from("song_votes").select("*")]);
  // Tabellen gibt es erst nach playlist.sql
  S.songsReady = !s.error;
  S.songs = s.data || []; S.songVotes = v.data || [];
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
function render() { document.body.classList.toggle("is-admin", !!me?.is_admin); renderSnaps(); renderMemories(); renderBirthdays(); renderPush(); renderChat(); renderMembers(); renderEvents(); renderPolls(); renderQuotes(); renderRanks(); renderAdmin(); renderInstall(); renderProst(); $("#wsub-king-btn").hidden = !S.prostReady; setWallSub(wallSub); renderNews(); renderStart(); }

function renderMembers() {
  const joined = S.members.filter(m => m.user_id).length;
  $("#members-lead").textContent = `${S.members.length} Leute, ein Keller. ${joined} davon sind schon hier eingeloggt.`;
  $("#menu-gruppe-sub").textContent = `${S.members.length} Leute, ${joined} eingeloggt`;
  $("#members").innerHTML = S.members.map(m => `<div class="member${m.user_id ? "" : " away"}${m.id === me.id ? " mine" : ""}" data-id="${m.id}">
    <div class="av">${esc(m.name[0])}</div>
    <div class="txt"><strong>${esc(m.name)}</strong><span class="${m.bio ? "bio" : ""}">${esc(m.bio || (m.user_id ? "Steckbrief folgt" : "noch nicht dabei"))}</span>${m.bday_day ? `<span class="m-bday">Geb. ${m.bday_day}. ${MON[m.bday_month - 1]}</span>` : ""}</div></div>`).join("");
  if (document.activeElement !== $("#bio-input")) $("#bio-input").value = me.bio || "";
  if (presence) renderStatus();
}

function renderEvents() {
  // Eingetippte Songs beim Neuzeichnen nicht verlieren
  const keep = $$("[data-plform]").map(f => [f.dataset.plform, f.link.value, f.title.value, f.contains(document.activeElement) ? document.activeElement.name : null]);
  const t = today();
  const sorted = [...S.events].sort((a, b) => a.day.localeCompare(b.day));
  const upcoming = sorted.filter(e => e.day >= t), past = sorted.filter(e => e.day < t).reverse().slice(0, 10);
  $("#events").innerHTML = upcoming.length ? upcoming.map(eventHTML).join("") : `<div class="empty">Noch kein Treffen geplant. Leg oben das nächste an.</div>`;
  $("#past-wrap").hidden = !past.length;
  $("#past-label").textContent = `Vergangene Treffen (${past.length})`;
  $("#events-past").innerHTML = past.map(eventHTML).join("");
  keep.forEach(([id, link, title, focus]) => {
    const f = document.querySelector(`[data-plform="${id}"]`); if (!f) return;
    f.link.value = link; f.title.value = title; if (focus) f[focus].focus();
  });
  if (S.photosReady) openPhotos.forEach(id => loadThumbs(id));
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
    ${S.songsReady ? playlistHTML(e) : ""}
    ${S.photosReady ? photosHTML(e) : ""}
    <div class="foot"><span class="count">${open > 0 ? `${open} haben sich noch nicht gemeldet` : "Alle haben sich gemeldet"}</span>${delBtn("event", e.id, e.created_by)}</div>
  </div></article>`;
}

/* ---------- Playlist pro Termin ---------- */
const openLists = new Set();
const songVotes = id => S.songVotes.filter(v => v.song_id === id);
function playlistHTML(e) {
  const songs = S.songs.filter(s => s.event_id === e.id)
    .sort((a, b) => (songVotes(b.id).length - songVotes(a.id).length) || a.id - b.id);
  const isOpen = openLists.has(e.id), past = e.day < today();
  const head = `<button class="pl-toggle${isOpen ? " on" : ""}" type="button" data-pl="${e.id}" aria-expanded="${isOpen}">
    <span>Playlist</span><span class="count">${songs.length} ${songs.length === 1 ? "Song" : "Songs"}</span></button>`;
  if (!isOpen) return `<div class="pl">${head}</div>`;
  const list = songs.length ? `<ol class="pl-list">${songs.map((s, i) => {
    const votes = songVotes(s.id), mine = votes.some(v => v.member_id === me.id);
    const link = s.url || `https://open.spotify.com/search/${encodeURIComponent(s.title)}`;
    return `<li class="song">
      <span class="pl-nr">${i + 1}</span>
      ${s.cover ? `<img class="pl-cover" src="${esc(s.cover)}" alt="" loading="lazy">` : `<span class="pl-cover none" aria-hidden="true">&#9835;</span>`}
      <div class="pl-txt"><strong>${esc(s.title)}</strong><small>von ${s.added_by === me.id ? "dir" : esc(nameOf(s.added_by))}</small>
        <div class="pl-links"><a href="${esc(link)}" target="_blank" rel="noopener">${s.url ? "In Spotify öffnen" : "In Spotify suchen"}</a>${s.url ? `<a href="https://song.link/${esc(s.url)}" target="_blank" rel="noopener">Andere Apps</a>` : ""}${canDeleteSong(s) ? `<button class="link danger" data-del="song" data-id="${s.id}">Löschen</button>` : ""}</div></div>
      <button class="pl-vote${mine ? " on" : ""}" type="button" data-songvote="${s.id}" aria-pressed="${mine}" aria-label="Hochvoten"><span>&#9650;</span><b>${votes.length}</b></button>
    </li>`; }).join("")}</ol>` : `<p class="muted pl-empty">Noch keine Songs. Reich den ersten ein.</p>`;
  const form = past ? "" : `<form class="pl-form" data-plform="${e.id}">
      <input name="link" inputmode="url" maxlength="300" placeholder="Spotify-Link (einfügen)" aria-label="Spotify-Link">
      <input name="title" maxlength="120" placeholder="oder Titel – Künstler" aria-label="Titel und Künstler">
      <button class="btn" type="submit">Song einreichen</button>
    </form>`;
  return `<div class="pl">${head}${form}${list}</div>`;
}
/* ---------- Fotos pro Termin ---------- */
const openPhotos = new Set();
const urlCache = {};   // Pfad -> { url, until }
const photosOf = id => S.photos.filter(p => p.event_id === id);
function photosHTML(e) {
  const list = photosOf(e.id), isOpen = openPhotos.has(e.id);
  const head = `<button class="pl-toggle${isOpen ? " on" : ""}" type="button" data-ph="${e.id}" aria-expanded="${isOpen}">
    <span>Fotos</span><span class="count">${list.length} ${list.length === 1 ? "Foto" : "Fotos"}</span></button>`;
  if (!isOpen) return `<div class="pl">${head}</div>`;
  const grid = list.length ? `<div class="ph-grid">${list.map(p => {
    const u = urlCache[p.thumb]?.url;
    return `<button type="button" class="ph" data-photo="${p.id}" aria-label="Foto von ${esc(nameOf(p.added_by))} ansehen">${u ? `<img src="${esc(u)}" alt="" loading="lazy">` : ""}</button>`; }).join("")}</div>`
    : `<p class="muted pl-empty">Noch keine Fotos. Lad die ersten hoch.</p>`;
  const ready = saveAll.event === e.id && saveAll.files;
  const allBtn = list.length > 1 ? `<button type="button" class="btn${ready ? "" : " ghost"}" data-phall="${e.id}"${saveAll.event === e.id && !ready ? " disabled" : ""}>${ready ? `Jetzt ${saveAll.files.length} Fotos sichern` : saveAll.event === e.id ? "Fotos werden geladen …" : "Alle speichern"}</button>` : "";
  return `<div class="pl">${head}
    <div class="ph-acts"><label class="btn ghost ph-add">Fotos hochladen<input type="file" accept="image/*" multiple hidden data-phup="${e.id}"></label>${allBtn}</div>
    ${grid}</div>`;
}
async function signUrls(paths, bucket = "fotos") {
  const now = Date.now(), need = [...new Set(paths)].filter(p => !(urlCache[p]?.until > now));
  if (!need.length) return true;
  const { data, error } = await db.storage.from(bucket).createSignedUrls(need, 3600);
  if (error) { fail(error); return false; }
  data.forEach(d => { if (d.signedUrl) urlCache[d.path] = { url: d.signedUrl, until: now + 50 * 60000 }; });
  return true;
}
const thumbsBusy = new Set();
async function loadThumbs(eventId) {
  const list = photosOf(eventId); if (!list.length || thumbsBusy.has(eventId)) return;
  if (!list.some(p => !(urlCache[p.thumb]?.until > Date.now()))) return;
  thumbsBusy.add(eventId);
  const ok = await signUrls(list.map(p => p.thumb));
  thumbsBusy.delete(eventId);
  if (ok) renderEvents();
}
function shrink(file, max, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image(), src = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(src);
      c.toBlob(b => b ? resolve(b) : reject(new Error("Bild konnte nicht verkleinert werden")), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error("Dieses Bildformat geht leider nicht")); };
    img.src = src;
  });
}
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
async function uploadPhotos(eventId, files) {
  files = [...files].filter(f => f.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
  if (!files.length) return;
  let ok = 0;
  for (const [i, f] of files.entries()) {
    toast(`Lade Foto ${i + 1} von ${files.length} hoch …`);
    try {
      const [big, small] = await Promise.all([shrink(f, 1600, 0.8), shrink(f, 400, 0.7)]);
      const id = rid(), path = `${eventId}/${id}.jpg`, thumb = `${eventId}/${id}_t.jpg`;
      const st = db.storage.from("fotos");
      let r = await st.upload(path, big, { contentType: "image/jpeg" }); if (r.error) throw r.error;
      r = await st.upload(thumb, small, { contentType: "image/jpeg" }); if (r.error) { await st.remove([path]); throw r.error; }
      r = await db.from("event_photos").insert({ event_id: eventId, path, thumb, added_by: me.id });
      if (r.error) { await st.remove([path, thumb]); throw r.error; }
      ok++;
    } catch (err) { fail(err); }
  }
  await refresh();
  loadThumbs(eventId);
  if (ok) toast(ok === 1 ? "Foto ist drin" : `${ok} Fotos sind drin`);
}
document.addEventListener("change", e => {
  const inp = e.target.closest("[data-phup]"); if (!inp) return;
  uploadPhotos(+inp.dataset.phup, inp.files); inp.value = "";
});

/* Foto groß ansehen, speichern, löschen */
let viewPhoto = null;
async function openPhoto(id) {
  const p = S.photos.find(x => x.id === id); if (!p) return;
  viewPhoto = id;
  const sh = $("#photo-sheet"), canDel = me && (p.added_by === me.id || me.is_admin);
  const list = photosOf(p.event_id), i = list.findIndex(x => x.id === id);
  sh.querySelector(".pv-who").textContent = `von ${p.added_by === me.id ? "dir" : nameOf(p.added_by)} · ${i + 1} von ${list.length}`;
  sh.querySelector("[data-pv=del]").hidden = !canDel;
  sh.querySelector("[data-pv=del]").textContent = "Löschen";
  sh.querySelector("[data-pv=prev]").disabled = i <= 0;
  sh.querySelector("[data-pv=next]").disabled = i >= list.length - 1;
  const img = sh.querySelector("img");
  img.src = urlCache[p.thumb]?.url || "";
  sh.hidden = false;
  await signUrls([p.path]);
  if (viewPhoto === id && urlCache[p.path]) img.src = urlCache[p.path].url;
}
function closePhoto() { viewPhoto = null; $("#photo-sheet").hidden = true; }
async function savePhoto() {
  const p = S.photos.find(x => x.id === viewPhoto); if (!p) return;
  try {
    await signUrls([p.path]);
    const blob = await (await fetch(urlCache[p.path].url)).blob();
    const name = `partykeller-${p.id}.jpg`, file = new File([blob], name, { type: "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (err) { if (err.name !== "AbortError") throw err; }
      return;
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Foto wird gespeichert");
  } catch (err) { fail(err); }
}
/* Alle Fotos eines Termins sichern.
   Schritt 1: Fotos laden. Schritt 2: erneut tippen, dann oeffnet sich das Teilen-Menue
   (das Handy erlaubt das Teilen nur direkt nach einem Tippen). */
let saveAll = { event: null, files: null };
async function prepareSaveAll(eventId) {
  const list = photosOf(eventId); if (!list.length) return;
  saveAll = { event: eventId, files: null }; renderEvents();
  try {
    if (!(await signUrls(list.map(p => p.path)))) throw new Error("Fotos konnten nicht geladen werden");
    const files = await Promise.all(list.map(async (p, i) => {
      const blob = await (await fetch(urlCache[p.path].url)).blob();
      return new File([blob], `partykeller-${eventId}-${String(i + 1).padStart(2, "0")}.jpg`, { type: "image/jpeg" });
    }));
    if (saveAll.event !== eventId) return;
    saveAll.files = files;
  } catch (err) { saveAll = { event: null, files: null }; fail(err); }
  renderEvents();
}
async function doSaveAll() {
  const files = saveAll.files; if (!files) return;
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); }
    catch (err) { if (err.name !== "AbortError") { fail(err); return; } }
  } else {
    for (const f of files) {
      const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      await new Promise(r => setTimeout(r, 400));
    }
    toast(`${files.length} Fotos werden gespeichert`);
  }
  saveAll = { event: null, files: null }; renderEvents();
}

async function deletePhoto(btn) {
  const p = S.photos.find(x => x.id === viewPhoto); if (!p) return;
  if (btn.textContent !== "Wirklich löschen?") { btn.textContent = "Wirklich löschen?"; return; }
  const { error } = await db.storage.from("fotos").remove([p.path, p.thumb]);
  if (error) return fail(error);
  closePhoto();
  run(db.from("event_photos").delete().eq("id", p.id), "Foto gelöscht");
}
$("#photo-sheet").addEventListener("click", e => {
  const b = e.target.closest("[data-pv]");
  if (!b) { if (e.target.id === "photo-sheet") closePhoto(); return; }
  const k = b.dataset.pv;
  if (k === "close") return closePhoto();
  if (k === "save") return savePhoto();
  if (k === "del") return deletePhoto(b);
  const p = S.photos.find(x => x.id === viewPhoto); if (!p) return;
  const list = photosOf(p.event_id), i = list.findIndex(x => x.id === p.id);
  const n = list[i + (k === "next" ? 1 : -1)]; if (n) openPhoto(n.id);
});
/* Wischen zum naechsten Foto */
let pvX = null;
$("#photo-sheet").addEventListener("touchstart", e => { pvX = e.touches[0].clientX; }, { passive: true });
$("#photo-sheet").addEventListener("touchend", e => {
  if (pvX === null) return; const dx = e.changedTouches[0].clientX - pvX; pvX = null;
  if (Math.abs(dx) > 50) $(`#photo-sheet [data-pv=${dx < 0 ? "next" : "prev"}]`).click();
});
/* Termin loeschen: vorher die Fotos aus dem Speicher raeumen */
async function removeEventPhotos(eventId) {
  if (!S.photosReady) return true;
  const list = photosOf(eventId); if (!list.length) return true;
  const { error } = await db.storage.from("fotos").remove(list.flatMap(p => [p.path, p.thumb]));
  if (error) { fail(error); return false; }
  return true;
}

const canDeleteSong = s => me && (s.added_by === me.id || me.is_admin);

function cleanSpotify(raw) {
  try {
    const u = new URL(raw.trim());
    if (!/(^|\.)spotify\.(com|link)$/.test(u.hostname)) return null;
    u.search = ""; u.hash = "";
    return u.href.replace(/\/intl-[a-z]+\//, "/");
  } catch { return null; }
}
async function spotifyInfo(url) {
  try {
    const r = await fetch("https://open.spotify.com/oembed?url=" + encodeURIComponent(url));
    if (!r.ok) return null;
    const j = await r.json();
    return { title: j.title || "", cover: j.thumbnail_url || "" };
  } catch { return null; }
}
document.addEventListener("submit", async e => {
  const f = e.target.closest("[data-plform]"); if (!f) return;
  e.preventDefault();
  const event_id = +f.dataset.plform, rawLink = f.link.value.trim(), typed = f.title.value.trim();
  let url = "", cover = "", title = typed;
  if (rawLink) {
    url = cleanSpotify(rawLink);
    if (!url) return toast("Das ist kein Spotify-Link. Trag den Song sonst als Titel ein.", true);
    const btn = f.querySelector("button"); btn.disabled = true; btn.textContent = "Moment …";
    const info = await spotifyInfo(url);
    btn.disabled = false; btn.textContent = "Song einreichen";
    if (info) { cover = info.cover; if (!title) title = info.title; }
  }
  if (!title) return toast("Den Songnamen konnte ich nicht lesen. Schreib noch Titel und Künstler dazu.", true);
  const ok = await run(db.from("event_songs").insert({ event_id, title: title.slice(0, 120), url, cover, added_by: me.id }), "Song ist drin");
  if (ok) { const nf = document.querySelector(`[data-plform="${event_id}"]`); if (nf) nf.reset(); }
});
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
  updateMoreBadge();
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
  $("#chat-push-row").hidden = true; $("#prost-push-row").hidden = true; $("#mem-push-row").hidden = true; $("#snap-push-row").hidden = true;
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
  $("#mem-push-row").hidden = !pushOn || !S.memReady;
  $("#snap-push-row").hidden = !pushOn || !S.snapReady;
  if (pushOn) {
    // Spalten "prost" und "memories" gibt es erst nach prost.sql bzw. memories.sql
    let data = null, error = true;
    for (const cols of ["chat,prost,memories,snaps", "chat,prost,memories", "chat,prost", "chat"]) {
      ({ data, error } = await db.from("push_subscriptions").select(cols).eq("endpoint", sub.endpoint).maybeSingle());
      if (!error) break;
    }
    $("#mem-push").checked = data ? data.memories !== false : true;
    $("#snap-push").checked = data ? data.snaps !== false : true;
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
  bier_klein: { e: "🍺", l: "Bier 0,33", ml: 330 }, bier: { e: "🍺", l: "Bier 0,5", ml: 500 }, mass: { e: "🍻", l: "Maß", ml: 1000 }, radler: { e: "🍋", l: "Radler" }, wein: { e: "🍷", l: "Wein" },
  sekt: { e: "🥂", l: "Sekt" }, longdrink: { e: "🍹", l: "Longdrink" }, cocktail: { e: "🍸", l: "Cocktail" },
  shot: { e: "🥃", l: "Shot" }, alkfrei: { e: "🧃", l: "Alkoholfrei" }, wasser: { e: "💧", l: "Wasser" }
};
// Zur Auswahl stehen nur diese. Alte Einträge (Radler, Alkoholfrei, Wasser) werden weiter angezeigt.
const HIDDEN_DRINKS = new Set(["radler", "alkfrei", "wasser"]);
const PICK_DRINKS = () => Object.entries(DRINKS).filter(([k]) => !HIDDEN_DRINKS.has(k));
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

/* Zahl am Prost-Reiter: nur Runden, die man noch nicht gesehen hat */
const prostSeen = () => +(store.get("pk-prost-seen") || 0);
function updateProstBadge() {
  const live = liveOthers();
  if (prostVisible() && live.length) store.set("pk-prost-seen", String(Math.max(prostSeen(), ...live.map(s => s.id))));
  const n = live.filter(s => s.id > prostSeen()).length;
  const badge = $("#prost-badge"); badge.hidden = !n; badge.textContent = n;
}

/* Anzeige */
function renderProst() {
  if (!me || !S.prost) return;
  $("#prost-setup").hidden = S.prostReady; $("#prost-body").hidden = !S.prostReady;
  const live = liveOthers();
  updateProstBadge();
  if (!S.prostReady) return;
  const mine = mySession();
  $("#prost-off").hidden = !!mine;
  $("#prost-mine").hidden = !mine;
  if (mine) $("#prost-mine").innerHTML = mineHTML(mine);
  $("#prost-live").innerHTML = live.length ? live.map(liveHTML).join("")
    : `<div class="empty">${mine ? "Außer dir trinkt gerade niemand." : "Gerade trinkt niemand. Mach du den Anfang."}</div>`;
  renderProstStats();
  renderProstHistory();
  renderWallDrinks();
  if (prostVisible()) renderProstMap();
}
const agoMin = iso => Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
const agoText = iso => { const m = agoMin(iso); return m < 1 ? "gerade eben" : m < 60 ? `vor ${m} Min.` : `vor ${Math.floor(m / 60)} Std.`; };
function comerLine(j) {
  const st = j.arrived_at ? `<span class="arrived">ist da</span>`
    : j.lat != null ? `unterwegs · Standort ${agoText(j.loc_at)}` : "unterwegs";
  return `<span class="comer"><b>${esc(nameOf(j.member_id))}</b> ${st}</span>`;
}
function onMyWayHTML(s, j) {
  if (j.arrived_at) return `<p class="onway done">Du bist angekommen. Prost!</p>`;
  return `<div class="onway"><p>${j.lat != null ? `Du bist unterwegs zu ${esc(nameOf(s.member_id))}. Dein Standort wird geteilt (zuletzt ${agoText(j.loc_at)}) und wandert mit, solange die App offen ist.` : `Du bist unterwegs zu ${esc(nameOf(s.member_id))}. Dein Standort wird nicht geteilt.`}</p>
    <div class="row">
      <button class="btn" type="button" data-arrive="${s.id}">Bin angekommen</button>
      ${j.lat != null ? `<button class="link" type="button" data-stoploc="${s.id}">Standort nicht mehr teilen</button>` : `<button class="link" type="button" data-startloc="${s.id}">Standort doch teilen</button>`}
    </div></div>`;
}
function mineHTML(s) {
  const ds = drinksOf(s.id), js = joinsOf(s.id);
  const coming = js.filter(j => j.kind === "coming").map(j => j.member_id), cheers = js.filter(j => j.kind === "cheers").map(j => j.member_id);
  return `<div class="pm-head"><span class="live-dot"></span><b>Deine Runde läuft</b></div>
    <p class="count">seit ${fmtTime(s.started_at)} · sichtbar bis ${fmtTime(s.ends_at)}${s.place ? " · " + esc(s.place) : ""}</p>
    <div class="pm-count"><b>${ds.length}</b><span>${ds.length === 1 ? "Getränk" : "Getränke"}${ds.length ? `<small>${esc(drinkSummary(ds))}</small>` : ""}</span></div>
    <span class="label">Noch eins? Antippen zählt mit.</span>
    <div class="drink-quick">${PICK_DRINKS().map(([k, d]) => `<button type="button" class="drink-b" data-drink="${k}" aria-label="${d.l} zählen"><span>${d.e}</span>${d.l}</button>`).join("")}</div>
    ${coming.length ? `<div class="pm-who"><b>Kommen vorbei:</b>${js.filter(j => j.kind === "coming").map(comerLine).join("")}</div>` : ""}
    ${cheers.length ? `<p class="pm-who"><b>Prost von:</b> ${esc(listNames(cheers))}</p>` : ""}
    <div class="pm-acts">
      <button class="btn ghost" type="button" data-action="prost-extend">+1 Stunde</button>
      <button class="btn" type="button" data-action="prost-end">Ich geh nach Hause</button>
    </div>
    ${ds.length ? `<button class="link" type="button" data-action="prost-undo">Letztes Getränk zurücknehmen</button>` : ""}`;
}
function liveHTML(s) {
  const ds = drinksOf(s.id), js = joinsOf(s.id), myJoin = js.find(j => j.member_id === me.id), myJ = myJoin?.kind;
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
      ${myJoin && myJoin.kind === "coming" ? onMyWayHTML(s, myJoin) : ""}
      ${coming.filter(id => id !== me.id).length ? `<p class="count live-coming">Kommen vorbei: ${esc(listNames(coming.filter(id => id !== me.id)))}</p>` : ""}
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
  const liveIds = new Set(P().sessions.filter(isLive).map(s => s.id));
  const walkers = P().joins.filter(j => liveIds.has(j.session_id) && j.kind === "coming" && !j.arrived_at && j.lat != null);
  const el = $("#prost-map"); el.hidden = !pts.length && !walkers.length;
  if (el.hidden) { pMapKey = ""; return; }
  try { await loadLeaflet(); } catch { el.hidden = true; return; }
  if (!pMap) {
    pMap = L.map(el, { zoomControl: false, scrollWheelZoom: false });
    // OpenStreetMap braucht keinen Schluessel; dunkel wird die Karte per CSS-Filter
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
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
  walkers.forEach(j => {
    const host = P().sessions.find(s => s.id === j.session_id);
    const mine = j.member_id === me.id, old = agoMin(j.loc_at) > 20;
    if (host?.lat != null) L.polyline([[j.lat, j.lng], [host.lat, host.lng]], { color: "#f2b45c", weight: 2, opacity: .7, dashArray: "6 8" }).addTo(pLayer);
    L.marker([j.lat, j.lng], { icon: L.divIcon({ className: "pin walker" + (old ? " old" : ""), html: `<span>${esc(nameOf(j.member_id)[0])}</span>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] }) })
      .bindPopup(`<b>${esc(mine ? "Du" : nameOf(j.member_id))}</b><br>unterwegs zu ${esc(host?.member_id === me.id ? "dir" : nameOf(host?.member_id))}<br>Standort ${agoText(j.loc_at)}`)
      .addTo(pLayer);
  });
  const all = [...pts.map(s => [s.lat, s.lng]), ...walkers.map(j => [j.lat, j.lng])];
  const key = [...pts.map(s => "s" + s.id), ...walkers.map(j => "j" + j.id)].sort().join("|");
  if (key !== pMapKey) { pMapKey = key; pMap.fitBounds(L.latLngBounds(all), { padding: [40, 40], maxZoom: 15 }); }
}


/* Wall of Fame: Koenig am Glas mit Podest */
const NON_ALC = new Set(["alkfrei", "wasser"]);
const beerLitres = list => list.reduce((sum, d) => sum + (DRINKS[d.kind]?.ml || 0), 0) / 1000;
const fmtL = l => l.toLocaleString("de-DE", { maximumFractionDigits: 2 }) + " l Bier";
let wallPeriod = store.get("pk-wall-period") || "month";
function renderWallDrinks() {
  $("#wsub-king-btn").hidden = !S.prostReady;
  setWallSub(wallSub);
  if (!S.prostReady) return;
  $$("#wall-period [data-wperiod]").forEach(b => b.classList.toggle("on", b.dataset.wperiod === wallPeriod));
  const from = periodStart(wallPeriod).toISOString();
  const ids = new Set(P().sessions.filter(s => s.started_at >= from).map(s => s.id));
  const per = {};
  P().drinks.filter(d => ids.has(d.session_id) && !NON_ALC.has(d.kind)).forEach(d => { const p = per[d.member_id] ||= { n: 0, list: [] }; p.n++; p.list.push(d); });
  const list = Object.entries(per).map(([id, v]) => ({ id: +id, ...v })).sort((a, b) => b.n - a.n);
  if (!list.length) { $("#wall-podium").innerHTML = `<div class="empty">In diesem Zeitraum wurde noch kein Alkohol gezählt. Der Thron ist frei.</div>`; return; }
  // Gleich viele Getraenke = gleicher Platz
  let place = 0, last = null;
  list.forEach((r, i) => { if (r.n !== last) { place = i + 1; last = r.n; } r.place = place; });
  const top = list.slice(0, 3), rest = list.slice(3), firsts = list.filter(r => r.place === 1);
  const order = [top[1], top[0], top[2]].filter(Boolean);
  const step = r => `<div class="step p${Math.min(r.place, 3)}${r.id === me.id ? " mine" : ""}">
      <div class="av">${esc(nameOf(r.id)[0])}</div>
      <b class="st-name">${esc(nameOf(r.id))}</b>
      <span class="st-n">${plural(r.n, "Getränk", "Getränke")}${beerLitres(r.list) ? `<br>${fmtL(beerLitres(r.list))}` : ""}</span>
      <div class="block"><span>${r.place}</span></div></div>`;
  $("#wall-podium").innerHTML = `<div class="podium${top.length === 1 ? " solo" : ""}">${order.map(step).join("")}</div>
    ${rest.length ? `<ol class="rest">${rest.map(r => `<li${r.id === me.id ? ' class="mine"' : ""}><span class="pos">${r.place}</span><span class="rn">${esc(nameOf(r.id))}</span><span class="count">${plural(r.n, "Getränk", "Getränke")}${beerLitres(r.list) ? " · " + fmtL(beerLitres(r.list)) : ""}</span></li>`).join("")}</ol>` : ""}
    <p class="count wall-sum">${firsts.length > 1 ? `Gleichstand auf Platz 1: ${esc(listNames(firsts.map(r => r.id)))}` : `Auf Platz 1 hat ${esc(nameOf(top[0].id))} getrunken: ${esc(drinkSummary(top[0].list))}`}</p>`;
}

/* Prost rufen */
function renderHours() { $$("#prost-hours [data-hours]").forEach(b => b.classList.toggle("on", +b.dataset.hours === prostHours)); }
function openProstSheet() {
  let last = store.get("pk-prost-kind") || "bier"; if (HIDDEN_DRINKS.has(last) || !DRINKS[last]) last = "bier";
  $("#prost-kinds").innerHTML = PICK_DRINKS().map(([k, d]) => `<label class="drink"><input type="radio" name="prost-kind" value="${k}"${k === last ? " checked" : ""}><span class="d-in"><span class="e">${d.e}</span>${d.l}</span></label>`).join("");
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
  if (a === "prost-open") { if (currentView !== "prost") showView("prost"); return openProstSheet(); }
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
function openComeSheet(sid) {
  const s = P().sessions.find(x => x.id === sid); if (!s) return;
  comeSid = sid;
  $("#come-title").textContent = `Zu ${nameOf(s.member_id)} kommen`;
  $("#come-geo").checked = store.get("pk-come-geo") !== "0";
  $("#come-sheet").hidden = false;
}
let comeSid = null;
const getPosSafe = async () => { try { const p = await getPos(); return [+p.coords.latitude.toFixed(4), +p.coords.longitude.toFixed(4)]; } catch { return null; } };
$("#come-sheet").addEventListener("click", e => { if (e.target.id === "come-sheet" || e.target.closest("[data-come-cancel]")) $("#come-sheet").hidden = true; });
$("#come-form").addEventListener("submit", async e => {
  e.preventDefault();
  const geo = $("#come-geo").checked; store.set("pk-come-geo", geo ? "1" : "0");
  const btn = $("#come-go"); btn.disabled = true;
  let pos = null;
  if (geo) { btn.textContent = "Suche Standort …"; pos = await getPosSafe(); if (!pos) toast("Standort ging nicht. Ich sag trotzdem Bescheid.", true); }
  btn.textContent = "Ich komme!";
  const ok = await run(db.rpc("answer_prost", { p_session: comeSid, p_kind: "coming", p_lat: pos?.[0] ?? null, p_lng: pos?.[1] ?? null }), "Ist Bescheid gegeben");
  btn.disabled = false;
  if (ok) $("#come-sheet").hidden = true;
});

/* Unterwegs: Standort jede Minute auffrischen, solange die App offen ist */
async function trackWalk() {
  if (!me || !S.prostReady || document.visibilityState !== "visible" || trackWalk.busy) return;
  const liveIds = new Set(P().sessions.filter(isLive).map(s => s.id));
  const mine = P().joins.filter(j => j.member_id === me.id && j.kind === "coming" && !j.arrived_at && j.lat != null && liveIds.has(j.session_id));
  if (!mine.length) return;
  trackWalk.busy = true;
  try {
    const pos = await getPosSafe(); if (!pos) return;
    for (const j of mine) if (pos[0] !== j.lat || pos[1] !== j.lng || agoMin(j.loc_at) >= 5)
      await db.rpc("update_prost_location", { p_session: j.session_id, p_lat: pos[0], p_lng: pos[1] });
  } finally { trackWalk.busy = false; }
}
setInterval(trackWalk, 60000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") setTimeout(trackWalk, 1500); });
async function walkAction(t) {
  if (t.dataset.arrive) return run(db.rpc("arrive_prost", { p_session: +t.dataset.arrive }), "Angekommen. Prost!");
  if (t.dataset.stoploc) return run(db.rpc("stop_prost_location", { p_session: +t.dataset.stoploc }), "Standort wird nicht mehr geteilt");
  if (t.dataset.startloc) {
    const pos = await getPosSafe(); if (!pos) return toast("Standort ging nicht. Erlaub ihn in den Einstellungen.", true);
    store.set("pk-come-geo", "1");
    return run(db.rpc("answer_prost", { p_session: +t.dataset.startloc, p_kind: "coming", p_lat: pos[0], p_lng: pos[1] }), "Standort wird geteilt");
  }
}

async function answerProst(sid, kind) {
  const cur = joinsOf(sid).find(j => j.member_id === me.id);
  if (cur?.kind === kind) return run(db.from("prost_joins").delete().eq("id", cur.id), "Zurückgenommen");
  if (kind === "coming") return openComeSheet(sid);
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

/* ---------- Neues: neue Funktionen der App und Wuensche-Ecke ---------- */
const NREACTS = { up: "👍", fire: "🔥", cheers: "🍻" };
const WISH_STATUS = { open: "Offen", soon: "Kommt bald", done: "Umgesetzt" };
let newsSub = "news", newsEditing = null;
async function loadNews() {
  const q = t => db.from(t).select("*");
  const [n, r, rd, w, wv] = await Promise.all([q("news"), q("news_reactions"), q("news_reads"), q("wishes"), q("wish_votes")]);
  // Tabellen gibt es erst nach neues.sql
  S.newsReady = !n.error;
  S.news = n.data || []; S.newsReacts = r.data || []; S.wishes = w.data || []; S.wishVotes = wv.data || [];
  S.newsRead = Math.max(rd.data?.[0]?.last_id || 0, +(store.get("pk-news-read") || 0));
}
const unreadNews = () => (S.news || []).filter(n => n.id > (S.newsRead || 0) && n.created_by !== me?.id).sort((a, b) => b.id - a.id);

function setNewsSub(v) {
  newsSub = v;
  $$("[data-nsub]").forEach(b => b.classList.toggle("on", b.dataset.nsub === v));
  $("#nsub-news").hidden = v !== "news"; $("#nsub-wishes").hidden = v !== "wishes";
  $("#news-plus").hidden = !(me?.is_admin && v === "news");
}
function renderNews() {
  if (!me || !S.news) return;
  $("#news-setup").hidden = S.newsReady; $("#news-body").hidden = !S.newsReady;
  const unread = unreadNews().length;
  const nb = $("#news-badge"); nb.hidden = !unread; nb.textContent = unread;
  $("#menu-neues-sub").textContent = unread ? `${unread} ${unread === 1 ? "neue Funktion" : "neue Funktionen"}` : "Neue Funktionen und Wünsche";
  if (!S.newsReady) return;
  setNewsSub(newsSub);
  const list = [...S.news].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  $("#news-list").innerHTML = list.length ? list.map(newsHTML).join("") : `<div class="empty">Noch keine Neuigkeiten.</div>`;
  renderWishes();
}
function newsHTML(n) {
  const rs = S.newsReacts.filter(r => r.news_id === n.id), my = rs.find(r => r.member_id === me.id)?.kind;
  const steps = n.steps.split("\n").map(x => x.trim()).filter(Boolean);
  const isNew = n.id > (S.newsRead || 0) || n.id > (renderNews.seenBefore ?? Infinity);
  return `<article class="news${isNew ? " unread" : ""}">
    <div class="news-head"><span class="news-date">${fmtDate(n.created_at)}</span>${isNew ? `<span class="news-new">Neu</span>` : ""}</div>
    <h3>${esc(n.title)}</h3>
    ${n.body ? `<p>${esc(n.body)}</p>` : ""}
    ${steps.length ? `<ol class="news-steps">${steps.map(x => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}
    <div class="news-reacts">${Object.entries(NREACTS).map(([k, e]) => { const c = rs.filter(r => r.kind === k).length;
      return `<button type="button" class="nr${my === k ? " on" : ""}" data-nreact="${n.id}" data-k="${k}" aria-label="Reaktion ${k}">${e}${c ? `<small>${c}</small>` : ""}</button>`; }).join("")}</div>
    ${me.is_admin ? `<div class="foot news-admin"><button class="link" type="button" data-nedit="${n.id}">Bearbeiten</button><button class="link" type="button" data-npush="${n.id}">Per Push senden</button>${delBtn("news", n.id, -1)}</div>` : ""}
  </article>`;
}
function renderWishes() {
  const votes = id => S.wishVotes.filter(v => v.wish_id === id);
  const order = { soon: 0, open: 1, done: 2 };
  S.wishes.forEach(w => { if (!WISH_STATUS[w.status]) w.status = "open"; });
  const list = [...S.wishes].sort((a, b) => order[a.status] - order[b.status] || votes(b.id).length - votes(a.id).length || b.id - a.id);
  $("#wish-list").innerHTML = list.length ? list.map(w => {
    const vs = votes(w.id), mine = vs.some(v => v.member_id === me.id);
    return `<div class="wish ${w.status}">
      <button type="button" class="wvote${mine ? " on" : ""}" data-wvote="${w.id}" aria-label="Dafür stimmen"><span>👍</span><b>${vs.length}</b></button>
      <div class="wish-txt"><p>${esc(w.text)}</p>
        <span class="count">${esc(nameOf(w.created_by))}${w.status !== "open" ? ` · <span class="wstat ${w.status}">${WISH_STATUS[w.status]}</span>` : ""}</span>
        ${me.is_admin ? `<div class="wish-admin">${Object.entries(WISH_STATUS).filter(([k]) => k !== w.status).map(([k, l]) => `<button class="link" type="button" data-wstatus="${w.id}" data-s="${k}">${l}</button>`).join("")}${delBtn("wish", w.id, w.created_by)}</div>`
          : w.created_by === me.id ? `<div class="wish-admin">${delBtn("wish", w.id, w.created_by)}</div>` : ""}
      </div></div>`;
  }).join("") : `<div class="empty">Noch keine Wünsche. Was fehlt dir in der App?</div>`;
}
/* Gelesen melden, wenn die Seite offen ist */
async function markNewsRead() {
  if (!S.newsReady || !S.news?.length) return;
  const top = Math.max(...S.news.map(n => n.id));
  if (top <= (S.newsRead || 0)) return;
  renderNews.seenBefore = S.newsRead || 0;   // "Neu" bleibt sichtbar, solange man auf der Seite ist
  S.newsRead = top; store.set("pk-news-read", String(top));
  db.rpc("mark_news_read", { p_id: top }).then(({ error }) => { if (error) console.warn(error); });
  renderNews(); renderStart();
}

/* Admin: schreiben und bearbeiten */
function openNewsSheet(n) {
  newsEditing = n?.id || null;
  $("#news-form-title").textContent = n ? "Neuigkeit bearbeiten" : "Neuigkeit schreiben";
  $("#news-title").value = n?.title || ""; $("#news-text").value = n?.body || ""; $("#news-steps").value = n?.steps || "";
  $("#news-push").checked = false; $("#news-push-row").hidden = !!n;
  $("#news-go").textContent = n ? "Speichern" : "Veröffentlichen";
  $("#news-sheet").hidden = false;
}
const closeNewsSheet = () => $("#news-sheet").hidden = true;
$("#news-sheet").addEventListener("click", e => { if (e.target.id === "news-sheet") closeNewsSheet(); });
$("#news-form").addEventListener("submit", async e => {
  e.preventDefault();
  const row = { title: $("#news-title").value.trim(), body: $("#news-text").value.trim(), steps: $("#news-steps").value.trim() };
  const ok = newsEditing
    ? await run(db.from("news").update(row).eq("id", newsEditing), "Gespeichert")
    : await run(db.from("news").insert({ ...row, push: $("#news-push").checked, created_by: me.id }), $("#news-push").checked ? "Veröffentlicht und an alle geschickt" : "Veröffentlicht");
  if (ok) closeNewsSheet();
});
$("#wish-form").addEventListener("submit", async e => {
  e.preventDefault();
  const ok = await run(db.from("wishes").insert({ text: $("#wish-text").value.trim(), created_by: me.id }), "Danke für die Idee!");
  if (ok) $("#wish-text").value = "";
});
let pendingPush = null;
async function newsAction(t) {
  if (t.dataset.nsub) return setNewsSub(t.dataset.nsub);
  if (t.dataset.action === "news-new") return openNewsSheet(null);
  if (t.dataset.action === "news-close") return closeNewsSheet();
  if (t.dataset.nedit) return openNewsSheet(S.news.find(n => n.id === +t.dataset.nedit));
  if (t.dataset.npush) {
    if (pendingPush !== t.dataset.npush) { pendingPush = t.dataset.npush; t.textContent = "Wirklich an alle?"; setTimeout(() => { pendingPush = null; if (t.isConnected) t.textContent = "Per Push senden"; }, 4000); return; }
    pendingPush = null;
    return run(db.rpc("push_news", { p_id: +t.dataset.npush }), "An alle geschickt");
  }
  if (t.dataset.nreact) {
    const news_id = +t.dataset.nreact, kind = t.dataset.k, cur = S.newsReacts.find(r => r.news_id === news_id && r.member_id === me.id);
    if (cur?.kind === kind) return run(db.from("news_reactions").delete().match({ news_id, member_id: me.id }));
    return run(db.from("news_reactions").upsert({ news_id, member_id: me.id, kind }));
  }
  if (t.dataset.wvote) {
    const wish_id = +t.dataset.wvote, mine = S.wishVotes.some(v => v.wish_id === wish_id && v.member_id === me.id);
    return mine ? run(db.from("wish_votes").delete().match({ wish_id, member_id: me.id })) : run(db.from("wish_votes").insert({ wish_id, member_id: me.id }), "Stimme gezählt");
  }
  if (t.dataset.wstatus) return run(db.from("wishes").update({ status: t.dataset.s }).eq("id", +t.dataset.wstatus), "Status geändert");
}

/* ---------- Dartzähler (läuft nur auf dem eigenen Handy, nichts in Supabase) ---------- */
const DART_KEY = "pk-darts";
let dartSetup = (() => { try { return JSON.parse(store.get("pk-darts-setup")) || {}; } catch { return {}; } })();
dartSetup = { mode: dartSetup.mode || 501, dout: dartSetup.dout ?? true, players: dartSetup.players || [] };
let dartGame = (() => { try { return JSON.parse(store.get(DART_KEY)); } catch { return null; } })();
let dartMod = 1;
const saveDartSetup = () => store.set("pk-darts-setup", JSON.stringify(dartSetup));
const saveDartGame = () => store.set(DART_KEY, dartGame ? JSON.stringify(dartGame) : "");
const dartLabel = d => d.v === 0 ? "0" : d.v === 25 ? (d.m === 2 ? "Bull" : "25") : (d.m === 3 ? "T" : d.m === 2 ? "D" : "") + d.v;

// Spielstand aus allen Würfen nachrechnen: so ist "zurück" immer genau ein Pfeil
function dartReplay(g) {
  const n = g.players.length, rem = g.players.map(() => g.mode);
  const st = g.players.map(() => ({ pts: 0, darts: 0, best: 0, busts: 0 }));
  let cur = g.start % n, turn = [], turnStart = rem[cur], winner = null, lastTurn = null;
  const next = () => { cur = (cur + 1) % n; turn = []; turnStart = rem[cur]; };
  for (const d of g.darts) {
    turn.push(d);
    const left = rem[cur] - d.v * d.m;
    const bust = left < 0 || (g.dout && left === 1) || (g.dout && left === 0 && d.m !== 2);
    if (bust) { rem[cur] = turnStart; st[cur].darts += turn.length; st[cur].busts++; lastTurn = { p: cur, darts: turn, bust: true }; next(); continue; }
    rem[cur] = left;
    if (left === 0 || turn.length === 3) {
      const sum = turnStart - left; st[cur].pts += sum; st[cur].darts += turn.length; st[cur].best = Math.max(st[cur].best, sum);
      lastTurn = { p: cur, darts: turn, sum };
      if (left === 0) { winner = cur; break; }
      next();
    }
  }
  return { rem, st, cur, turn, turnStart, winner, lastTurn };
}

// Weg zum Auschecken: möglichst wenige Pfeile, beliebte Doppel bevorzugt
const DART_ALL = (() => {
  const a = [];
  for (let v = 20; v >= 1; v--) a.push({ v, m: 3 });
  a.push({ v: 25, m: 2 }, { v: 25, m: 1 });
  for (let v = 20; v >= 1; v--) a.push({ v, m: 1 });
  for (let v = 20; v >= 1; v--) a.push({ v, m: 2 });
  return a;
})();
const DOUBLE_RANK = [20, 16, 18, 12, 10, 8, 25, 14, 6, 4, 2, 19, 17, 15, 13, 11, 9, 7, 5, 3, 1];
const checkoutCache = new Map();
function dartCheckout(score, darts, dout) {
  const key = score + "|" + darts + "|" + dout;
  if (checkoutCache.has(key)) return checkoutCache.get(key);
  let best = null, bestRank = Infinity;
  const finals = dout ? DART_ALL.filter(d => d.m === 2) : DART_ALL;
  const rank = d => dout ? DOUBLE_RANK.indexOf(d.v) : (d.m === 1 ? 0 : d.m === 2 ? 1 : 2);
  for (let k = 1; k <= darts && !best; k++) {
    const walk = (left, path) => {
      if (path.length === k - 1) {
        for (const f of finals) if (f.v * f.m === left) { const r = rank(f); if (r < bestRank) { bestRank = r; best = [...path, f]; } }
        return;
      }
      for (const d of DART_ALL) { const s = d.v * d.m; if (s < left) walk(left - s, [...path, d]); }
    };
    if (score <= 60 * k) walk(score, []);
  }
  checkoutCache.set(key, best);
  return best;
}

function renderDartSetup() {
  $$("[data-dmode]").forEach(b => b.classList.toggle("on", +b.dataset.dmode === dartSetup.mode));
  $$("[data-dout]").forEach(b => b.classList.toggle("on", (b.dataset.dout === "1") === dartSetup.dout));
  const sel = dartSetup.players;
  const pos = key => sel.findIndex(p => p.key === key);
  const members = (S.members || []).filter(m => m.user_id || m.id === me?.id);
  const guests = sel.filter(p => p.key.startsWith("g:"));
  $("#dart-pick").innerHTML = [...members.map(m => ({ key: "m" + m.id, name: m.name })), ...guests].map(p => {
    const i = pos(p.key);
    return `<button type="button" class="chip dart-chip${i >= 0 ? " on" : ""}" data-dplayer="${esc(p.key)}" data-dname="${esc(p.name)}" aria-pressed="${i >= 0}">${i >= 0 ? `<b>${i + 1}</b>` : ""}${esc(p.name)}</button>`;
  }).join("");
  $("#dart-order-hint").textContent = sel.length ? `(${sel.length} dabei, Zahl = Reihenfolge)` : "(antippen in Wurf-Reihenfolge)";
  $("[data-daction=start]").disabled = !sel.length;
}

function renderDarts() {
  if (!me) return;
  const g = dartGame;
  $("#dart-setup").hidden = !!g;
  $("#dart-game").hidden = !g;
  $("#dart-win").hidden = true;
  $("#menu-darts-sub").textContent = g ? `Spiel läuft: ${g.mode}, ${g.players.length} Spieler` : "301 und 501, Punkte zählen";
  if (!g) return renderDartSetup();
  const r = dartReplay(g);
  if (r.winner !== null) { $("#dart-game").hidden = true; return renderDartWin(g, r); }
  const avg = s => s.darts ? (s.pts / s.darts * 3).toLocaleString("de-DE", { maximumFractionDigits: 1 }) : "–";
  $("#dart-board").innerHTML = g.players.map((p, i) => `<div class="dart-p${i === r.cur ? " now" : ""}"><span class="dp-name">${esc(p.name)}</span><b>${r.rem[i]}</b><small>Schnitt ${avg(r.st[i])}</small></div>`).join("");
  const p = g.players[r.cur], left = 3 - r.turn.length, sum = r.turnStart - r.rem[r.cur];
  const co = r.rem[r.cur] <= 170 ? dartCheckout(r.rem[r.cur], left, g.dout) : null;
  const slots = [0, 1, 2].map(i => r.turn[i] ? `<span class="ds">${dartLabel(r.turn[i])}</span>` : `<span class="ds empty">${i + 1}</span>`).join("");
  const last = r.lastTurn && r.turn.length === 0 ? `<p class="dart-last">${esc(g.players[r.lastTurn.p].name)}: ${r.lastTurn.darts.map(dartLabel).join(" · ")} ${r.lastTurn.bust ? "<em>überworfen, zählt nicht</em>" : `= ${r.lastTurn.sum}`}</p>` : "";
  $("#dart-now").innerHTML = `<div class="dn-head"><span>${esc(p.name)} wirft</span><span class="count">Aufnahme ${sum}</span></div>
    <div class="dn-rest">${r.rem[r.cur]}</div>
    <div class="dn-slots">${slots}</div>
    ${co ? `<p class="dn-co">Auschecken: <b>${co.map(dartLabel).join(" · ")}</b></p>` : ""}${last}`;
  $$("[data-dmod]").forEach(b => b.classList.toggle("on", +b.dataset.dmod === dartMod));
  const nums = Array.from({ length: 20 }, (_, i) => i + 1);
  $("#dart-pad").innerHTML = nums.map(v => `<button type="button" data-dv="${v}">${dartMod === 3 ? "T" : dartMod === 2 ? "D" : ""}${v}</button>`).join("")
    + `<button type="button" data-dv="25" class="bull"${dartMod === 3 ? " disabled" : ""}>${dartMod === 2 ? "Bull" : "25"}</button><button type="button" data-dv="0" class="miss">0</button>`;
}

function renderDartWin(g, r) {
  const w = g.players[r.winner];
  const avg = s => s.darts ? (s.pts / s.darts * 3).toLocaleString("de-DE", { maximumFractionDigits: 1 }) : "–";
  const order = g.players.map((p, i) => ({ p, i })).sort((a, b) => a.i === r.winner ? -1 : b.i === r.winner ? 1 : r.rem[a.i] - r.rem[b.i]);
  const box = $("#dart-win"); box.hidden = false;
  box.innerHTML = `<p class="dw-crown">Game Shot</p><h2>${esc(w.name)} hat gewonnen</h2>
    <p class="count">Ausgecheckt mit ${r.lastTurn.darts.map(dartLabel).join(" · ")} · ${r.st[r.winner].darts} Pfeile</p>
    <ol class="dw-list">${order.map(({ p, i }) => `<li><span>${esc(p.name)}</span><span class="count">${i === r.winner ? "fertig" : r.rem[i] + " Rest"} · Schnitt ${avg(r.st[i])} · beste Aufnahme ${r.st[i].best}</span></li>`).join("")}</ol>
    <div class="dw-acts"><button class="btn" type="button" data-daction="again">Nochmal</button><button class="btn ghost" type="button" data-daction="new">Neues Spiel</button></div>
    <button class="link" type="button" data-daction="undo">Letzten Wurf zurück</button>`;
}

function dartThrow(v) {
  if (!dartGame) return;
  if (dartReplay(dartGame).winner !== null) return;
  let m = dartMod;
  if (v === 0) m = 1;
  if (v === 25 && m === 3) return;
  dartGame.darts.push({ v, m });
  dartMod = 1;
  saveDartGame(); renderDarts();
  if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
}

$("#view-darts").addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  e.stopPropagation();
  if (t.dataset.dmode) { dartSetup.mode = +t.dataset.dmode; saveDartSetup(); return renderDartSetup(); }
  if (t.dataset.dout) { dartSetup.dout = t.dataset.dout === "1"; saveDartSetup(); return renderDartSetup(); }
  if (t.dataset.dplayer) {
    const key = t.dataset.dplayer, i = dartSetup.players.findIndex(p => p.key === key);
    if (i >= 0) dartSetup.players.splice(i, 1);
    else if (dartSetup.players.length >= 8) return toast("Mehr als 8 Spieler gehen nicht.");
    else dartSetup.players.push({ key, name: t.dataset.dname });
    saveDartSetup(); return renderDartSetup();
  }
  if (t.dataset.dmod) { dartMod = dartMod === +t.dataset.dmod ? 1 : +t.dataset.dmod; return renderDarts(); }
  if (t.dataset.dv) return dartThrow(+t.dataset.dv);
  const a = t.dataset.daction;
  if (a === "start") {
    if (!dartSetup.players.length) return toast("Wähl erst aus, wer mitspielt.", true);
    dartGame = { mode: dartSetup.mode, dout: dartSetup.dout, players: dartSetup.players.map(p => ({ ...p })), start: 0, darts: [] };
    dartMod = 1; saveDartGame(); return renderDarts();
  }
  if (a === "undo") { if (dartGame?.darts.length) { dartGame.darts.pop(); saveDartGame(); renderDarts(); } return; }
  if (a === "again") { dartGame = { ...dartGame, start: (dartGame.start + 1) % dartGame.players.length, darts: [] }; dartMod = 1; saveDartGame(); return renderDarts(); }
  if (a === "new") { dartGame = null; saveDartGame(); return renderDarts(); }
  if (a === "quit") {
    if (t.dataset.sure !== "1") { t.dataset.sure = "1"; t.textContent = "Wirklich beenden? Nochmal tippen"; setTimeout(() => { t.dataset.sure = ""; t.textContent = "Spiel beenden"; }, 3000); return; }
    dartGame = null; saveDartGame(); return renderDarts();
  }
});
$("#dart-guest").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("#dart-guest-name").value.trim(); if (!name) return;
  const key = "g:" + name.toLowerCase();
  if (dartSetup.players.some(p => p.key === key)) return toast("Der ist schon dabei.");
  if (dartSetup.players.length >= 8) return toast("Mehr als 8 Spieler gehen nicht.");
  dartSetup.players.push({ key, name }); saveDartSetup();
  $("#dart-guest-name").value = ""; renderDartSetup();
});

/* ---------- Navigation: Start, Termine, Prost, Chat, Mehr ---------- */
const VIEWS = ["start", "termine", "prost", "chat", "snaps", "mehr", "neues", "gruppe", "wall", "memories", "darts", "anleitungen", "einstellungen", "admin"];
const UNDER_MORE = { neues: 1, gruppe: 1, wall: 1, memories: 1, darts: 1, anleitungen: 1, einstellungen: 1, admin: 1 };
const TITLES = { termine: "Termine", prost: "Prost", chat: "Chat", mehr: "Mehr", neues: "Neues", gruppe: "Gruppe", wall: "Wall of Fame", memories: "Memories", darts: "Dartzähler", snaps: "Snaps", anleitungen: "Anleitungen", einstellungen: "Einstellungen", admin: "Admin" };
let currentView = "start";
function updateHeader() {
  const inApp = !$("#screen-app").hidden;
  const big = !inApp || currentView === "start";
  $("#big-header").hidden = !big;
  $("#topbar").hidden = big || currentView === "chat";
  $("#topbar-title").textContent = TITLES[currentView] || "";
  $("#topbar-back").hidden = !UNDER_MORE[currentView];
}
function showView(name) {
  if (!VIEWS.includes(name)) name = "start";
  if (name === "admin" && !me?.is_admin) name = "mehr";
  const nav = UNDER_MORE[name] ? "mehr" : name;
  $$("#tabs [data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === nav));
  $$(".view").forEach(v => v.hidden = v.id !== "view-" + name);
  currentView = name;
  store.set("pk-tab", name);
  updateHeader();
  if (name === "prost") { renderProstMap(); updateProstBadge(); }
  if (name === "start" && me) renderStart();
  if (name === "neues" && me) markNewsRead();
  if (name === "memories" && me) { markMemSeen(); loadMemThumbs(); }
  if (name === "snaps" && me) refresh();
  if (name === "darts" && me) renderDarts();
  if (name === "chat") { renderChat.done = false; if (S.messages) renderChat(); renderStatus(); }
  else { window.scrollTo({ top: 0 }); closeSheet(); setTyping(false); }
  updateChatBadge();
}
function initialView() {
  const h = location.hash.slice(1);
  if (VIEWS.includes(h)) return h;
  const last = store.get("pk-tab");
  return VIEWS.includes(last) && last !== "admin" ? last : "start";
}

/* Unterreiter */
let termSub = store.get("pk-tsub") || "treffen";
function setTermSub(v) {
  termSub = v; store.set("pk-tsub", v);
  $$("[data-tsub]").forEach(b => b.classList.toggle("on", b.dataset.tsub === v));
  $("#tsub-treffen").hidden = v !== "treffen"; $("#tsub-polls").hidden = v !== "polls";
}
let wallSub = store.get("pk-wsub") || "king";
function setWallSub(v) {
  if (v === "king" && !S.prostReady) v = "quotes";
  wallSub = v; store.set("pk-wsub", v);
  $$("[data-wsub]").forEach(b => b.classList.toggle("on", b.dataset.wsub === v));
  $$("[data-wsub-panel]").forEach(p => p.hidden = p.dataset.wsubPanel !== v);
}

/* Ein Plus-Knopf: neuer Termin oder neue Abstimmung */
function setNewKind(k) {
  $$("[data-newkind]").forEach(b => b.classList.toggle("on", b.dataset.newkind === k));
  $("#event-form").hidden = k !== "event"; $("#poll-form").hidden = k !== "poll";
}
function openNew(kind) { setNewKind(kind || (termSub === "polls" ? "poll" : "event")); $("#new-sheet").hidden = false; }
const closeNew = () => $("#new-sheet").hidden = true;
$("#new-sheet").addEventListener("click", e => { if (e.target.id === "new-sheet") closeNew(); });

/* ---------- Startseite: alles auf einen Blick ---------- */
const daysUntil = iso => Math.round((new Date(iso + "T12:00") - new Date(today() + "T12:00")) / 864e5);
const countdown = n => n === 0 ? "Heute" : n === 1 ? "Morgen" : `in ${n} Tagen`;
function startBlock(label, tab, body, cls = "", extra = "") {
  return `<section class="sblock ${cls}"><button type="button" class="shead" data-tab="${tab}" ${extra}><span>${label}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>${body}</section>`;
}
function renderStart() {
  if (!me || !S.members) return;
  const hour = new Date().getHours();
  const hello = hour < 11 ? "Moin" : hour < 18 ? "Hey" : "Guten Abend";
  let html = `<p class="hello">${hello}, <b>${esc(me.name)}</b></p>`;
  html += startBirthday();

  // Neu in der App (solange ungelesen)
  const fresh = S.newsReady ? unreadNews() : [];
  if (fresh.length) {
    const n = fresh[0];
    html += startBlock("Neu in der App", "neues", `<button type="button" class="s-news" data-tab="neues"><b>${esc(n.title)}</b>${n.body ? `<span>${esc(n.body.slice(0, 110))}${n.body.length > 110 ? " …" : ""}</span>` : ""}${fresh.length > 1 ? `<small>und ${fresh.length - 1} ${fresh.length === 2 ? "weitere Neuigkeit" : "weitere Neuigkeiten"}</small>` : ""}</button>`, "s-newsblock");
  }

  html += startSnaps();
  html += startMemory();

  // Naechstes Treffen
  const next = [...S.events].filter(e => e.day >= today()).sort((a, b) => a.day.localeCompare(b.day))[0];
  if (next) {
    const rs = S.rsvps.filter(r => r.event_id === next.id), yes = rs.filter(r => r.status === "yes").length;
    const mine = rs.find(r => r.member_id === me.id)?.status, n = daysUntil(next.day);
    html += startBlock("Nächstes Treffen", "termine", `<div class="s-event">
      <div class="s-count"><b>${countdown(n)}</b><small>${fmtDate(next.day + "T12:00")}</small></div>
      <div class="s-ev-txt"><h3>${esc(next.title)}</h3>${next.info ? `<p class="count">${esc(next.info)}</p>` : ""}<p class="count">${yes} ${yes === 1 ? "kommt" : "kommen"}</p></div></div>
      <div class="rsvp"><button class="chip${mine === "yes" ? " on" : ""}" data-rsvp="${next.id}" data-s="yes">Bin dabei</button><button class="chip${mine === "no" ? " on" : ""}" data-rsvp="${next.id}" data-s="no">Kann nicht</button></div>`, "s-next");
  } else {
    html += startBlock("Nächstes Treffen", "termine", `<p class="muted s-empty">Noch nichts geplant.</p><button class="btn ghost" type="button" data-action="start-new-event">Treffen planen</button>`);
  }

  // Gerade unterwegs
  if (S.prostReady) {
    const live = P().sessions.filter(isLive).sort((a, b) => b.started_at.localeCompare(a.started_at));
    const body = live.length
      ? `<ul class="s-live">${live.map(s => { const ds = drinksOf(s.id), last = ds[ds.length - 1];
          return `<li><span class="av">${esc(nameOf(s.member_id)[0])}</span><span><span class="s-name"><b>${esc(s.member_id === me.id ? "Du" : nameOf(s.member_id))}</b> ${last ? DRINKS[last.kind]?.e || "" : ""}</span><small>${plural(ds.length, "Getränk", "Getränke")}${s.place ? " · " + esc(s.place) : ""}</small></span></li>`; }).join("")}</ul>`
      : `<p class="muted s-empty">Gerade trinkt niemand.</p>`;
    html += startBlock("Gerade am Trinken", "prost", body + (mySession() ? "" : `<button class="btn s-prost" type="button" data-action="prost-open">Prost rufen</button>`), live.length ? "s-hot" : "");
  }

  // Abstimmung: zuerst eine, bei der ich noch nicht abgestimmt habe
  const polls = [...S.polls].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const poll = polls.find(p => !S.pvotes.some(v => v.poll_id === p.id && v.member_id === me.id)) || polls[0];
  if (poll) {
    const opts = S.options.filter(o => o.poll_id === poll.id).sort((a, b) => a.id - b.id);
    const votes = S.pvotes.filter(v => v.poll_id === poll.id), total = votes.length, mine = votes.find(v => v.member_id === me.id)?.option_id;
    html += startBlock(mine ? "Abstimmung" : "Abstimmung · du fehlst noch", "termine", `<h3 class="s-q">${esc(poll.question)}</h3>
      ${opts.map(o => { const n = votes.filter(v => v.option_id === o.id).length;
        return `<button class="opt${mine === o.id ? " mine" : ""}" data-vote="${poll.id}" data-o="${o.id}"><div class="bar" style="width:${total ? Math.round(n / total * 100) : 0}%"></div><span>${esc(o.label)}</span><span class="n">${n}</span></button>`; }).join("")}`, "s-poll", 'data-tsubgo="polls"');
  }

  // Chat
  const seen = seenId();
  const unread = (S.messages || []).filter(m => m.id > seen && m.member_id !== me.id).length;
  const lastMsg = (S.messages || [])[S.messages.length - 1];
  html += startBlock(unread ? `Chat · ${unread} neu` : "Chat", "chat", lastMsg
    ? `<button type="button" class="s-msg" data-tab="chat"><b>${esc(lastMsg.member_id === me.id ? "Du" : nameOf(lastMsg.member_id))}${lastMsg.whisper_to ? " (geflüstert)" : ""}:</b> ${esc(lastMsg.text.slice(0, 90))}${lastMsg.text.length > 90 ? " …" : ""}<small>${dayLabel(lastMsg.created_at)}, ${fmtTime(lastMsg.created_at)}</small></button>`
    : `<p class="muted s-empty">Noch keine Nachrichten.</p>`, unread ? "s-unread" : "");

  // Zitat des Tages
  if (S.quotes.length) {
    const qs = [...S.quotes].sort((a, b) => a.id - b.id);
    const q = qs[Math.floor(Date.now() / 864e5) % qs.length];
    html += startBlock("Zitat des Tages", "wall", `<figure class="quote s-quote"><p>${esc(q.text)}</p><footer><b>${esc(nameOf(q.said_by))}</b></footer></figure>`, "", 'data-wsubgo="quotes"');
  }
  $("#start").innerHTML = html;
}

/* ---------- Aktionen ---------- */
const pendingDelete = new Set();
document.addEventListener("click", async e => {
  const t = e.target.closest("button, [data-tab]"); if (!t || t.closest("#chat-list, #msg-sheet, #chat-form")) return;
  if (t.dataset.tab) {
    if (t.dataset.tsubgo) setTermSub(t.dataset.tsubgo);
    if (t.dataset.wsubgo) setWallSub(t.dataset.wsubgo);
    return showView(t.dataset.tab);
  }
  const a = t.dataset.action;
  if (t.dataset.tsub) return setTermSub(t.dataset.tsub);
  if (t.dataset.nsub || t.dataset.nedit || t.dataset.npush || t.dataset.nreact || t.dataset.wvote || t.dataset.wstatus || a === "news-new" || a === "news-close") return newsAction(t);
  if (t.dataset.wsub) return setWallSub(t.dataset.wsub);
  if (t.dataset.newkind) return setNewKind(t.dataset.newkind);
  if (a === "new-open") return openNew();
  if (a === "new-close") return closeNew();
  if (a === "start-new-event") { showView("termine"); setTermSub("treffen"); return openNew("event"); }
  if (a === "logout") return logout();
  if (a === "bday-clear") return run(db.rpc("set_my_birthday", { p_day: null, p_month: null, p_year: null }), "Geburtstag entfernt");
  if (a === "bday-chat") return congratulate(+t.dataset.id);
  if (t.dataset.mem) return openMem(+t.dataset.mem);
  if (a === "mem-cancel") return resetMemForm();
  if (a === "snap-cancel") return closeCompose();
  if (t.dataset.snapopen) return openSnap(+t.dataset.snapopen);
  if (t.dataset.snapto) return toggleSnapTo(t.dataset.snapto);
  if (a === "push-toggle") return togglePush();
  if (a === "recheck") return boot();
  if (a && a.startsWith("prost-")) return prostAction(a);
  if (t.dataset.hours) { prostHours = +t.dataset.hours; store.set("pk-prost-hours", prostHours); return renderHours(); }
  if (t.dataset.period) { prostPeriod = t.dataset.period; store.set("pk-prost-period", prostPeriod); return renderProstStats(); }
  if (t.dataset.wperiod) { wallPeriod = t.dataset.wperiod; store.set("pk-wall-period", wallPeriod); return renderWallDrinks(); }
  if (t.dataset.drink) return addDrink(t.dataset.drink);
  if (t.dataset.join) return answerProst(+t.dataset.join, t.dataset.k);
  if (t.dataset.arrive || t.dataset.stoploc || t.dataset.startloc) return walkAction(t);
  if (a === "hide-install") { store.set("pk-install-hidden", "1"); $("#install-card").hidden = true; return; }
  if (a === "add-opt") {
    const n = $$(".poll-opt").length; if (n >= 6) return toast("Mehr als 6 Antworten gehen nicht.");
    $("#poll-opts").insertAdjacentHTML("beforeend", `<input class="poll-opt" id="poll-opt-${n + 1}" maxlength="60" placeholder="Antwort ${n + 1}" aria-label="Antwort ${n + 1}">`);
    return;
  }
  if (t.dataset.ph) { const id = +t.dataset.ph; if (openPhotos.has(id)) openPhotos.delete(id); else { openPhotos.add(id); loadThumbs(id); } return renderEvents(); }
  if (t.dataset.photo) return openPhoto(+t.dataset.photo);
  if (t.dataset.phall) { const id = +t.dataset.phall; return saveAll.event === id && saveAll.files ? doSaveAll() : prepareSaveAll(id); }
  if (t.dataset.pl) { const id = +t.dataset.pl; openLists.has(id) ? openLists.delete(id) : openLists.add(id); return renderEvents(); }
  if (t.dataset.songvote) {
    const song_id = +t.dataset.songvote;
    if (S.songVotes.some(v => v.song_id === song_id && v.member_id === me.id)) return run(db.from("song_votes").delete().match({ song_id, member_id: me.id }));
    return run(db.from("song_votes").insert({ song_id, member_id: me.id }));
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
    const table = { event: "events", poll: "polls", quote: "quotes", rank: "rankings", msg: "messages", prost: "prost_sessions", news: "news", wish: "wishes", song: "event_songs" }[t.dataset.del];
    if (t.dataset.del === "event" && !(await removeEventPhotos(+t.dataset.id))) return;
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
  if (ok) { e.target.reset(); closeNew(); setTermSub("treffen"); }
});

$("#poll-form").addEventListener("submit", async e => {
  e.preventDefault();
  const labels = $$(".poll-opt").map(i => i.value.trim()).filter(Boolean);
  if (labels.length < 2) return toast("Es braucht mindestens 2 Antworten.", true);
  const { data, error } = await db.from("polls").insert({ question: $("#poll-q").value.trim(), created_by: me.id }).select("id").single();
  if (error) return fail(error);
  const ok = await run(db.from("poll_options").insert(labels.map(label => ({ poll_id: data.id, label }))), "Abstimmung gestartet");
  if (ok) { e.target.reset(); $$(".poll-opt").slice(2).forEach(i => i.remove()); closeNew(); setTermSub("polls"); }
});

$("#quote-form").addEventListener("submit", async e => {
  e.preventDefault();
  const ok = await run(db.from("quotes").insert({ text: $("#quote-text").value.trim(), said_by: +$("#quote-who").value, created_by: me.id }), "Hängt an der Wand");
  if (ok) { $("#quote-text").value = ""; $("#new-quote").open = false; }
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

setTermSub(termSub);

/* Antippen einer Benachrichtigung bei offener App: passenden Bereich zeigen */
window.addEventListener("hashchange", () => {
  const h = location.hash.slice(1);
  if (VIEWS.includes(h) && !$("#screen-app").hidden) showView(h);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
db.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") show("login"); });
boot();

/* ---------- Geburtstage ---------- */
// Naechster Geburtstag ab heute (29.02. wird in normalen Jahren am 28.02. gefeiert)
const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
function nextBirthday(m) {
  const t = today(), y0 = +t.slice(0, 4);
  for (const y of [y0, y0 + 1]) {
    const d = m.bday_month === 2 && m.bday_day === 29 && !isLeap(y) ? 28 : m.bday_day;
    const iso = `${y}-${String(m.bday_month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (iso >= t) return { iso, days: daysUntil(iso), age: m.bday_year ? y - m.bday_year : null };
  }
}
const withBirthday = () => S.members.filter(m => m.bday_day && m.bday_month)
  .map(m => ({ m, ...nextBirthday(m) })).sort((a, b) => a.days - b.days || a.m.name.localeCompare(b.m.name));

function fillDaySelects(daySel, monSel) {
  if (daySel.options.length) return;
  daySel.innerHTML = `<option value="">Tag</option>` + Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}.</option>`).join("");
  const LONG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  monSel.innerHTML = `<option value="">Monat</option>` + LONG.map((n, i) => `<option value="${i + 1}">${n}</option>`).join("");
}

function renderBirthdays() {
  const ready = !!S.bdayReady;
  $("#bday-section").hidden = !ready;
  $("#bday-form").hidden = !ready;
  $("#admin-bday").hidden = !ready || !me?.is_admin;
  if (!ready) return;

  // Liste unter Gruppe
  const list = withBirthday(), missing = S.members.length - list.length;
  $("#bday-lead").textContent = list.length
    ? `Der Nächste zuerst.${missing ? ` ${missing} ${missing === 1 ? "fehlt" : "fehlen"} noch, eintragen unter Einstellungen.` : ""}`
    : "Noch hat niemand seinen Geburtstag eingetragen. Das geht unter Mehr und Einstellungen.";
  $("#bdays").innerHTML = list.map(({ m, iso, days, age }) => `<li class="bday${days === 0 ? " today" : days <= 7 ? " soon" : ""}${m.id === me.id ? " mine" : ""}">
    <span class="bd-date"><b>${+iso.slice(8)}.</b><small>${MON[+iso.slice(5, 7) - 1]}</small></span>
    <span class="bd-txt"><strong>${esc(m.name)}</strong><small>${age ? `wird ${age}` : "Geburtstag"}</small></span>
    <span class="bd-count">${countdown(days)}</span></li>`).join("");

  // Eigener Geburtstag in den Einstellungen
  fillDaySelects($("#bday-day"), $("#bday-month"));
  const f = $("#bday-form");
  if (!f.contains(document.activeElement)) {
    $("#bday-day").value = me.bday_day || ""; $("#bday-month").value = me.bday_month || ""; $("#bday-year").value = me.bday_year || "";
  }
  $("#bday-clear").hidden = !me.bday_day;

  // Admin: fuer andere eintragen
  if (me.is_admin) {
    fillDaySelects($("#abday-day"), $("#abday-month"));
    const sel = $("#abday-member"), keep = sel.value;
    sel.innerHTML = `<option value="">Mitglied wählen …</option>` + [...S.members].sort((a, b) => a.name.localeCompare(b.name))
      .map(m => `<option value="${m.id}">${esc(m.name)}${m.bday_day ? ` · ${m.bday_day}. ${MON[m.bday_month - 1]}` : ""}</option>`).join("");
    sel.value = keep;
  }
}

// Startseite: heute Geburtstag oder bald (7 Tage)
function startBirthday() {
  if (!S.bdayReady) return "";
  const list = withBirthday(), now = list.filter(b => b.days === 0), soon = list.filter(b => b.days > 0 && b.days <= 7);
  let html = "";
  const mineToday = now.find(b => b.m.id === me.id);
  if (mineToday) {
    html += `<section class="sblock s-bday s-bday-me"><p class="bd-big">Alles Gute zum Geburtstag, ${esc(me.name)}!</p><p class="muted">${mineToday.age ? `Herzlichen Glückwunsch zum ${mineToday.age}. ` : ""}Die ganze Partykeller Gruppe stößt auf dich an.</p></section>`;
  }
  const others = now.filter(b => b.m.id !== me.id);
  if (others.length) {
    html += startBlock("Heute Geburtstag", "gruppe", others.map(({ m, age }) => `<div class="s-bday-row">
      <span class="av">${esc(m.name[0])}</span><span class="bd-txt"><b>${esc(m.name)}</b><small>${age ? `wird heute ${age}` : "hat heute Geburtstag"}</small></span>
      <button class="btn" type="button" data-action="bday-chat" data-id="${m.id}">Gratulieren</button></div>`).join(""), "s-bday");
  }
  if (soon.length) {
    html += startBlock("Bald Geburtstag", "gruppe", `<ul class="s-bday-soon">${soon.map(({ m, days, age }) =>
      `<li><b>${esc(m.id === me.id ? "Du" : m.name)}</b><span>${countdown(days)}${age ? ` · wird ${age}` : ""}</span></li>`).join("")}</ul>`);
  }
  return html;
}

// Im Chat gratulieren: Chat oeffnen und Glueckwunsch vorschreiben
function congratulate(id) {
  const m = S.members.find(x => x.id === id); if (!m) return;
  showView("chat");
  const inp = $("#chat-input");
  inp.value = `@${m.name} Alles Gute zum Geburtstag! `;
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }, 50);
}

function readBday(dayEl, monEl, yearEl) {
  const d = +dayEl.value || null, mo = +monEl.value || null, y = +yearEl.value || null;
  if (!d || !mo) { toast("Bitte Tag und Monat wählen", true); return null; }
  if (y && (y < 1940 || y > 2030)) { toast("Das Jahr sieht nicht richtig aus", true); return null; }
  return { p_day: d, p_month: mo, p_year: y };
}
$("#bday-form").addEventListener("submit", e => {
  e.preventDefault(); document.activeElement?.blur();
  const v = readBday($("#bday-day"), $("#bday-month"), $("#bday-year")); if (!v) return;
  run(db.rpc("set_my_birthday", v), "Geburtstag gespeichert");
});
$("#admin-bday-form").addEventListener("submit", async e => {
  e.preventDefault(); document.activeElement?.blur();
  const target = +$("#abday-member").value; if (!target) return toast("Bitte ein Mitglied wählen", true);
  const v = readBday($("#abday-day"), $("#abday-month"), $("#abday-year")); if (!v) return;
  if (await run(db.rpc("set_member_birthday", { target_member: target, ...v }), `Geburtstag für ${nameOf(target)} gespeichert`)) {
    $("#abday-member").value = ""; $("#abday-day").value = ""; $("#abday-month").value = ""; $("#abday-year").value = "";
  }
});

/* ---------- Memories (Polaroid-Wand) ---------- */
const MEM_DAYS = 60, MAX_PINS = 3;
const MEM_REACTS = { love: "Herz", lol: "Lachen", cheers: "Prost" };
const MEM_ICONS = {
  love: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.6 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/></svg>',
  lol: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8 13.5c1 2 2.4 3 4 3s3-1 4-3z"/><path d="M8.5 9.8l1.5-.8M15.5 9.8l-1.5-.8"/></svg>',
  cheers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h7v9a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 5 15z"/><path d="M12 8.5h1.5a1.8 1.8 0 0 1 1.8 1.8v1.6a1.8 1.8 0 0 1-1.8 1.8H12"/><path d="M8.5 16.5V20M6 20h5"/><path d="M17.5 4.5l1-1.5M19.5 7l1.6-.6M16 3.5l-.2-1.6"/></svg>',
};
async function loadMemories() {
  const [m, r] = await Promise.all([
    db.from("memories").select("*").order("created_at", { ascending: false }),
    db.from("memory_reactions").select("*"),
  ]);
  // Tabellen gibt es erst nach memories.sql
  S.memReady = !m.error;
  S.memories = m.data || []; S.memReacts = r.data || [];
}
// Reihenfolge an der Wand und beim Durchwischen: angepinnte zuerst, dann neueste
const memList = () => [...(S.memories || [])].sort((a, b) => (b.pinned - a.pinned) || b.created_at.localeCompare(a.created_at));
function memLeft(m) {
  const until = new Date(m.created_at).getTime() + MEM_DAYS * 864e5;
  return Math.ceil((until - Date.now()) / 864e5);
}
function memLeftText(m) {
  if (m.pinned) return "angepinnt, bleibt";
  const n = memLeft(m);
  if (n <= 0) return "wird heute Nacht gelöscht";
  if (n === 1) return "noch 1 Tag";
  return `noch ${n} Tage`;
}
const memTilt = id => ((id * 37) % 7 - 3) * 0.9;
const memReactsOf = id => (S.memReacts || []).filter(r => r.memory_id === id);
const memSeen = () => +(store.get("pk-mem-seen") || 0);
function markMemSeen() {
  const top = Math.max(0, ...(S.memories || []).map(m => m.id));
  if (top > memSeen()) store.set("pk-mem-seen", String(top));
  updateMemBadge();
}
function updateMemBadge() {
  const n = (S.memories || []).filter(m => m.id > memSeen() && m.added_by !== me?.id).length;
  const b = $("#mem-badge"); b.hidden = !n; b.textContent = n;
  updateMoreBadge();
}
const newMemCount = () => (S.memories || []).filter(m => m.id > memSeen() && m.added_by !== me?.id).length;
function updateMoreBadge() {
  const n = (S.requests?.length || 0) + newMemCount();
  const more = $("#more-badge"); more.hidden = !n; more.textContent = n;
}

function polaroidHTML(m) {
  const u = urlCache[m.thumb]?.url, left = memLeft(m), rs = memReactsOf(m.id).length;
  const warn = !m.pinned && left <= 7;
  return `<button type="button" class="polaroid${m.pinned ? " pinned" : ""}" data-mem="${m.id}" style="--tilt:${memTilt(m.id)}deg" aria-label="${esc(m.caption || "Memory")} ansehen">
    ${m.pinned ? '<span class="tack" aria-hidden="true"></span>' : ""}
    <span class="pol-img">${u ? `<img src="${esc(u)}" alt="" loading="lazy">` : ""}</span>
    <span class="pol-cap">${esc(m.caption || " ")}</span>
    <span class="pol-meta"><span class="pol-left${warn ? " warn" : ""}">${memLeftText(m)}</span>${rs ? `<span class="pol-rs">${rs}</span>` : ""}</span>
  </button>`;
}

function renderMemories() {
  const ready = !!S.memReady;
  $("#menu-memories").hidden = false;
  $("#mem-setup").hidden = ready;
  $("#mem-upload").hidden = !ready || !me?.is_admin;
  if (!ready) { $("#mem-lead").textContent = ""; $("#mem-wall").innerHTML = ""; $("#mem-pinned-wrap").hidden = true; return; }
  const all = memList(), pinned = all.filter(m => m.pinned), rest = all.filter(m => !m.pinned);
  $("#menu-memories-sub").textContent = all.length ? `${all.length} ${all.length === 1 ? "Bild" : "Bilder"} an der Kellerwand` : "Bilder an der Kellerwand";
  $("#mem-lead").textContent = all.length
    ? "Jedes Bild bleibt 2 Monate hängen und löscht sich dann von selbst. Speichern lohnt sich."
    : me?.is_admin ? "Noch hängt nichts an der Wand. Wähl oben die ersten Fotos aus." : "Noch hängt nichts an der Wand. Die Admins hängen hier eure besten Momente auf.";
  $("#mem-pinned-wrap").hidden = !pinned.length;
  $("#mem-pinned").innerHTML = pinned.map(polaroidHTML).join("");
  $("#mem-wall").innerHTML = rest.map(polaroidHTML).join("");
  // Termin-Auswahl beim Hochladen
  const sel = $("#mem-event");
  if (me?.is_admin && document.activeElement !== sel) {
    const keep = sel.value;
    const evs = [...S.events].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 30);
    sel.innerHTML = `<option value="">Kein Termin (freiwillig)</option>` + evs.map(e => `<option value="${e.id}">${esc(e.title)} · ${fmtDate(e.day + "T12:00")}</option>`).join("");
    sel.value = keep;
  }
  updateMemBadge();
  if (viewMem) fillMemSheet();
  if (currentView === "memories") loadMemThumbs();
}

let memThumbsBusy = false;
async function loadMemThumbs() {
  const list = S.memories || [];
  if (!list.length || memThumbsBusy || !list.some(m => !(urlCache[m.thumb]?.until > Date.now()))) return;
  memThumbsBusy = true;
  const ok = await signUrls(list.map(m => m.thumb), "memories");
  memThumbsBusy = false;
  if (ok) { renderMemories(); if (currentView === "start") renderStart(); }
}

// Startseite: neueste Memory, solange sie juenger als 3 Tage ist
function startMemory() {
  if (!S.memReady) return "";
  const fresh = (S.memories || []).filter(m => Date.now() - new Date(m.created_at).getTime() < 3 * 864e5);
  if (!fresh.length) return "";
  const m = fresh[0], u = urlCache[m.thumb]?.url;
  if (!u) setTimeout(loadMemThumbs, 0);
  return startBlock(fresh.length > 1 ? `Neu an der Wand · ${fresh.length} Bilder` : "Neu an der Wand", "memories",
    `<button type="button" class="s-mem" data-mem="${m.id}"><span class="s-mem-img">${u ? `<img src="${esc(u)}" alt="">` : ""}</span><span class="s-mem-txt"><b>${esc(m.caption || "Neue Memory")}</b><small>von ${esc(m.added_by === me.id ? "dir" : nameOf(m.added_by))} · ${memLeftText(m)}</small></span></button>`, "s-memblock");
}

/* Hochladen (nur Admins), mehrere Fotos auf einmal */
let memFiles = [];
function resetMemForm() {
  memFiles = []; $("#mem-files").value = ""; $("#mem-caption").value = ""; $("#mem-event").value = "";
  $("#mem-form").hidden = true; $(".mem-pick").hidden = false;
}
$("#mem-files").addEventListener("change", e => {
  memFiles = [...e.target.files].filter(f => f.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
  if (!memFiles.length) return resetMemForm();
  $("#mem-picked").textContent = memFiles.length === 1 ? "1 Foto ausgewählt" : `${memFiles.length} Fotos ausgewählt`;
  $("#mem-form").hidden = false; $(".mem-pick").hidden = true;
});
$("#mem-form").addEventListener("submit", async e => {
  e.preventDefault(); if (!memFiles.length) return;
  const btn = $("#mem-send"); btn.disabled = true;
  const caption = $("#mem-caption").value.trim(), eventId = +$("#mem-event").value || null;
  const batch = rid(), st = db.storage.from("memories");
  let firstId = null, ok = 0;
  for (const [i, f] of memFiles.entries()) {
    toast(`Lade Bild ${i + 1} von ${memFiles.length} hoch …`);
    try {
      const [big, small] = await Promise.all([shrink(f, 1600, 0.8), shrink(f, 500, 0.72)]);
      const id = rid(), path = `${batch}/${id}.jpg`, thumb = `${batch}/${id}_t.jpg`;
      let r = await st.upload(path, big, { contentType: "image/jpeg" }); if (r.error) throw r.error;
      r = await st.upload(thumb, small, { contentType: "image/jpeg" }); if (r.error) { await st.remove([path]); throw r.error; }
      r = await db.from("memories").insert({ path, thumb, caption, event_id: eventId, batch, added_by: me.id }).select("id").single();
      if (r.error) { await st.remove([path, thumb]); throw r.error; }
      if (!firstId) firstId = r.data.id;
      ok++;
    } catch (err) { fail(err); }
  }
  btn.disabled = false;
  if (firstId) db.rpc("push_memories", { p_id: firstId }).then(({ error }) => { if (error) console.warn(error); });
  resetMemForm();
  await refresh();
  markMemSeen(); loadMemThumbs();
  if (ok) toast(ok === 1 ? "Bild hängt an der Wand" : `${ok} Bilder hängen an der Wand`);
});

/* Bild gross ansehen */
let viewMem = null;
async function openMem(id) {
  const m = (S.memories || []).find(x => x.id === id); if (!m) return;
  viewMem = id;
  const sh = $("#mem-sheet");
  sh.querySelector("img").src = urlCache[m.thumb]?.url || "";
  sh.querySelector(".mv-edit").hidden = true;
  sh.querySelector("[data-mv=del]").textContent = "Löschen";
  fillMemSheet();
  sh.hidden = false;
  await signUrls([m.path], "memories");
  if (viewMem === id && urlCache[m.path]) sh.querySelector("img").src = urlCache[m.path].url;
}
function fillMemSheet() {
  const m = (S.memories || []).find(x => x.id === viewMem);
  if (!m) return closeMem();
  const sh = $("#mem-sheet"), list = memList(), i = list.findIndex(x => x.id === m.id);
  const ev = m.event_id && S.events.find(e => e.id === m.event_id);
  sh.querySelector(".mv-who").textContent = `${fmtDate(m.created_at)} · von ${m.added_by === me.id ? "dir" : nameOf(m.added_by)} · ${i + 1} von ${list.length}`;
  sh.querySelector(".mv-cap").innerHTML = esc(m.caption) + (ev && ev.title !== m.caption ? `<small>${esc(ev.title)}</small>` : "");
  const left = sh.querySelector(".mv-left");
  left.textContent = m.pinned ? "Angepinnt, löscht sich nicht" : memLeft(m) <= 0 ? "Wird heute Nacht gelöscht, jetzt speichern" : `Löscht sich in ${memLeft(m) === 1 ? "1 Tag" : memLeft(m) + " Tagen"}`;
  left.classList.toggle("warn", !m.pinned && memLeft(m) <= 7);
  const rs = memReactsOf(m.id), mine = rs.find(r => r.member_id === me.id)?.kind;
  sh.querySelector(".mv-reacts").innerHTML = Object.keys(MEM_REACTS).map(k => {
    const n = rs.filter(r => r.kind === k).length, who = rs.filter(r => r.kind === k).map(r => nameOf(r.member_id)).join(", ");
    return `<button type="button" class="chip mv-r${mine === k ? " on" : ""}" data-mv="react" data-k="${k}" aria-label="${MEM_REACTS[k]}${who ? ": " + esc(who) : ""}" title="${esc(who)}">${MEM_ICONS[k]}<span>${n || ""}</span></button>`;
  }).join("");
  sh.querySelector("[data-mv=prev]").disabled = i <= 0;
  sh.querySelector("[data-mv=next]").disabled = i >= list.length - 1;
  sh.querySelector(".mv-admin").hidden = !me?.is_admin;
  sh.querySelector("[data-mv=pin]").textContent = m.pinned ? "Abpinnen" : "Anpinnen";
}
function closeMem() { viewMem = null; $("#mem-sheet").hidden = true; }
async function saveMem() {
  const m = (S.memories || []).find(x => x.id === viewMem); if (!m) return;
  try {
    await signUrls([m.path], "memories");
    const blob = await (await fetch(urlCache[m.path].url)).blob();
    const name = `partykeller-memory-${m.id}.jpg`, file = new File([blob], name, { type: "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (err) { if (err.name !== "AbortError") throw err; }
      return;
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Bild wird gespeichert");
  } catch (err) { fail(err); }
}
async function reactMem(kind) {
  const m = viewMem; if (!m) return;
  const mine = memReactsOf(m).find(r => r.member_id === me.id);
  const q = mine?.kind === kind
    ? db.from("memory_reactions").delete().eq("memory_id", m).eq("member_id", me.id)
    : db.from("memory_reactions").upsert({ memory_id: m, member_id: me.id, kind });
  await run(q);
}
async function pinMem() {
  const m = (S.memories || []).find(x => x.id === viewMem); if (!m) return;
  if (!m.pinned && S.memories.filter(x => x.pinned).length >= MAX_PINS) return toast(`Es sind schon ${MAX_PINS} Bilder angepinnt. Nimm erst eins ab.`, true);
  await run(db.from("memories").update({ pinned: !m.pinned }).eq("id", m.id), m.pinned ? "Abgepinnt, löscht sich jetzt nach 2 Monaten" : "Angepinnt, bleibt für immer");
}
async function deleteMem(btn) {
  const m = (S.memories || []).find(x => x.id === viewMem); if (!m) return;
  if (btn.textContent !== "Wirklich löschen?") { btn.textContent = "Wirklich löschen?"; return; }
  const { error } = await db.storage.from("memories").remove([m.path, m.thumb]);
  if (error) return fail(error);
  closeMem();
  run(db.from("memories").delete().eq("id", m.id), "Bild gelöscht");
}
$("#mem-sheet").addEventListener("click", e => {
  const b = e.target.closest("[data-mv]");
  if (!b) { if (e.target.id === "mem-sheet") closeMem(); return; }
  const k = b.dataset.mv;
  if (k === "close") return closeMem();
  if (k === "save") return saveMem();
  if (k === "react") return reactMem(b.dataset.k);
  if (k === "pin") return pinMem();
  if (k === "del") return deleteMem(b);
  if (k === "edit") {
    const f = $("#mem-sheet .mv-edit"), m = S.memories.find(x => x.id === viewMem);
    f.hidden = !f.hidden; if (!f.hidden) { f.querySelector("input").value = m?.caption || ""; f.querySelector("input").focus(); }
    return;
  }
  const list = memList(), i = list.findIndex(x => x.id === viewMem);
  const n = list[i + (k === "next" ? 1 : -1)]; if (n) openMem(n.id);
});
$("#mem-sheet .mv-edit").addEventListener("submit", async e => {
  e.preventDefault();
  const id = viewMem, text = e.target.querySelector("input").value.trim().slice(0, 120);
  e.target.hidden = true;
  await run(db.from("memories").update({ caption: text }).eq("id", id), "Text gespeichert");
});
let mvX = null;
$("#mem-sheet").addEventListener("touchstart", e => { mvX = e.touches[0].clientX; }, { passive: true });
$("#mem-sheet").addEventListener("touchend", e => {
  if (mvX === null) return; const dx = e.changedTouches[0].clientX - mvX; mvX = null;
  if (Math.abs(dx) > 50) $(`#mem-sheet [data-mv=${dx < 0 ? "next" : "prev"}]`).click();
});
$("#mem-push").addEventListener("change", async e => {
  const sub = await currentSub(); if (!sub) return;
  const { error } = await db.rpc("set_push_memories", { p_endpoint: sub.endpoint, p_on: e.target.checked });
  if (error) { e.target.checked = !e.target.checked; return fail(error); }
  toast(e.target.checked ? "Memories-Meldungen an" : "Memories-Meldungen aus");
});

/* ---------- Snaps (einmal ansehen) ---------- */
const SNAP_SECONDS = 10;
async function loadSnaps() {
  const [sn, rc] = await Promise.all([
    db.from("snaps").select("id,sender_id,caption,created_at,expires_at").order("created_at", { ascending: false }),
    db.from("snap_recipients").select("*"),
  ]);
  // Tabellen gibt es erst nach snaps.sql
  S.snapReady = !sn.error;
  const now = new Date().toISOString();
  S.snaps = (sn.data || []).filter(x => x.expires_at > now); S.snapRcpt = rc.data || [];
}
const rcptOf = id => (S.snapRcpt || []).filter(r => r.snap_id === id);
const myRcpt = id => (S.snapRcpt || []).find(r => r.snap_id === id && r.member_id === me?.id);
const inboxSnaps = () => (S.snaps || []).filter(x => x.sender_id !== me?.id && myRcpt(x.id));
const newSnaps = () => inboxSnaps().filter(x => !myRcpt(x.id).opened_at);
function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  return h === 1 ? "vor 1 Std." : `vor ${h} Std.`;
}

function renderSnaps() {
  const ready = !!S.snapReady;
  $("#snap-setup").hidden = ready;
  $("#snap-main").hidden = !ready;
  const fresh = ready ? newSnaps() : [];
  const b = $("#snap-badge"); b.hidden = !fresh.length; b.textContent = fresh.length;
  if (!ready) return;

  // Fuer dich: neue zuerst, angesehene bleiben bis zum Aufraeumen grau stehen
  const inbox = inboxSnaps().sort((a, b) => (!!myRcpt(a.id).opened_at - !!myRcpt(b.id).opened_at) || b.created_at.localeCompare(a.created_at));
  $("#snap-inbox").innerHTML = inbox.length ? inbox.map(x => {
    const opened = !!myRcpt(x.id).opened_at;
    return `<button type="button" class="snap-item${opened ? " seen" : ""}"${opened ? " disabled" : ` data-snapopen="${x.id}"`}>
      <span class="snap-sq" aria-hidden="true"></span>
      <span class="snap-txt"><b>${esc(nameOf(x.sender_id))}</b><small>${opened ? "Angesehen" : "Neuer Snap · Tippen zum Ansehen"} · ${ago(x.created_at)}</small></span></button>`;
  }).join("") : `<p class="muted snap-empty">Gerade wartet kein Snap auf dich.</p>`;

  // Gesendet: Status pro Empfaenger
  const sent = (S.snaps || []).filter(x => x.sender_id === me.id);
  $("#snap-sent").innerHTML = sent.length ? sent.map(x => {
    const rs = rcptOf(x.id), seen = rs.filter(r => r.opened_at).length;
    return `<div class="snap-item sent">
      <span class="snap-sq out" aria-hidden="true"></span>
      <span class="snap-txt"><b>${rs.length === 1 ? esc(nameOf(rs[0].member_id)) : `An ${rs.length} Leute`}${x.caption ? ` · „${esc(x.caption)}“` : ""}</b>
      <small>${ago(x.created_at)} · ${seen} von ${rs.length} angesehen</small>
      ${rs.length > 1 || seen ? `<span class="snap-who">${rs.sort((a, b) => nameOf(a.member_id).localeCompare(nameOf(b.member_id))).map(r => `<span class="${r.opened_at ? "on" : ""}">${esc(nameOf(r.member_id))}${r.opened_at ? " " + fmtTime(r.opened_at) : ""}</span>`).join("")}</span>` : ""}</span></div>`;
  }).join("") : `<p class="muted snap-empty">Du hast gerade keine Snaps unterwegs.</p>`;
}

function startSnaps() {
  if (!S.snapReady) return "";
  const fresh = newSnaps(); if (!fresh.length) return "";
  const names = [...new Set(fresh.map(x => nameOf(x.sender_id)))];
  return startBlock(fresh.length === 1 ? "Neuer Snap" : `${fresh.length} neue Snaps`, "snaps",
    `<button type="button" class="snap-item" data-snapopen="${fresh[fresh.length - 1].id}"><span class="snap-sq" aria-hidden="true"></span><span class="snap-txt"><b>${esc(names.slice(0, 3).join(", "))}${names.length > 3 ? " und weitere" : ""}</b><small>Tippen zum Ansehen</small></span></button>`, "s-snap");
}

/* Snap schicken */
let snapBlob = null, snapTo = new Set();
function onSnapFile(e) {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  shrink(f, 1280, 0.75).then(blob => {
    snapBlob = blob; snapTo = new Set();
    const img = $("#snap-compose img"); if (img.src) URL.revokeObjectURL(img.src); img.src = URL.createObjectURL(blob);
    $("#snap-caption").value = ""; updateSnapCap();
    renderSnapTo();
    $("#snap-compose").hidden = false;
  }).catch(fail);
}
$("#snap-cam").addEventListener("change", onSnapFile);
$("#snap-gal").addEventListener("change", onSnapFile);
function closeCompose() { snapBlob = null; $("#snap-compose").hidden = true; }
function updateSnapCap() {
  const t = $("#snap-caption").value.trim(), c = $("#snap-compose .snap-cap");
  c.hidden = !t; c.textContent = t;
}
$("#snap-caption").addEventListener("input", updateSnapCap);
const snapTargets = () => S.members.filter(m => m.user_id && m.id !== me.id).sort((a, b) => a.name.localeCompare(b.name));
function renderSnapTo() {
  const all = snapTargets(), isAll = all.length && all.every(m => snapTo.has(m.id));
  $("#snap-to").innerHTML = `<button type="button" class="chip${isAll ? " on" : ""}" data-snapto="all">Alle</button>` +
    all.map(m => `<button type="button" class="chip${snapTo.has(m.id) ? " on" : ""}" data-snapto="${m.id}">${esc(m.name)}</button>`).join("");
  $("#snap-send").textContent = snapTo.size ? `Snap an ${snapTo.size === 1 ? nameOf([...snapTo][0]) : snapTo.size + " Leute"} schicken` : "Snap schicken";
}
function toggleSnapTo(v) {
  const all = snapTargets();
  if (v === "all") snapTo = all.every(m => snapTo.has(m.id)) ? new Set() : new Set(all.map(m => m.id));
  else { const id = +v; snapTo.has(id) ? snapTo.delete(id) : snapTo.add(id); }
  renderSnapTo();
}
$("#snap-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!snapBlob) return;
  if (!snapTo.size) return toast("Wähl mindestens eine Person aus", true);
  const btn = $("#snap-send"); btn.disabled = true; toast("Snap wird geschickt …");
  const st = db.storage.from("snaps"), path = `${rid()}.jpg`;
  try {
    let r = await st.upload(path, snapBlob, { contentType: "image/jpeg" }); if (r.error) throw r.error;
    r = await db.from("snaps").insert({ sender_id: me.id, path, caption: $("#snap-caption").value.trim().slice(0, 80) }).select("id").single();
    if (r.error) { await st.remove([path]); throw r.error; }
    const id = r.data.id;
    r = await db.from("snap_recipients").insert([...snapTo].map(m => ({ snap_id: id, member_id: m })));
    if (r.error) throw r.error;
    db.rpc("push_snap", { p_id: id }).then(({ error }) => { if (error) console.warn(error); });
    const n = snapTo.size;
    closeCompose();
    toast(n === 1 ? "Snap ist raus" : `Snap ist an ${n} Leute raus`);
    await refresh();
  } catch (err) { fail(err); }
  finally { btn.disabled = false; }
});

/* Snap ansehen: einmal, 10 Sekunden */
let snapTimer = null, snapUrl = null;
async function openSnap(id) {
  const x = (S.snaps || []).find(s => s.id === id); if (!x) return;
  const v = $("#snap-view"), img = v.querySelector("img"), bar = v.querySelector(".sv-bar i");
  v.querySelector(".sv-who").textContent = nameOf(x.sender_id);
  const cap = v.querySelector(".sv-cap"); cap.hidden = !x.caption; cap.textContent = x.caption || "";
  img.hidden = true; v.querySelector(".sv-load").hidden = false;
  bar.style.transition = "none"; bar.style.width = "100%";
  v.hidden = false;
  try {
    const { data: path, error } = await db.rpc("open_snap", { p_id: id });
    if (error) throw error;
    const s = await db.storage.from("snaps").createSignedUrl(path, 30);
    if (s.error) throw s.error;
    const blob = await (await fetch(s.data.signedUrl)).blob();
    snapUrl = URL.createObjectURL(blob);
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error("Snap konnte nicht geladen werden")); img.src = snapUrl; });
    if (v.hidden) return closeSnap();
    img.hidden = false; v.querySelector(".sv-load").hidden = true;
    requestAnimationFrame(() => { bar.style.transition = `width ${SNAP_SECONDS}s linear`; bar.style.width = "0%"; });
    snapTimer = setTimeout(closeSnap, SNAP_SECONDS * 1000);
  } catch (err) { closeSnap(); fail(err); }
}
function closeSnap() {
  clearTimeout(snapTimer); snapTimer = null;
  const v = $("#snap-view"), img = v.querySelector("img");
  v.hidden = true; img.removeAttribute("src");
  if (snapUrl) { URL.revokeObjectURL(snapUrl); snapUrl = null; }
  refresh();
}
$("#snap-view").addEventListener("click", () => {
  // Waehrend des Ladens nicht schliessen, sonst waere der Snap verbraucht, ohne dass man ihn gesehen hat
  if (!$("#snap-view .sv-load").hidden) return;
  closeSnap();
});
$("#snap-view").addEventListener("contextmenu", e => e.preventDefault());

$("#snap-push").addEventListener("change", async e => {
  const sub = await currentSub(); if (!sub) return;
  const { error } = await db.rpc("set_push_snaps", { p_endpoint: sub.endpoint, p_on: e.target.checked });
  if (error) { e.target.checked = !e.target.checked; return fail(error); }
  toast(e.target.checked ? "Snap-Meldungen an" : "Snap-Meldungen aus");
});
