-- Partykeller: Chat
-- Einmal im Supabase SQL Editor ausfuehren, NACHDEM schema.sql und push.sql gelaufen sind.

create table public.messages (
  id bigint generated always as identity primary key,
  member_id bigint not null references public.members(id) on delete cascade,
  text text not null check (char_length(trim(text)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index messages_created_idx on public.messages (created_at desc);

alter table public.messages enable row level security;
grant select, insert, delete on public.messages to authenticated;
grant select on public.messages to service_role;

create policy "chat lesen" on public.messages for select to authenticated using (public.is_member());
create policy "chat schreiben" on public.messages for insert to authenticated with check (member_id = public.my_member_id());
create policy "chat loeschen" on public.messages for delete to authenticated using (member_id = public.my_member_id() or public.is_admin());

-- Neue Nachrichten sofort an alle offenen Apps schicken (Realtime)
alter publication supabase_realtime add table public.messages;

-- Chat-Benachrichtigungen pro Geraet stummschaltbar
alter table public.push_subscriptions add column chat boolean not null default true;

-- Geraet speichern, ohne die Chat-Einstellung zu verlieren
create or replace function public.save_push(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
declare mid bigint := public.my_member_id();
begin
  if mid is null then raise exception 'Nur fuer freigeschaltete Mitglieder'; end if;
  insert into public.push_subscriptions(member_id, user_id, endpoint, p256dh, auth)
    values (mid, auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set member_id = excluded.member_id, user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function public.set_push_chat(p_endpoint text, p_on boolean) returns void
language sql security definer set search_path = public as $$
  update public.push_subscriptions set chat = p_on where endpoint = p_endpoint and user_id = auth.uid()
$$;
revoke all on function public.set_push_chat(text, boolean) from public, anon;
grant execute on function public.set_push_chat(text, boolean) to authenticated;

-- Push bei neuer Nachricht
create trigger push_new_message after insert on public.messages
  for each row execute function private.on_new_row('chat');
