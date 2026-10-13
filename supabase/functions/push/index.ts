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
type Sub = { id: number; member_id: number; endpoint: string; p256dh: string; auth: string; chat?: boolean; prost?: boolean };

// Prost: was jemand in der Hand hat
const DRINKS: Record<string, string> = {
  bier: "ein Bier", radler: "ein Radler", wein: "einen Wein", sekt: "einen Sekt", longdrink: "einen Longdrink",
  cocktail: "einen Cocktail", shot: "einen Shot", alkfrei: "was Alkoholfreies", wasser: "ein Wasser",
};

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
      return Response.json({ events: (events || []).length, sent: total });
    }
    return new Response("Unbekannter Typ", { status: 400 });
  } catch (err) {
    console.error(err);
    return Response.json({ fehler: (err as { message?: string })?.message || String(err) }, { status: 500 });
  }
});
