-- Partykeller: Prost-Update – Bier in 0,33 l und 0,5 l
-- Nur noetig, wenn prost.sql schon VOR diesem Update ausgefuehrt wurde.
-- Bisherige "bier"-Eintraege zaehlen als 0,5 l.

alter table public.prost_drinks drop constraint if exists prost_drinks_kind_check;
alter table public.prost_drinks add constraint prost_drinks_kind_check
  check (kind in ('bier_klein','bier','radler','wein','sekt','longdrink','cocktail','shot','alkfrei','wasser'));
