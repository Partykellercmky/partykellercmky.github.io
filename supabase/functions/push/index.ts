// Partykeller: Postbote fuer Push-Benachrichtigungen (Supabase Edge Function "push")
// Benoetigte Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_SECRET
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

// Geheimer Server-Schluessel: je nach Projekt unter einem anderen Namen hinterlegt
function serverKey(): string {
  const custom = Deno.env.get("SERVER_KEY");
  if (custom) return custom;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const k = keys.default || Object.values(keys)[0];
    if (typeof k === "string" && k) return k;
  } catch { /* ignorieren */ }
  const direct = Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  throw new Error("Kein Server-Schluessel gefunden");
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), { auth: { persistSession: false } });
webpush.setVapidDetails("https://partykellercmky.github.io", Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);

const TZ = "Europe/Berlin";
const fmtDay = (iso: string) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
const berlinDate = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};

type Msg = { title: string; body: string; url: string; tag: string; mid?: number };
type Sub = { id: number; member_id: number; endpoint: string; p256dh: string; auth: string; chat?: boolean; prost?: boolean; memories?: boolean; snaps?: boolean };

// Prost: was jemand in der Hand hat
const DRINKS: Record<string, string> = {
  bier_klein: "ein kleines Bier (0,33 l)", bier: "ein Bier (0,5 l)", mass: "eine Maß (1 l)", radler: "ein Radler", wein: "einen Wein", sekt: "einen Sekt", longdrink: "einen Longdrink",
  cocktail: "einen Cocktail", shot: "einen Shot", alkfrei: "was Alkoholfreies", wasser: "ein Wasser",
};

// Geburtstage: wer hat an einem Tag (yyyy-mm-dd) Geburtstag? 29.02. wird in normalen Jahren am 28.02. gefeiert.
type Bday = { id: number; name: string; bday_day: number; bday_month: number; bday_year: number | null };
async function birthdaysOn(iso: string): Promise<Bday[]> {
  const [y, m, d] = iso.split("-").map(Number);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const { data, error } = await db.from("members").select("id,name,bday_day,bday_month,bday_year").not("bday_day", "is", null);
  if (error) {
    // Spalten gibt es erst nach geburtstag.sql
    if (String(error.message || "").includes("bday")) return [];
    throw error;
  }
  return (data as Bday[]).filter((b) => b.bday_month === m && (b.bday_day === d || (!leap && m === 2 && d === 28 && b.bday_day === 29)));
}
const ageOn = (b: Bday, iso: string) => b.bday_year ? Number(iso.slice(0, 4)) - b.bday_year : null;
const joinNames = (names: string[]) => names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + " und " + names[names.length - 1];

async function subsFor(filter: (s: Sub) => boolean): Promise<Sub[]> {
  const { data, error } = await db.from("push_subscriptions").select("*");
  if (error) throw error;
  return (data as Sub[]).filter(filter);
}

