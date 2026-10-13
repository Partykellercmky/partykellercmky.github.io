-- Partykeller: Fotos pro Termin
-- Einmal im Supabase SQL Editor ausfuehren.
-- Fotos liegen im privaten Speicher "fotos", Ordner = Termin-Nummer.
-- Loeschen: eigene Fotos selbst, alle Fotos der Admin.
-- Wird der Termin geloescht, raeumt die App vorher seine Fotos aus dem Speicher.

-- ============ Speicher (Bucket) ============

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

-- ============ Tabelle ============

create table public.event_photos (
  id bigint generated always as identity primary key,
  event_id bigint not null references public.events(id) on delete cascade,
  path text not null unique,
  thumb text not null,
  added_by bigint references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index event_photos_event on public.event_photos(event_id);

alter table public.event_photos enable row level security;
grant select, insert, delete on public.event_photos to authenticated;

create policy "fotos lesen" on public.event_photos for select to authenticated using (public.is_member());
create policy "foto hochladen" on public.event_photos for insert to authenticated
  with check (public.is_member() and added_by = public.my_member_id());
create policy "foto loeschen" on public.event_photos for delete to authenticated
  using (added_by = public.my_member_id() or public.is_admin()
         or exists (select 1 from public.events e where e.id = event_id and e.created_by = public.my_member_id()));

-- ============ Zugriff auf die Dateien ============

create policy "fotodateien ansehen" on storage.objects for select to authenticated
  using (bucket_id = 'fotos' and public.is_member());

create policy "fotodateien hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and public.is_member()
              and exists (select 1 from public.events e where e.id::text = (storage.foldername(name))[1]));

create policy "fotodateien loeschen" on storage.objects for delete to authenticated
  using (bucket_id = 'fotos' and (
    owner = auth.uid() or public.is_admin()
    or exists (select 1 from public.events e where e.id::text = (storage.foldername(name))[1]
               and e.created_by = public.my_member_id())));
