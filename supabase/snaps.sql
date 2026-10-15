-- Partykeller: Snaps (Bilder zur einmaligen Ansicht)
-- Einmal im Supabase SQL Editor ausfuehren, NACHDEM die Edge Function "push" mit dem neuen Code deployt wurde.
-- Ablauf: Snap hochladen -> Empfaenger bekommen Push -> beim Oeffnen wird er gesperrt (nur 30 Sekunden ladbar)
-- -> wenn alle ihn gesehen haben oder nach 24 Stunden loescht der Postbote Datei und Eintrag.

-- ============ Speicher (Bucket) ============

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('snaps', 'snaps', false, 3145728, array['image/jpeg'])
on conflict (id) do nothing;

-- ============ Tabellen ============

create table public.snaps (
  id bigint generated always as identity primary key,
  sender_id bigint not null references public.members(id) on delete cascade,
  path text not null unique,
  caption text not null default '' check (char_length(caption) <= 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create table public.snap_recipients (
  snap_id bigint not null references public.snaps(id) on delete cascade,
  member_id bigint not null references public.members(id) on delete cascade,
  opened_at timestamptz,
  primary key (snap_id, member_id)
);
create index snap_recipients_member on public.snap_recipients(member_id);

alter table public.snaps enable row level security;
alter table public.snap_recipients enable row level security;
grant select, insert on public.snaps to authenticated;
grant select, insert on public.snap_recipients to authenticated;

-- Hilfsfunktionen (umgehen die Zugriffsregeln, damit sich die Regeln nicht gegenseitig aufrufen)
create or replace function public.is_snap_sender(p_snap bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.snaps where id = p_snap and sender_id = public.my_member_id())
$$;
create or replace function public.is_snap_recipient(p_snap bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.snap_recipients where snap_id = p_snap and member_id = public.my_member_id())
$$;

-- Snaps sieht nur, wer ihn geschickt oder bekommen hat
create policy "snaps lesen" on public.snaps for select to authenticated
  using (sender_id = public.my_member_id() or public.is_snap_recipient(id));
create policy "snap schicken" on public.snaps for insert to authenticated
  with check (public.is_member() and sender_id = public.my_member_id());

create policy "empfaenger lesen" on public.snap_recipients for select to authenticated
  using (member_id = public.my_member_id() or public.is_snap_sender(snap_id));
create policy "empfaenger eintragen" on public.snap_recipients for insert to authenticated
  with check (public.is_snap_sender(snap_id) and member_id <> public.my_member_id() and opened_at is null);

-- ============ Einmal ansehen ============
-- Markiert den Snap als geoeffnet. Danach ist die Datei nur noch 30 Sekunden ladbar, ein zweites Oeffnen geht nicht.
create or replace function public.open_snap(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare p text;
begin
  select path into p from public.snaps where id = p_id and expires_at > now();
  if p is null then raise exception 'Dieser Snap ist abgelaufen'; end if;
  update public.snap_recipients set opened_at = now()
    where snap_id = p_id and member_id = public.my_member_id() and opened_at is null;
  if not found then raise exception 'Diesen Snap hast du schon angesehen'; end if;
  return p;
end $$;

-- Darf diese Datei gerade geladen werden? Nur vom Empfaenger, nur kurz nach dem Oeffnen.
create or replace function public.can_view_snap(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.snaps s join public.snap_recipients r on r.snap_id = s.id
    where s.path = p_name and r.member_id = public.my_member_id()
      and r.opened_at > now() - interval '30 seconds')
$$;

revoke all on function public.is_snap_sender(bigint), public.is_snap_recipient(bigint),
  public.open_snap(bigint), public.can_view_snap(text) from public, anon;
grant execute on function public.is_snap_sender(bigint), public.is_snap_recipient(bigint),
  public.open_snap(bigint), public.can_view_snap(text) to authenticated;

-- ============ Zugriff auf die Dateien ============

create policy "snapdateien ansehen" on storage.objects for select to authenticated
  using (bucket_id = 'snaps' and public.can_view_snap(name));
create policy "snapdateien hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'snaps' and public.is_member());
create policy "snapdateien zurueckziehen" on storage.objects for delete to authenticated
  using (bucket_id = 'snaps' and owner = auth.uid());

-- ============ Push ============

alter table public.push_subscriptions add column if not exists snaps boolean not null default true;
create or replace function public.set_push_snaps(p_endpoint text, p_on boolean) returns void
language sql security definer set search_path = public as $$
  update public.push_subscriptions set snaps = p_on where endpoint = p_endpoint and user_id = auth.uid()
$$;

-- Nach dem Schicken: einmal Push an alle Empfaenger
create or replace function public.push_snap(p_id bigint) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not public.is_snap_sender(p_id) then raise exception 'Nur fuer den Absender'; end if;
  perform private.notify_push('snap', p_id);
end $$;

revoke all on function public.set_push_snaps(text, boolean), public.push_snap(bigint) from public, anon;
grant execute on function public.set_push_snaps(text, boolean), public.push_snap(bigint) to authenticated;

-- ============ Aufraeumen ============
-- Weg muss ein Snap, wenn er abgelaufen ist (24 Stunden) oder alle Empfaenger ihn vor mehr als 2 Minuten geoeffnet haben.
create or replace function public.snaps_due() returns setof public.snaps
language sql stable security definer set search_path = public as $$
  select s.* from public.snaps s
  where s.expires_at < now()
     or (s.created_at < now() - interval '2 minutes'
         and not exists (select 1 from public.snap_recipients r
                         where r.snap_id = s.id and (r.opened_at is null or r.opened_at > now() - interval '2 minutes')))
$$;
revoke all on function public.snaps_due() from public, anon, authenticated;
grant execute on function public.snaps_due() to service_role;
grant select, delete on public.snaps, public.snap_recipients to service_role;

-- Alle 5 Minuten nachsehen, den Postboten aber nur rufen, wenn wirklich etwas weg muss
select cron.unschedule('partykeller-snaps') where exists (select 1 from cron.job where jobname = 'partykeller-snaps');
select cron.schedule('partykeller-snaps', '*/5 * * * *',
  $$ select private.notify_push('snap_cleanup', 0) where exists (select 1 from public.snaps_due()) $$);
