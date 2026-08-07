-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- Carga los horarios reales de Aparatos en `classes` -- confirmado por
-- lectura directa contra producción (con la misma anon key que usa la
-- Landing) que la disciplina no tenía NINGUNA fila cargada todavía: por
-- eso "Elegí tu ritmo" mostraba el fallback de "Pase Libre / Horario de
-- Gimnasio" en vez de horarios reales, no por ningún bug de renderizado
-- (ver supabase_migration_disciplines_select_publico.sql para el fix de
-- visibilidad de la disciplina en sí, ya corrido).
--
-- Horarios provistos (Lunes a Viernes, dos franjas):
--   Franja 1: 08:00 a 00:00 hs
--   Franja 2: 15:00 a 22:00 hs
--
-- El id de la disciplina se resuelve DINÁMICAMENTE por nombre (nunca
-- hardcodeado) -- funciona sin importar cuál sea el UUID real. Cada
-- insert usa las MISMAS columnas/valores que ya manda DisciplinaModal.jsx
-- al agregar una franja horaria desde "Editar Disciplina" (instructor
-- null, capacity al default de 20 -- Aparatos no tiene default_capacity
-- propio cargado), para que estas filas queden indistinguibles de una
-- cargada a mano desde el Admin.
--
-- Idempotente: cada insert solo corre si esa franja EXACTA (mismo
-- discipline_id + start_time + end_time + days_of_week) todavía no
-- existe -- este script se puede volver a correr sin duplicar filas.

insert into classes (title, discipline_id, instructor, capacity, days_of_week, start_time, end_time)
select 'Aparatos', d.id, null, 20, array[1, 2, 3, 4, 5], '08:00:00', '00:00:00'
from disciplines d
where d.name = 'Aparatos'
  and not exists (
    select 1 from classes c
    where c.discipline_id = d.id
      and c.start_time = '08:00:00'
      and c.end_time = '00:00:00'
      and c.days_of_week = array[1, 2, 3, 4, 5]
  );

insert into classes (title, discipline_id, instructor, capacity, days_of_week, start_time, end_time)
select 'Aparatos', d.id, null, 20, array[1, 2, 3, 4, 5], '15:00:00', '22:00:00'
from disciplines d
where d.name = 'Aparatos'
  and not exists (
    select 1 from classes c
    where c.discipline_id = d.id
      and c.start_time = '15:00:00'
      and c.end_time = '22:00:00'
      and c.days_of_week = array[1, 2, 3, 4, 5]
  );

-- Punto 3 del pedido: garantiza que el rol anónimo (Landing, sin sesión)
-- pueda leer `classes` sin bloqueos -- mismo patrón que
-- supabase_migration_disciplines_select_publico.sql: una policy SELECT
-- permisiva nueva se combina por OR con cualquier otra que ya exista, así
-- que alcanza sin tener que tocar/adivinar su nombre. Esto además
-- neutraliza a propósito un riesgo real ya identificado en este repo:
-- supabase_migration_admin_auth_rls.sql define ahí una policy
-- "classes_select_all" restringida a `authenticated` -- si esa migración
-- se llegara a correr más adelante (no se sabe si ya está aplicada), esta
-- policy sigue garantizando la lectura pública de todos modos.
alter table classes enable row level security;

drop policy if exists "classes_select_public" on classes;
create policy "classes_select_public" on classes
  for select
  using (true);

-- Verificación opcional (corre como service role en el SQL Editor,
-- bypasea RLS -- confirma exactamente lo que quedó cargado):
--   select c.title, c.days_of_week, c.start_time, c.end_time
--   from classes c join disciplines d on d.id = c.discipline_id
--   where d.name = 'Aparatos'
--   order by c.start_time;
