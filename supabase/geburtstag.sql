-- Partykeller: Geburtstage (Liste, Hinweis auf der Startseite, Push am Geburtstag und am Vorabend)
-- Einmal im Supabase SQL Editor ausfuehren, NACHDEM die Edge Function "push" mit dem neuen Code deployt wurde.

-- ============ Geburtstag im Steckbrief ============
-- Tag und Monat reichen, das Jahr ist freiwillig (dann steht da "wird 24").

alter table public.members
  add column if not exists bday_day smallint check (bday_day between 1 and 31),
  add column if not exists bday_month smallint check (bday_month between 1 and 12),
  add column if not exists bday_year smallint check (bday_year between 1940 and 2030);

-- Prueft das Datum (31.02. geht nicht, 29.02. schon) und speichert es
create or replace function private.store_birthday(target bigint, d int, m int, y int) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if d is null or m is null then
    update public.members set bday_day = null, bday_month = null, bday_year = null where id = target;
    return;
  end if;
  begin
    perform make_date(coalesce(y, 2000), m, d);
  exception when others then
    raise exception 'Dieses Datum gibt es nicht';
  end;
  update public.members set bday_day = d, bday_month = m, bday_year = y where id = target;
end $$;

-- Eigenen Geburtstag eintragen (alles leer = loeschen)
create or replace function public.set_my_birthday(p_day int, p_month int, p_year int default null) returns void
language plpgsql security definer set search_path = public, private as $$
declare mid bigint := public.my_member_id();
begin
  if mid is null then raise exception 'Nur fuer freigeschaltete Mitglieder'; end if;
  perform private.store_birthday(mid, p_day, p_month, p_year);
end $$;

-- Admins koennen den Geburtstag fuer andere eintragen (z. B. fuer alle, die noch nicht eingeloggt sind)
create or replace function public.set_member_birthday(target_member bigint, p_day int, p_month int, p_year int default null) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not public.is_admin() then raise exception 'Nur fuer Admins'; end if;
  perform private.store_birthday(target_member, p_day, p_month, p_year);
end $$;

revoke all on function private.store_birthday(bigint,int,int,int) from public, anon, authenticated;
revoke all on function public.set_my_birthday(int,int,int), public.set_member_birthday(bigint,int,int,int) from public, anon;
grant execute on function public.set_my_birthday(int,int,int), public.set_member_birthday(bigint,int,int,int) to authenticated;

-- ============ Push am Geburtstag ============
-- Jeden Morgen um 07:00 UTC (9 Uhr Sommerzeit, 8 Uhr Winterzeit).
-- Der Hinweis "Morgen hat ... Geburtstag" laeuft mit der Termin-Erinnerung um 18 Uhr mit.
select cron.unschedule('partykeller-geburtstag') where exists (select 1 from cron.job where jobname = 'partykeller-geburtstag');
select cron.schedule('partykeller-geburtstag', '0 7 * * *', $$ select private.notify_push('birthday', 0) $$);
