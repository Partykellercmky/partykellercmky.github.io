-- Partykeller: Push-Benachrichtigungen
-- Einmal im Supabase SQL Editor ausfuehren, NACHDEM schema.sql gelaufen ist.
-- PUSH_SECRET_HIER_EINSETZEN durch den geheimen Wert ersetzen (steht nicht im Repository).

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ============ Geraete, die Nachrichten bekommen ============

create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  member_id bigint not null references public.members(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
grant select on public.push_subscriptions to authenticated;
create policy "eigene geraete lesen" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());

create or replace function public.save_push(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
declare mid bigint := public.my_member_id();
begin
  if mid is null then raise exception 'Nur fuer freigeschaltete Mitglieder'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions(member_id, user_id, endpoint, p256dh, auth)
    values (mid, auth.uid(), p_endpoint, p_p256dh, p_auth);
end $$;

create or replace function public.remove_push(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

revoke all on function public.save_push(text,text,text), public.remove_push(text) from public, anon;
grant execute on function public.save_push(text,text,text), public.remove_push(text) to authenticated;

grant usage on schema public to service_role;
grant select on public.events, public.polls, public.join_requests, public.members, public.rsvps to service_role;
grant select, delete on public.push_subscriptions to service_role;

-- ============ Ausloeser ============

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.settings (key text primary key, value text not null);
insert into private.settings values
  ('push_url', 'https://txucqslsykzfhwugdolt.supabase.co/functions/v1/push'),
  ('push_secret', 'PUSH_SECRET_HIER_EINSETZEN');

create or replace function private.notify_push(kind text, rid bigint) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  perform net.http_post(
    url := (select value from private.settings where key = 'push_url'),
    body := jsonb_build_object('type', kind, 'id', rid),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-push-secret', (select value from private.settings where key = 'push_secret')),
    timeout_milliseconds := 15000
  );
end $$;

create or replace function private.on_new_row() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  perform private.notify_push(tg_argv[0], new.id);
  return new;
end $$;

create trigger push_new_event after insert on public.events
  for each row execute function private.on_new_row('event');
create trigger push_new_poll after insert on public.polls
  for each row execute function private.on_new_row('poll');
create trigger push_new_request after insert on public.join_requests
  for each row execute function private.on_new_row('request');

-- Erinnerung am Vortag: jeden Tag um 16:00 UTC (18 Uhr Sommerzeit, 17 Uhr Winterzeit)
select cron.schedule('partykeller-erinnerung', '0 16 * * *', $$ select private.notify_push('reminder', 0) $$);