async function send(subs: Sub[], msg: Msg) {
  const results = await Promise.allSettled(subs.map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 60 * 60 * 24 })
  ));
  const dead: number[] = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const code = (r.reason as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) dead.push(subs[i].id);
      else console.error("Push fehlgeschlagen", code, String(r.reason));
    }
  });
  if (dead.length) await db.from("push_subscriptions").delete().in("id", dead);
  return { sent: results.length - dead.length, removed: dead.length };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-push-secret") !== Deno.env.get("PUSH_SECRET")) return new Response("Nicht erlaubt", { status: 401 });
  const { type, id } = await req.json();
  try {
    if (type === "event") {
      const { data: e, error } = await db.from("events").select("title,day,info,created_by").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!e) return Response.json({ skipped: true, grund: "Termin " + id + " nicht gefunden" });
      const subs = await subsFor((s) => s.member_id !== e.created_by);
      return Response.json(await send(subs, {
        title: "Neuer Termin: " + e.title, body: fmtDay(e.day) + (e.info ? " · " + e.info : "") + " · Bist du dabei?", url: "./#termine", tag: "event-" + id,
      }));
    }
    if (type === "poll") {
      const { data: p, error } = await db.from("polls").select("question,created_by").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!p) return Response.json({ skipped: true, grund: "Abstimmung " + id + " nicht gefunden" });
      const subs = await subsFor((s) => s.member_id !== p.created_by);
      return Response.json(await send(subs, { title: "Neue Abstimmung", body: p.question, url: "./#termine", tag: "poll-" + id }));
    }
    if (type === "request") {
      const { data: r } = await db.from("join_requests").select("name").eq("id", id).single();
      const { data: admins } = await db.from("members").select("id").eq("is_admin", true);
      const adminIds = new Set((admins || []).map((a: { id: number }) => a.id));
      const subs = await subsFor((s) => adminIds.has(s.member_id));
      return Response.json(await send(subs, { title: "Neue Beitrittsanfrage", body: (r?.name || "Jemand") + " möchte in den Partykeller.", url: "./#admin", tag: "request-" + id }));
    }
    if (type === "chat") {
      const { data: m, error } = await db.from("messages").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!m) return Response.json({ skipped: true, grund: "Nachricht " + id + " nicht gefunden" });
      const { data: who } = await db.from("members").select("name").eq("id", m.member_id).maybeSingle();
      const name = who?.name || "Jemand";
      // Gefluestert: nur der Empfaenger bekommt etwas, auch bei stummem Chat
      if (m.whisper_to) {
        const wsubs = await subsFor((s) => s.member_id === m.whisper_to);
        const wtext = m.text.length > 140 ? m.text.slice(0, 137) + "…" : m.text;
        return Response.json(await send(wsubs, { title: name + " flüstert dir zu", body: wtext, url: "./#chat", tag: "chat-" + id, mid: id }));
      }
      let replyTo: number | null = null;
      if (m.reply_to) {
        const { data: o } = await db.from("messages").select("member_id").eq("id", m.reply_to).maybeSingle();
        if (o && o.member_id !== m.member_id) replyTo = o.member_id;
      }
      const mentioned = new Set<number>(m.mentions || []);
      const text = m.text.length > 140 ? m.text.slice(0, 137) + "…" : m.text;
      const subs = await subsFor((s) => s.member_id !== m.member_id);
      // Erwaehnte und Angeschriebene bekommen die Nachricht auch bei stummgeschaltetem Chat
      const groups: Record<string, Sub[]> = { mention: [], reply: [], all: [], normal: [] };
      for (const s of subs) {
        if (mentioned.has(s.member_id)) groups.mention.push(s);
        else if (s.member_id === replyTo) groups.reply.push(s);
        else if (m.mention_all) groups.all.push(s);
        else if (s.chat !== false) groups.normal.push(s);
      }
      const titles: Record<string, string> = {
        mention: name + " hat dich erwähnt", reply: name + " hat dir geantwortet",
        all: name + " an alle im Partykeller", normal: name + " im Partykeller-Chat",
      };
      let sent = 0, removed = 0;
      for (const k of Object.keys(groups)) {
        if (!groups[k].length) continue;
        const r = await send(groups[k], { title: titles[k], body: text, url: "./#chat", tag: "chat-" + id, mid: id });
        sent += r.sent; removed += r.removed;
      }
      return Response.json({ sent, removed });
    }
    if (type === "prost") {
      const { data: s, error } = await db.from("prost_sessions").select("id,member_id,place").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!s) return Response.json({ skipped: true, grund: "Runde " + id + " nicht gefunden" });
      const { data: d } = await db.from("prost_drinks").select("kind").eq("session_id", id).order("id").limit(1).maybeSingle();
      const { data: who } = await db.from("members").select("name").eq("id", s.member_id).maybeSingle();
      const subs = await subsFor((x) => x.member_id !== s.member_id && x.prost !== false);
      return Response.json(await send(subs, {
        title: (who?.name || "Jemand") + " ruft Prost!",
        body: "Hat gerade " + (DRINKS[d?.kind] || "was") + " in der Hand" + (s.place ? " · " + s.place : "") + ". Komm vorbei!",
        url: "./#prost", tag: "prost-" + id,
      }));
    }
    if (type === "prost_join") {
      const { data: j, error } = await db.from("prost_joins").select("session_id,member_id,kind").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!j) return Response.json({ skipped: true, grund: "Antwort " + id + " nicht gefunden" });
      const { data: s } = await db.from("prost_sessions").select("member_id").eq("id", j.session_id).maybeSingle();
      if (!s) return Response.json({ skipped: true, grund: "Runde nicht gefunden" });
      const { data: who } = await db.from("members").select("name").eq("id", j.member_id).maybeSingle();
      const name = who?.name || "Jemand";
      // Direkte Antwort: kommt auch an, wenn Prost-Meldungen auf dem Geraet aus sind
      const subs = await subsFor((x) => x.member_id === s.member_id);
      const coming = j.kind === "coming";
      return Response.json(await send(subs, {
        title: coming ? name + " kommt vorbei!" : name + " sagt Prost!",
        body: coming ? "Halt schon mal einen Platz frei." : "Prost aus der Ferne.",
        url: "./#prost", tag: "prost-join-" + id,
      }));
    }
    if (type === "news") {
      const { data: n, error } = await db.from("news").select("title,body,created_by").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!n) return Response.json({ skipped: true, grund: "Eintrag " + id + " nicht gefunden" });
      const subs = await subsFor((x) => x.member_id !== n.created_by);
      const body = n.body.length > 140 ? n.body.slice(0, 137) + "…" : n.body;
      return Response.json(await send(subs, { title: "Neu in der App: " + n.title, body: body || "Schau mal rein!", url: "./#neues", tag: "news-" + id }));
    }
    if (type === "reminder") {
      const tomorrow = berlinDate(1);
      const { data: events } = await db.from("events").select("id,title,info").eq("day", tomorrow);
      let total = 0;
      for (const e of events || []) {
        const { data: noes } = await db.from("rsvps").select("member_id").eq("event_id", e.id).eq("status", "no");
        const skip = new Set((noes || []).map((n: { member_id: number }) => n.member_id));
        const subs = await subsFor((s) => !skip.has(s.member_id));
        total += (await send(subs, { title: "Morgen: " + e.title, body: (e.info ? e.info + " · " : "") + "Schau rein, wer alles dabei ist.", url: "./#termine", tag: "reminder-" + e.id })).sent;
      }
      // Vorwarnung: wer hat morgen Geburtstag? (das Geburtstagskind selbst bekommt nichts)
      const kids = await birthdaysOn(tomorrow);
      for (const b of kids) {
        const age = ageOn(b, tomorrow);
        const subs = await subsFor((s) => s.member_id !== b.id);
        total += (await send(subs, {
          title: "Morgen hat " + b.name + " Geburtstag",
          body: (age ? b.name + " wird " + age + ". " : "") + "Nicht vergessen zu gratulieren!",
          url: "./#gruppe", tag: "bday-eve-" + b.id,
        })).sent;
      }
      return Response.json({ events: (events || []).length, birthdays: kids.length, sent: total });
    }
    if (type === "birthday") {
      const day = berlinDate(0);
      const kids = await birthdaysOn(day);
      let total = 0;
      for (const b of kids) {
        const age = ageOn(b, day);
        // Das Geburtstagskind bekommt einen eigenen Glueckwunsch
        const own = await subsFor((s) => s.member_id === b.id);
        total += (await send(own, {
          title: "Alles Gute zum Geburtstag, " + b.name + "!",
          body: (age ? "Herzlichen Glückwunsch zum " + age + ". " : "") + "Die ganze Partykeller Gruppe stößt auf dich an.",
          url: "./#chat", tag: "bday-own-" + b.id,
        })).sent;
        // Alle anderen: Hinweis mit Weg in den Chat
        const others = await subsFor((s) => s.member_id !== b.id);
        total += (await send(others, {
          title: "Heute hat " + b.name + " Geburtstag!",
          body: (age ? b.name + " wird heute " + age + ". " : "") + "Gratulier im Chat.",
          url: "./#chat", tag: "bday-" + b.id,
        })).sent;
      }
      return Response.json({ birthdays: kids.length, names: joinNames(kids.map((k) => k.name)), sent: total });
    }
    if (type === "memories") {
      // Ein Stapel = eine Nachricht, egal wie viele Bilder
      const { data: first, error } = await db.from("memories").select("batch,caption,added_by").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!first) return Response.json({ skipped: true, grund: "Memory " + id + " nicht gefunden" });
      const { count } = await db.from("memories").select("id", { count: "exact", head: true }).eq("batch", first.batch);
      const n = count || 1;
      const subs = await subsFor((s) => s.member_id !== first.added_by && s.memories !== false);
      return Response.json(await send(subs, {
        title: n === 1 ? "Neue Memory an der Wand" : n + " neue Memories an der Wand",
        body: first.caption || "Schau mal rein!",
        url: "./#memories", tag: "memories-" + first.batch,
      }));
    }
    if (type === "memories_cleanup") {
      // Nicht angepinnte Bilder, die aelter als 60 Tage sind: Datei und Eintrag loeschen
      const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
      const { data: old, error } = await db.from("memories").select("id,path,thumb").eq("pinned", false).lt("created_at", cutoff);
      if (error) throw error;
      if (!old?.length) return Response.json({ deleted: 0 });
      const files = old.flatMap((m: { path: string; thumb: string }) => [m.path, m.thumb]);
      for (let i = 0; i < files.length; i += 100) {
        const { error: se } = await db.storage.from("memories").remove(files.slice(i, i + 100));
        if (se) throw se;
      }
      const { error: de } = await db.from("memories").delete().in("id", old.map((m: { id: number }) => m.id));
      if (de) throw de;
      return Response.json({ deleted: old.length });
    }
    if (type === "snap") {
      const { data: sn, error } = await db.from("snaps").select("sender_id").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!sn) return Response.json({ skipped: true, grund: "Snap " + id + " nicht gefunden" });
      const { data: rs } = await db.from("snap_recipients").select("member_id").eq("snap_id", id);
      const to = new Set((rs || []).map((r: { member_id: number }) => r.member_id));
      const { data: who } = await db.from("members").select("name").eq("id", sn.sender_id).maybeSingle();
      const subs = await subsFor((s) => to.has(s.member_id) && s.snaps !== false);
      return Response.json(await send(subs, {
        title: (who?.name || "Jemand") + " hat dir einen Snap geschickt",
        body: "Einmal ansehen, dann ist er weg.",
        url: "./#snaps", tag: "snap-" + id,
      }));
    }
    if (type === "snap_cleanup") {
      // Gesehene und abgelaufene Snaps: Datei und Eintrag loeschen
      const { data: due, error } = await db.rpc("snaps_due");
      if (error) throw error;
      if (!due?.length) return Response.json({ deleted: 0 });
      const paths = due.map((x: { path: string }) => x.path);
      for (let i = 0; i < paths.length; i += 100) {
        const { error: se } = await db.storage.from("snaps").remove(paths.slice(i, i + 100));
        if (se) throw se;
      }
      const { error: de } = await db.from("snaps").delete().in("id", due.map((x: { id: number }) => x.id));
      if (de) throw de;
      return Response.json({ deleted: due.length });
    }
    return new Response("Unbekannter Typ", { status: 400 });
  } catch (err) {
    console.error(err);
    return Response.json({ fehler: (err as { message?: string })?.message || String(err) }, { status: 500 });
  }
});
