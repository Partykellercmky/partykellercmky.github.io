-- Partykeller: Chat 2.0
-- Antworten, Bearbeiten, @Erwaehnungen, Reaktionen, Haken (zugestellt / gelesen)
-- Einmal im Supabase SQL Editor ausfuehren, NACHDEM chat.sql gelaufen ist.

-- ============ Nachrichten erweitern ============

alter table public.messages
  add column reply_to bigint references public.messages(id) on delete set null,
  add column mentions bigint[] not null default '{}' check (cardinality(mentions) <= 30),
  add column mention_all boolean not null default false,
  add column edited_at timestamptz;

-- Bearbeiten: nur der Text, nur eigene Nachrichten
grant update (text) on public.messages to authenticated;
create policy "chat bearbeiten" on public.messages for update to authenticated
  using (member_id = public.my_member_id()) with check (member_id = public.my_member_id());

create or replace function public.mark_edited() returns trigger
language plpgsql as $$
begin
  if new.text is distinct from old.text then new.edited_at := now(); end if;
  return new;
end $$;
create trigger messages_edited before update on public.messages
  for each row execute function public.mark_edited();

-- ============ Reaktionen (eine pro Person und Nachricht, wie bei WhatsApp) ============

create table public.reactions (
  message_id bigint not null references public.messages(id) on delete cascade,
  member_id bigint not null references public.members(id) on delete cascade,
  kind text not null check (kind in ('up','love','lol','wow','sad','cheers')),
  created_at timestamptz not null default now(),
  primary key (message_id, member_id)
);
alter table public.reactions enable row level security;
grant select, insert, update, delete on public.reactions to authenticated;
create policy "reaktionen lesen" on public.reactions for select to authenticated using (public.is_member());
create policy "reaktion setzen" on public.reactions for insert to authenticated with check (member_id = public.my_member_id());
create policy "reaktion aendern" on public.reactions for update to authenticated
  using (member_id = public.my_member_id()) with check (member_id = public.my_member_id());
create policy "reaktion entfernen" on public.reactions for delete to authenticated using (member_id = public.my_member_id());

-- ============ Zugestellt / gelesen ============

create table public.chat_reads (
  member_id bigint primary key references public.members(id) on delete cascade,
  delivered_id bigint not null default 0,
  read_id bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.chat_reads enable row level security;
grant select on public.chat_reads to authenticated;
create policy "lesestand sehen" on public.chat_reads for select to authenticated using (public.is_member());

-- App meldet: bis Nachricht X angekommen, bis Nachricht Y gelesen
create or replace function public.mark_chat(p_delivered bigint, p_read bigint) returns void
language plpgsql security definer set search_path = public as $$
declare mid bigint := public.my_member_id();
        top bigint := coalesce((select max(id) from public.messages), 0);
        d bigint := least(greatest(coalesce(p_delivered, 0), coalesce(p_read, 0)), top);
        r bigint := least(coalesce(p_read, 0), top);
begin
  if mid is null then return; end if;
  insert into public.chat_reads(member_id, delivered_id, read_id) values (mid, d, r)
  on conflict (member_id) do update
    set delivered_id = greatest(chat_reads.delivered_id, excluded.delivered_id),
        read_id = greatest(chat_reads.read_id, excluded.read_id),
        updated_at = now()
    where excluded.delivered_id > chat_reads.delivered_id or excluded.read_id > chat_reads.read_id;
end $$;
revoke all on function public.mark_chat(bigint, bigint) from public, anon;
grant execute on function public.mark_chat(bigint, bigint) to authenticated;

-- Handy meldet: Push zur Nachricht X ist angekommen (auch wenn die App zu ist)
create or replace function public.push_received(p_endpoint text, p_msg bigint) returns void
language plpgsql security definer set search_path = public as $$
declare mid bigint;
        top bigint := coalesce((select max(id) from public.messages), 0);
begin
  select member_id into mid from public.push_subscriptions where endpoint = p_endpoint;
  if mid is null then return; end if;
  insert into public.chat_reads(member_id, delivered_id) values (mid, least(p_msg, top))
  on conflict (member_id) do update
    set delivered_id = greatest(chat_reads.delivered_id, excluded.delivered_id), updated_at = now()
    where excluded.delivered_id > chat_reads.delivered_id;
end $$;
revoke all on function public.push_received(text, bigint) from public;
grant execute on function public.push_received(text, bigint) to anon, authenticated;

-- ============ Live-Updates ============

alter publication supabase_realtime add table public.reactions;
alter publication supabase_realtime add table public.chat_reads;
