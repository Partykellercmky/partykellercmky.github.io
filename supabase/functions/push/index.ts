// Partykeller: Postbote fuer Push-Benachrichtigungen (Supabase Edge Function "push")
// Benoetigte Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_SECRET
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails("https://partykellercmky.github.io", Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);

const TZ = "Europe/Berlin";
const fmtDay = (iso: string) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
const berlinDate = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};

type Msg = { title: string; body: string; url: string; tag: string };
type Sub = { id: number; member_id: number; endpoint: string; p256dh: string; auth: string };

async function subsFor(filter: (s: Sub) => boolean): Promise<Sub[]> {
  const { data, error } = await db.from("push_subscriptions").select("id,member_id,endpoint,p256dh,auth");
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
      const { data: e } = await db.from("events").select("title,day,info,created_by").eq("id", id).single();
      if (!e) return Response.json({ skipped: true });
      const subs = await subsFor((s) => s.member_id !== e.created_by);
      return Response.json(await send(subs, {
        title: "Neuer Termin: " + e.title, body: fmtDay(e.day) + (e.info ? " · " + e.info : "") + " · Bist du dabei?", url: "./#termine", tag: "event-" + id,
      }));
    }
    if (type === "poll") {
      const { data: p } = await db.from("polls").select("question,created_by").eq("id", id).single();
      if (!p) return Response.json({ skipped: true });
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
    return new Response(String(err), { status: 500 });
  }
});
