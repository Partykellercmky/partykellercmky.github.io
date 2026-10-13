-- Partykeller: "Trinkerkönig" heißt jetzt "König am Glas"
-- Passt die schon gespeicherten Einträge auf der Seite Neues an. Einmal im SQL Editor ausführen.

update public.news set
  title = replace(title, 'Trinkerkönig', 'König am Glas'),
  body  = replace(body,  'Trinkerkönig', 'König am Glas'),
  steps = replace(steps, 'Trinkerkönig', 'König am Glas')
where title like '%Trinkerkönig%' or body like '%Trinkerkönig%' or steps like '%Trinkerkönig%';
