-- Partykeller: Prost (wie Beer With Me)
-- Freunden melden "Ich trinke gerade was, komm vorbei", Strichliste, Karte, Statistik.
-- Einmal im Supabase SQL Editor ausfuehren, NACHDEM chat3.sql gelaufen ist.

-- ============ Tabellen ============

-- Eine Runde: von "Prost rufen" bis "Ich geh nach Hause" (oder bis die Zeit abgelaufen ist)
create table public.prost_sessions (
  id bigint generated always as identity primary key,
  member_id bigint not null references public.members(id) on delete cascade,
  place text not null default '' check (char_length(place) <= 60),
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null default now() + interval '3 hours',
  constraint prost_dauer check (ends_at <= started_at + interval '14 hours')
);
create index prost_sessions_started_idx on public.prost_sessions (started_at desc);

-- Strichliste: jedes Getraenk eine Zeile
create table public.prost_drinks (
  id bigint generated always as identity primary key,
  session_id bigint not null references public.prost_sessions(id) on delete cascade,
  member_id bigint not null references public.members(id) on delete cascade,
  kind text not null check (kind in ('bier_klein','bier','radler','wein','sekt','longdrink','cocktail','shot','alkfrei','wasser')),
  created_at timestamptz not null default now()
);
create index prost_drinks_session_idx on public.prost_drinks (session_id);

-- Antworten der anderen: "Ich komme!" oder "Prost!"
create table public.prost_joins (
  id bigint generated always as identity primary key,
  session_id bigint not null references public.prost_sessions(id) on delete cascade,
  member_id bigint not null references public.members(id) on delete cascade,
  kind text not null check (kind in ('coming','cheers')),
  created_at timestamptz not null default now(),
  unique (session_id, member_id)
);

-- ============ Zugriff (Tuersteher) ============

alter table public.prost_sessions enable row level security;
alter table public.prost_drinks enable row level security;
alter table public.prost_joins enable row level security;

grant select, delete on public.prost_sessions to authenticated;
grant update (place, ends_at) on public.prost_sessions to authenticated;
grant select, insert, delete on public.prost_drinks to authenticated;
grant select, delete on public.prost_joins to authenticated;

create policy "prost lesen" on public.prost_sessions for select to authenticated using (public.is_member());
create policy "prost aendern" on public.prost_sessions for update to authenticated
  using (member_id = public.my_member_id()) with check (member_id = public.my_member_id());
create policy "prost loeschen" on public.prost_sessions for delete to authenticated
  using (member_id = public.my_member_id() or public.is_admin());

create policy "getraenke lesen" on public.prost_drinks for select to authenticated using (public.is_member());
create policy "getraenk zaehlen" on public.prost_drinks for insert to authenticated with check (
  member_id = public.my_member_id()
  and exists (select 1 from public.prost_sessions s where s.id = session_id and s.member_id = public.my_member_id())
);
create policy "getraenk zuruecknehmen" on public.prost_drinks for delete to authenticated using (member_id = public.my_member_id());

create policy "antworten lesen" on public.prost_joins for select to authenticated using (public.is_member());
create policy "antwort zuruecknehmen" on public.prost_joins for delete to authenticated using (member_id = public.my_member_id());

-- ============ Funktionen ============

-- Prost rufen: neue Runde starten, erstes Getraenk zaehlen, auf Wunsch alle benachrichtigen
create or replace function public.start_prost(p_kind text, p_place text, p_lat double precision, p_lng double precision,
                                              p_hours int, p_notify boolean) returns bigint
language plpgsql security definer set search_path = public, private as $$
declare
  mid bigint := public.my_member_id();
  sid bigint;
  recent boolean;
begin
  if mid is null then raise exception 'Nur fuer freigeschaltete Mitglieder'; end if;
  -- Wer in der letzten halben Stunde schon gerufen hat, loest keine zweite Push-Welle aus
  select exists (select 1 from public.prost_sessions where member_id = mid and started_at > now() - interval '30 minutes') into recent;
  -- Laufende eigene Runde beenden (es gibt immer nur eine)
  update public.prost_sessions set ends_at = now() where member_id = mid and ends_at > now();
  insert into public.prost_sessions (member_id, place, lat, lng, ends_at)
    values (mid, left(trim(coalesce(p_place, '')), 60), p_lat, p_lng,
            now() + make_interval(hours => greatest(1, least(coalesce(p_hours, 3), 12))))
    returning id into sid;
  insert into public.prost_drinks (session_id, member_id, kind) values (sid, mid, p_kind);
  if p_notify and not recent then perform private.notify_push('prost', sid); end if;
  return sid;
end $$;

-- Auf eine Runde antworten: "Ich komme!" oder "Prost!" (Push an den, der gerufen hat)
create or replace function public.answer_prost(p_session bigint, p_kind text) returns void
language plpgsql security definer set search_path = public, private as $$
declare
  mid bigint := public.my_member_id();
  owner bigint;
  jid bigint;
begin
  if mid is null then raise exception 'Nur fuer freigeschaltete Mitglieder'; end if;
  select member_id into owner from public.prost_sessions where id = p_session and ends_at > now();
  if owner is null then raise exception 'Die Runde ist schon vorbei'; end if;
  if owner = mid then raise exception 'Auf die eigene Runde kann man nicht antworten'; end if;
  insert into public.prost_joins (session_id, member_id, kind) values (p_session, mid, p_kind)
  on conflict (session_id, member_id) do update set kind = excluded.kind, created_at = now()
    where public.prost_joins.kind is distinct from excluded.kind
  returning id into jid;
  if jid is not null then perform private.notify_push('prost_join', jid); end if;
end $$;

revoke all on function public.start_prost(text,text,double precision,double precision,int,boolean),
  public.answer_prost(bigint,text) from public, anon;
grant execute on function public.start_prost(text,text,double precision,double precision,int,boolean),
  public.answer_prost(bigint,text) to authenticated;

-- ============ Push ============

-- Prost-Meldungen pro Geraet abschaltbar
alter table public.push_subscriptions add column prost boolean not null default true;

create or replace function public.set_push_prost(p_endpoint text, p_on boolean) returns void
language sql security definer set search_path = public as $$
  update public.push_subscriptions set prost = p_on where endpoint = p_endpoint and user_id = auth.uid()
$$;
revoke all on function public.set_push_prost(text, boolean) from public, anon;
grant execute on function public.set_push_prost(text, boolean) to authenticated;

-- Der Postbote (Edge Function) muss die Runden lesen duerfen
grant select on public.prost_sessions, public.prost_drinks, public.prost_joins to service_role;

-- ============ Live-Aktualisierung ============

alter publication supabase_realtime add table public.prost_sessions, public.prost_drinks, public.prost_joins;
