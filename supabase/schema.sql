-- Partykeller Gruppe: Datenbank einrichten
-- Einmal komplett im Supabase SQL Editor ausfuehren.

-- ============ Tabellen ============

create table public.members (
  id bigint generated always as identity primary key,
  name text not null unique,
  bio text not null default '',
  is_admin boolean not null default false,
  invite_email text unique,
  user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.join_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  email text not null default (auth.jwt() ->> 'email'),
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now()
);

create table public.events (
  id bigint generated always as identity primary key,
  title text not null check (char_length(title) between 1 and 80),
  day date not null,
  info text not null default '' check (char_length(info) <= 200),
  created_by bigint references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.rsvps (
  event_id bigint not null references public.events(id) on delete cascade,
  member_id bigint not null references public.members(id) on delete cascade,
  status text not null check (status in ('yes','no')),
  primary key (event_id, member_id)
);

create table public.polls (
  id bigint generated always as identity primary key,
  question text not null check (char_length(question) between 1 and 120),
  created_by bigint references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.poll_options (
  id bigint generated always as identity primary key,
  poll_id bigint not null references public.polls(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 60)
);

create table public.poll_votes (
  poll_id bigint not null references public.polls(id) on delete cascade,
  member_id bigint not null references public.members(id) on delete cascade,
  option_id bigint not null references public.poll_options(id) on delete cascade,
  primary key (poll_id, member_id)
);

create table public.quotes (
  id bigint generated always as identity primary key,
  text text not null check (char_length(text) between 1 and 200),
  said_by bigint references public.members(id) on delete set null,
  created_by bigint references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.rankings (
  id bigint generated always as identity primary key,
  question text not null check (char_length(question) between 1 and 120),
  created_by bigint references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.ranking_votes (
  ranking_id bigint not null references public.rankings(id) on delete cascade,
  voter_id bigint not null references public.members(id) on delete cascade,
  nominee_id bigint not null references public.members(id) on delete cascade,
  primary key (ranking_id, voter_id)
);

-- ============ Hilfsfunktionen ============

create or replace function public.my_member_id() returns bigint
language sql stable security definer set search_path = public as $$
  select id from public.members where user_id = auth.uid()
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid())
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and is_admin)
$$;

-- Nach dem Login: Wenn die E-Mail bei einem Mitglied hinterlegt ist, automatisch verknuepfen.
create or replace function public.link_me() returns bigint
language plpgsql security definer set search_path = public as $$
declare mid bigint;
begin
  if auth.uid() is null then return null; end if;
  select id into mid from public.members where user_id = auth.uid();
  if mid is not null then return mid; end if;
  update public.members set user_id = auth.uid()
    where user_id is null and lower(invite_email) = lower(auth.jwt() ->> 'email')
    returning id into mid;
  if mid is not null then delete from public.join_requests where user_id = auth.uid(); end if;
  return mid;
end $$;

-- Admin: Anfrage einem Mitglied zuordnen und freischalten
create or replace function public.approve_request(req_id bigint, target_member bigint) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not public.is_admin() then raise exception 'Nur fuer Admins'; end if;
  select user_id into uid from public.join_requests where id = req_id;
  if uid is null then raise exception 'Anfrage nicht gefunden'; end if;
  update public.members set user_id = uid where id = target_member and user_id is null;
  if not found then raise exception 'Dieses Mitglied ist schon mit einem Login verknuepft'; end if;
  delete from public.join_requests where id = req_id;
end $$;

-- Admin: Mitglied neu anlegen
create or replace function public.add_member(member_name text) returns bigint
language plpgsql security definer set search_path = public as $$
declare mid bigint;
begin
  if not public.is_admin() then raise exception 'Nur fuer Admins'; end if;
  insert into public.members(name) values (trim(member_name)) returning id into mid;
  return mid;
end $$;

-- Admin: Login von einem Mitglied loesen (z. B. falsche Zuordnung)
create or replace function public.unlink_member(target_member bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Nur fuer Admins'; end if;
  update public.members set user_id = null where id = target_member and not is_admin;
end $$;

-- Eigenen Steckbrief aendern
create or replace function public.set_my_bio(new_bio text) returns void
language sql security definer set search_path = public as $$
  update public.members set bio = left(trim(new_bio), 60) where user_id = auth.uid()
$$;

revoke all on function public.approve_request(bigint,bigint), public.add_member(text),
  public.unlink_member(bigint), public.set_my_bio(text), public.link_me(),
  public.my_member_id(), public.is_member(), public.is_admin() from public, anon;
grant execute on function public.approve_request(bigint,bigint), public.add_member(text),
  public.unlink_member(bigint), public.set_my_bio(text), public.link_me(),
  public.my_member_id(), public.is_member(), public.is_admin() to authenticated;

-- ============ Zugriff (Tuersteher) ============

alter table public.members enable row level security;
alter table public.join_requests enable row level security;
alter table public.events enable row level security;
alter table public.rsvps enable row level security;
alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;
alter table public.quotes enable row level security;
alter table public.rankings enable row level security;
alter table public.ranking_votes enable row level security;

grant select on public.members to authenticated;
grant select, insert, delete on public.join_requests to authenticated;
grant select, insert, delete on public.events, public.polls, public.poll_options,
  public.quotes, public.rankings to authenticated;
grant select, insert, update, delete on public.rsvps, public.poll_votes, public.ranking_votes to authenticated;
grant update (title, day, info) on public.events to authenticated;

-- Mitglieder: nur Freigeschaltete sehen die Liste
create policy "members lesen" on public.members for select to authenticated using (public.is_member());

-- Beitrittsanfragen: eigene sehen/stellen, Admin sieht alle
create policy "anfrage lesen" on public.join_requests for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "anfrage stellen" on public.join_requests for insert to authenticated
  with check (user_id = auth.uid() and not public.is_member());
create policy "anfrage loeschen" on public.join_requests for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Inhalte: alle Mitglieder lesen, eigene anlegen, Ersteller oder Admin loescht
create policy "events lesen" on public.events for select to authenticated using (public.is_member());
create policy "events anlegen" on public.events for insert to authenticated with check (public.is_member() and created_by = public.my_member_id());
create policy "events aendern" on public.events for update to authenticated using (created_by = public.my_member_id() or public.is_admin());
create policy "events loeschen" on public.events for delete to authenticated using (created_by = public.my_member_id() or public.is_admin());

create policy "polls lesen" on public.polls for select to authenticated using (public.is_member());
create policy "polls anlegen" on public.polls for insert to authenticated with check (public.is_member() and created_by = public.my_member_id());
create policy "polls loeschen" on public.polls for delete to authenticated using (created_by = public.my_member_id() or public.is_admin());

create policy "optionen lesen" on public.poll_options for select to authenticated using (public.is_member());
create policy "optionen anlegen" on public.poll_options for insert to authenticated
  with check (exists (select 1 from public.polls p where p.id = poll_id and p.created_by = public.my_member_id()));
create policy "optionen loeschen" on public.poll_options for delete to authenticated
  using (exists (select 1 from public.polls p where p.id = poll_id and (p.created_by = public.my_member_id() or public.is_admin())));

create policy "quotes lesen" on public.quotes for select to authenticated using (public.is_member());
create policy "quotes anlegen" on public.quotes for insert to authenticated with check (public.is_member() and created_by = public.my_member_id());
create policy "quotes loeschen" on public.quotes for delete to authenticated using (created_by = public.my_member_id() or public.is_admin());

create policy "rankings lesen" on public.rankings for select to authenticated using (public.is_member());
create policy "rankings anlegen" on public.rankings for insert to authenticated with check (public.is_member() and created_by = public.my_member_id());
create policy "rankings loeschen" on public.rankings for delete to authenticated using (created_by = public.my_member_id() or public.is_admin());

-- Stimmen und Zusagen: alle lesen, nur die eigene setzen/aendern/zuruecknehmen
create policy "rsvp lesen" on public.rsvps for select to authenticated using (public.is_member());
create policy "rsvp setzen" on public.rsvps for insert to authenticated with check (member_id = public.my_member_id());
create policy "rsvp aendern" on public.rsvps for update to authenticated using (member_id = public.my_member_id()) with check (member_id = public.my_member_id());
create policy "rsvp loeschen" on public.rsvps for delete to authenticated using (member_id = public.my_member_id());

create policy "pollvote lesen" on public.poll_votes for select to authenticated using (public.is_member());
create policy "pollvote setzen" on public.poll_votes for insert to authenticated with check (member_id = public.my_member_id());
create policy "pollvote aendern" on public.poll_votes for update to authenticated using (member_id = public.my_member_id()) with check (member_id = public.my_member_id());
create policy "pollvote loeschen" on public.poll_votes for delete to authenticated using (member_id = public.my_member_id());

create policy "rankvote lesen" on public.ranking_votes for select to authenticated using (public.is_member());
create policy "rankvote setzen" on public.ranking_votes for insert to authenticated with check (voter_id = public.my_member_id());
create policy "rankvote aendern" on public.ranking_votes for update to authenticated using (voter_id = public.my_member_id()) with check (voter_id = public.my_member_id());
create policy "rankvote loeschen" on public.ranking_votes for delete to authenticated using (voter_id = public.my_member_id());

-- ============ Startdaten ============

insert into public.members (name, bio, is_admin, invite_email) values
  ('Gerrit', 'Admin', true, 'gerrit.herde@gmail.com');
insert into public.members (name, bio) values
  ('Steven', 'Boss'), ('Tobi', ''), ('Lennox', ''), ('Sinje', ''), ('Leon', ''), ('Nele', ''),
  ('Paul', ''), ('Alexis', ''), ('Jojo', ''), ('Yannik', ''), ('Svea', ''), ('David', ''),
  ('Sandy', ''), ('Tobi S.', ''), ('Mika', ''), ('Shaham', ''), ('Emily', '');
