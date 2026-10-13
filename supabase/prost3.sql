-- Partykeller: Prost-Update – Standort, wenn jemand vorbeikommt
-- Wer "Ich komme!" tippt, kann seinen Standort mitschicken. Er wandert mit, solange die App offen ist.
-- Einmal im Supabase SQL Editor ausfuehren, NACHDEM prost.sql gelaufen ist.

alter table public.prost_joins
  add column lat double precision check (lat between -90 and 90),
  add column lng double precision check (lng between -180 and 180),
  add column loc_at timestamptz,
  add column arrived_at timestamptz;

-- Antworten, jetzt mit freiwilligem Standort (ersetzt die alte Fassung)
drop function if exists public.answer_prost(bigint, text);
create or replace function public.answer_prost(p_session bigint, p_kind text,
                                               p_lat double precision default null, p_lng double precision default null) returns void
language plpgsql security definer set search_path = public, private as $$
declare
  mid bigint := public.my_member_id();
  owner bigint;
  old_kind text;
  jid bigint;
  share boolean := p_kind = 'coming' and p_lat is not null and p_lng is not null;
begin
  if mid is null then raise exception 'Nur fuer freigeschaltete Mitglieder'; end if;
  select member_id into owner from public.prost_sessions where id = p_session and ends_at > now();
  if owner is null then raise exception 'Die Runde ist schon vorbei'; end if;
  if owner = mid then raise exception 'Auf die eigene Runde kann man nicht antworten'; end if;
  select kind into old_kind from public.prost_joins where session_id = p_session and member_id = mid;
  insert into public.prost_joins (session_id, member_id, kind, lat, lng, loc_at)
    values (p_session, mid, p_kind,
            case when share then p_lat end, case when share then p_lng end, case when share then now() end)
  on conflict (session_id, member_id) do update
    set kind = excluded.kind, lat = excluded.lat, lng = excluded.lng, loc_at = excluded.loc_at, arrived_at = null,
        created_at = case when public.prost_joins.kind is distinct from excluded.kind then now() else public.prost_joins.created_at end
  returning id into jid;
  -- Push nur, wenn sich die Antwort geaendert hat (nicht bei jedem Standort-Update)
  if old_kind is distinct from p_kind then perform private.notify_push('prost_join', jid); end if;
end $$;

-- Unterwegs: Standort auffrischen (nur wer "Ich komme!" gesagt hat und noch nicht da ist)
create or replace function public.update_prost_location(p_session bigint, p_lat double precision, p_lng double precision) returns void
language sql security definer set search_path = public as $$
  update public.prost_joins set lat = p_lat, lng = p_lng, loc_at = now()
  where session_id = p_session and member_id = public.my_member_id() and kind = 'coming' and arrived_at is null
    and exists (select 1 from public.prost_sessions s where s.id = p_session and s.ends_at > now())
$$;

-- Standort nicht mehr teilen
create or replace function public.stop_prost_location(p_session bigint) returns void
language sql security definer set search_path = public as $$
  update public.prost_joins set lat = null, lng = null, loc_at = null
  where session_id = p_session and member_id = public.my_member_id()
$$;

-- Angekommen: Punkt verschwindet von der Karte
create or replace function public.arrive_prost(p_session bigint) returns void
language sql security definer set search_path = public as $$
  update public.prost_joins set arrived_at = now(), lat = null, lng = null, loc_at = null
  where session_id = p_session and member_id = public.my_member_id() and kind = 'coming'
$$;

revoke all on function public.answer_prost(bigint,text,double precision,double precision),
  public.update_prost_location(bigint,double precision,double precision),
  public.stop_prost_location(bigint), public.arrive_prost(bigint) from public, anon;
grant execute on function public.answer_prost(bigint,text,double precision,double precision),
  public.update_prost_location(bigint,double precision,double precision),
  public.stop_prost_location(bigint), public.arrive_prost(bigint) to authenticated;
