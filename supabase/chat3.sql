-- Partykeller: Fluestern im Chat
-- Eine gefluesterte Nachricht sehen NUR Absender und Empfaenger (auch Admins nicht).
-- Einmal im Supabase SQL Editor ausfuehren, NACHDEM chat2.sql gelaufen ist.

alter table public.messages
  add column whisper_to bigint references public.members(id) on delete cascade,
  add constraint whisper_not_self check (whisper_to is null or whisper_to <> member_id);

-- Lesen: oeffentliche Nachrichten fuer alle Mitglieder, Gefluestertes nur fuer die zwei Beteiligten
drop policy "chat lesen" on public.messages;
create policy "chat lesen" on public.messages for select to authenticated using (
  public.is_member() and (whisper_to is null or member_id = public.my_member_id() or whisper_to = public.my_member_id())
);

-- Reaktionen nur sichtbar, wenn man die Nachricht selbst sehen darf
drop policy "reaktionen lesen" on public.reactions;
create policy "reaktionen lesen" on public.reactions for select to authenticated using (
  public.is_member() and exists (select 1 from public.messages m where m.id = message_id)
);
