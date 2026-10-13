-- Partykeller: Neues (neue Funktionen der App) und Wuensche-Ecke
-- Einmal im Supabase SQL Editor ausfuehren, NACHDEM prost3.sql gelaufen ist
-- und NACHDEM die Edge Function "push" mit dem neuen Code deployt wurde.

-- ============ Tabellen ============

create table public.news (
  id bigint generated always as identity primary key,
  title text not null check (char_length(title) between 1 and 80),
  body text not null default '' check (char_length(body) <= 600),
  steps text not null default '' check (char_length(steps) <= 600),   -- eine Zeile pro Schritt
  push boolean not null default false,
  created_by bigint references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.news_reactions (
  news_id bigint not null references public.news(id) on delete cascade,
  member_id bigint not null references public.members(id) on delete cascade,
  kind text not null check (kind in ('up','fire','cheers')),
  primary key (news_id, member_id)
);

-- Bis zu welchem Eintrag jemand schon gelesen hat
create table public.news_reads (
  member_id bigint primary key references public.members(id) on delete cascade,
  last_id bigint not null default 0
);

create table public.wishes (
  id bigint generated always as identity primary key,
  text text not null check (char_length(trim(text)) between 1 and 200),
  status text not null default 'open' check (status in ('open','soon','done')),
  created_by bigint references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.wish_votes (
  wish_id bigint not null references public.wishes(id) on delete cascade,
  member_id bigint not null references public.members(id) on delete cascade,
  primary key (wish_id, member_id)
);

-- ============ Zugriff (Tuersteher) ============

alter table public.news enable row level security;
alter table public.news_reactions enable row level security;
alter table public.news_reads enable row level security;
alter table public.wishes enable row level security;
alter table public.wish_votes enable row level security;

grant select, insert, update, delete on public.news to authenticated;
grant select, insert, update, delete on public.news_reactions to authenticated;
grant select on public.news_reads to authenticated;
grant select, insert, delete on public.wishes to authenticated;
grant update (status) on public.wishes to authenticated;
grant select, insert, delete on public.wish_votes to authenticated;

-- Neuigkeiten: alle lesen, nur Admins schreiben, aendern, loeschen
create policy "news lesen" on public.news for select to authenticated using (public.is_member());
create policy "news schreiben" on public.news for insert to authenticated with check (public.is_admin() and created_by = public.my_member_id());
create policy "news aendern" on public.news for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "news loeschen" on public.news for delete to authenticated using (public.is_admin());

create policy "newsreaktion lesen" on public.news_reactions for select to authenticated using (public.is_member());
create policy "newsreaktion setzen" on public.news_reactions for insert to authenticated with check (member_id = public.my_member_id());
create policy "newsreaktion aendern" on public.news_reactions for update to authenticated
  using (member_id = public.my_member_id()) with check (member_id = public.my_member_id());
create policy "newsreaktion entfernen" on public.news_reactions for delete to authenticated using (member_id = public.my_member_id());

create policy "gelesen sehen" on public.news_reads for select to authenticated using (member_id = public.my_member_id());

-- Wuensche: alle lesen und einreichen, Ersteller oder Admin loescht, nur Admin setzt den Status
create policy "wuensche lesen" on public.wishes for select to authenticated using (public.is_member());
create policy "wunsch einreichen" on public.wishes for insert to authenticated with check (public.is_member() and created_by = public.my_member_id());
create policy "wunsch loeschen" on public.wishes for delete to authenticated using (created_by = public.my_member_id() or public.is_admin());
create policy "wunsch status" on public.wishes for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "wunschstimme lesen" on public.wish_votes for select to authenticated using (public.is_member());
create policy "wunschstimme setzen" on public.wish_votes for insert to authenticated with check (member_id = public.my_member_id());
create policy "wunschstimme entfernen" on public.wish_votes for delete to authenticated using (member_id = public.my_member_id());

-- ============ Funktionen ============

-- App meldet: bis Eintrag X gelesen
create or replace function public.mark_news_read(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare mid bigint := public.my_member_id();
begin
  if mid is null then return; end if;
  insert into public.news_reads (member_id, last_id) values (mid, p_id)
  on conflict (member_id) do update set last_id = greatest(public.news_reads.last_id, excluded.last_id);
end $$;

-- Admin: einen Eintrag (nochmal) per Push an alle schicken
create or replace function public.push_news(p_id bigint) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not public.is_admin() then raise exception 'Nur fuer Admins'; end if;
  if not exists (select 1 from public.news where id = p_id) then raise exception 'Eintrag nicht gefunden'; end if;
  perform private.notify_push('news', p_id);
end $$;

revoke all on function public.mark_news_read(bigint), public.push_news(bigint) from public, anon;
grant execute on function public.mark_news_read(bigint), public.push_news(bigint) to authenticated;

-- Neuer Eintrag mit Haken "Push": automatisch an alle
create trigger push_new_news after insert on public.news
  for each row when (new.push) execute function private.on_new_row('news');

grant select on public.news to service_role;

-- ============ Startinhalt: was bisher dazugekommen ist ============

insert into public.news (title, body, steps, created_by, created_at) values
('Chat 2.0',
 'Der Chat kann jetzt viel mehr: Reaktionen, Antworten, @Erwähnungen, wer gerade online ist und Haken wie bei WhatsApp.',
 E'Nachricht antippen: Reaktion, Antworten, Kopieren oder Bearbeiten\nNach rechts wischen, um direkt zu antworten\nMit @Name jemanden erwähnen, mit @alle die ganze Gruppe',
 (select id from public.members where is_admin order by id limit 1), '2026-10-12 21:00+02'),
('Flüstern im Chat',
 'Schick einzelnen Leuten eine Nachricht im Gruppenchat, die nur ihr beide seht. Auch der Admin sieht sie nicht.',
 E'Im Chat links auf psst tippen\nPerson auswählen und Nachricht schreiben\nGeflüsterte Nachrichten sind lila gestrichelt',
 (select id from public.members where is_admin order by id limit 1), '2026-10-13 18:00+02'),
('Prost',
 'Sag der Gruppe Bescheid, wenn du was trinkst. Die anderen bekommen eine Push-Meldung und können vorbeikommen. Mit Strichliste, Karte und Kellerstatistik.',
 E'Unten in der Mitte auf Prost und dann auf den großen Knopf tippen\nGetränk wählen, optional Ort und Standort, dann Prost rufen\nJedes weitere Getränk in der Strichliste antippen, am Ende Ich geh nach Hause',
 (select id from public.members where is_admin order by id limit 1), '2026-10-13 19:45+02'),
('Trinkerkönig',
 'In der Wall of Fame gibt es jetzt ein Podest: Wer hat am meisten getrunken? Gezählt wird nur Alkohol. Bier gibt es in 0,33 l und 0,5 l.',
 E'Mehr und dann Wall of Fame öffnen\nOben Trinkerkönig wählen\nZeitraum umschalten: 7 Tage, Monat oder Jahr',
 (select id from public.members where is_admin order by id limit 1), '2026-10-13 20:20+02'),
('Ich komme! mit Standort',
 'Wenn jemand Prost ruft, kannst du antworten und deinen Standort teilen. Man sieht dann auf der Karte, wie du näher kommst.',
 E'Bei einer Runde auf Ich komme! tippen\nDen Haken bei Standort teilen drin lassen\nVor Ort auf Bin angekommen tippen',
 (select id from public.members where is_admin order by id limit 1), '2026-10-13 20:45+02'),
('Neues Aussehen',
 'Die App ist aufgeräumt: eine Startseite mit allem Wichtigen auf einen Blick und unten nur noch fünf Reiter.',
 E'Start zeigt das nächste Treffen, wer unterwegs ist, die Abstimmung, den Chat und das Zitat des Tages\nGruppe, Wall of Fame und Einstellungen findest du unter Mehr\nNeue Termine und Abstimmungen legst du bei Termine mit dem Plus-Knopf an',
 (select id from public.members where is_admin order by id limit 1), '2026-10-13 21:25+02'),
('Neues und Wünsche-Ecke',
 'Hier erfährst du ab jetzt, was neu in der App ist. Und in der Wünsche-Ecke kannst du Ideen einreichen, was als Nächstes kommen soll.',
 E'Neues findest du unter Mehr\nIm Reiter Wünsche eine Idee eintragen\nBei den Ideen der anderen mit Daumen hoch abstimmen',
 (select id from public.members where is_admin order by id limit 1), now());
