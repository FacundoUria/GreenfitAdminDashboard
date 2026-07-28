-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- El script de importación (scripts/importar_socios.js) hace UPSERT por DNI
-- cuando el socio tiene DNI, y por email cuando no lo tiene (Crossfy exporta
-- muchas filas sin DNI). `dni` ya tiene UNIQUE constraint; falta el de `email`
-- para poder usar `on_conflict=email` sin que Postgres tire 42P10.
alter table socios
  add constraint socios_email_key unique (email);
