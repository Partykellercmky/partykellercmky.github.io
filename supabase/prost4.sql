-- Partykeller: Prost-Update – Maß (1 l Bier) als neues Getraenk
-- Einmal im Supabase SQL Editor ausfuehren. Alte Eintraege bleiben, wie sie sind.

alter table public.prost_drinks drop constraint if exists prost_drinks_kind_check;
alter table public.prost_drinks add constraint prost_drinks_kind_check
  check (kind in ('bier_klein','bier','mass','radler','wein','sekt','longdrink','cocktail','shot','alkfrei','wasser'));
