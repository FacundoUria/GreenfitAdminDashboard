-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- 'Nuevo Socio' ahora permite elegir varias actividades/planes a la vez
-- (ej. CrossFit + Aparatos). `socios.plan` pasa de texto simple a array de
-- texto; los valores existentes se envuelven en un array de 1 elemento, sin
-- perder datos.

alter table socios
  alter column plan drop default;

alter table socios
  alter column plan type text[]
  using (case when plan is null then null else array[plan] end);

alter table socios
  alter column plan set default array['Pase Libre'];
