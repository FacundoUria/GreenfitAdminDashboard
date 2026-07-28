-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- El CSV de Crossfy trae 749 socios (de 1020) sin DNI cargado, identificables
-- solo por email. Hoy `dni` es NOT NULL, lo que bloquea esas 749 filas.
alter table socios
  alter column dni drop not null;
