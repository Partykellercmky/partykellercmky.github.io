-- Partykeller: Playlist pro Termin
-- Einmal im Supabase SQL Editor ausfuehren.
-- Jeder darf unbegrenzt viele Songs zu einem Termin einreichen.
-- Loeschen: eigene Songs selbst, alle Songs der Admin.
-- Wird der Termin geloescht, verschwindet die Songliste automatisch mit.

-- ============ Tabellen ============

create table public.event_songs (
  id bigint generated always as identity primary key,
  event_id bigint not null references public.events(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 120),
  url text not null default '' check (char_length(url) <= 300),
  cover text not null default '' check (char_length(cover) <= 400),
  added_by bigint references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index event_songs_event on public.event_songs(event_id);

create table public.song_votes (
  song_id bigint not null references public.event_songs(id) on delete cascade,
  member_id bigint not null references public.members(id) on delete cascade,
  primary key (song_id, member_id)
);

-- ============ Zugriff (Tuersteher) ============

alter table public.event_songs enable row level security;
alter table public.song_votes enable row level security;

grant select, insert, delete on public.event_songs to authenticated;
grant select, insert, delete on public.song_votes to authenticated;

create policy "songs lesen" on public.event_songs for select to authenticated using (public.is_member());
create policy "song einreichen" on public.event_songs for insert to authenticated
  with check (public.is_member() and added_by = public.my_member_id());
create policy "song loeschen" on public.event_songs for delete to authenticated
  using (added_by = public.my_member_id() or public.is_admin());

create policy "songstimme lesen" on public.song_votes for select to authenticated using (public.is_member());
create policy "songstimme setzen" on public.song_votes for insert to authenticated with check (member_id = public.my_member_id());
create policy "songstimme entfernen" on public.song_votes for delete to authenticated using (member_id = public.my_member_id());
