-- Partykeller: Memories (Polaroid-Wand)
-- Einmal im Supabase SQL Editor ausfuehren, NACHDEM die Edge Function "push" mit dem neuen Code deployt wurde.
-- Nur Admins laden hoch, alle Freunde sehen die Bilder und reagieren.
-- Bilder loeschen sich nach 60 Tagen automatisch (Datei und Eintrag), bis zu 3 angepinnte bleiben.

-- ============ Speicher (Bucket) ============

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('memories', 'memories', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

-- ============ Tabellen ============

create table public.memories (
  id bigint generated always as identity primary key,
  path text not null unique,
  thumb text not null,
  caption text not null default '' check (char_length(caption) <= 120),
  event_id bigint references public.events(id) on delete set null,
  pinned boolean not null default false,
  batch uuid not null,                       -- zusammen hochgeladen = eine Push-Nachricht
  added_by bigint references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index memories_created on public.memories(created_at);

create table public.memory_reactions (
  memory_id bigint not null references public.memories(id) on delete cascade,
  member_id bigint not null references public.members(id) on delete cascade,
  kind text not null check (kind in ('love','lol','cheers')),
  primary key (memory_id, member_id)
);

alter table public.memories enable row level security;
alter table public.memory_reactions enable row level security;
grant select, insert, update, delete on public.memories to authenticated;
grant select, insert, update, delete on public.memory_reactions to authenticated;

create policy "memories lesen" on public.memories for select to authenticated using (public.is_member());
create policy "memories hochladen" on public.memories for insert to authenticated
  with check (public.is_admin() and added_by = public.my_member_id() and not pinned);
create policy "memories aendern" on public.memories for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "memories loeschen" on public.memories for delete to authenticated using (public.is_admin());

create policy "reaktionen lesen" on public.memory_reactions for select to authenticated using (public.is_member());
create policy "reaktion setzen" on public.memory_reactions for insert to authenticated
  with check (member_id = public.my_member_id());
create policy "reaktion aendern" on public.memory_reactions for update to authenticated
  using (member_id = public.my_member_id()) with check (member_id = public.my_member_id());
create policy "reaktion entfernen" on public.memory_reactions for delete to authenticated
  using (member_id = public.my_member_id());

-- Hoechstens 3 angepinnte Bilder
create or replace function private.check_pins() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.pinned and (select count(*) from public.memories where pinned and id <> new.id) >= 3 then
    raise exception 'Es sind schon 3 Bilder angepinnt. Nimm erst eins ab.';
  end if;
  return new;
end $$;
create trigger memories_max_pins before update of pinned on public.memories
  for each row when (new.pinned and not old.pinned) execute function private.check_pins();

-- ============ Zugriff auf die Dateien ============

create policy "memorydateien ansehen" on storage.objects for select to authenticated
  using (bucket_id = 'memories' and public.is_member());
create policy "memorydateien hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'memories' and public.is_admin());
create policy "memorydateien loeschen" on storage.objects for delete to authenticated
  using (bucket_id = 'memories' and public.is_admin());

-- ============ Push ============

-- Eigener Schalter pro Geraet: "Neue Memories"
alter table public.push_subscriptions add column if not exists memories boolean not null default true;
create or replace function public.set_push_memories(p_endpoint text, p_on boolean) returns void
language sql security definer set search_path = public as $$
  update public.push_subscriptions set memories = p_on where endpoint = p_endpoint and user_id = auth.uid()
$$;

-- Nach dem Hochladen schickt die App einmal pro Stapel eine Nachricht
create or replace function public.push_memories(p_id bigint) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not public.is_admin() then raise exception 'Nur fuer Admins'; end if;
  perform private.notify_push('memories', p_id);
end $$;

revoke all on function public.set_push_memories(text, boolean), public.push_memories(bigint) from public, anon;
grant execute on function public.set_push_memories(text, boolean), public.push_memories(bigint) to authenticated;

-- Der Postbote darf lesen und alte Bilder wegraeumen
grant select, delete on public.memories to service_role;

-- ============ Aufraeumen ============
-- Jede Nacht um 01:00 UTC (3 Uhr Sommerzeit, 2 Uhr Winterzeit):
-- nicht angepinnte Bilder, die aelter als 60 Tage sind, werden samt Datei geloescht.
select cron.unschedule('partykeller-memories') where exists (select 1 from cron.job where jobname = 'partykeller-memories');
select cron.schedule('partykeller-memories', '0 1 * * *', $$ select private.notify_push('memories_cleanup', 0) $$);
