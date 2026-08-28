-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- El cliente detectó una incongruencia de nomenclatura ("Kickboxing" vs
-- "Kickstrike" mezclados en el sistema, probable causa de fondo de varios
-- de los problemas de sincronización de créditos ya parcheados) y pidió
-- eliminar "Kickboxing" por completo: la disciplina se llama única y
-- exclusivamente "Kickstrike" de acá en más. El código (Admin + PWA) ya se
-- actualizó para escribir/leer solo "Kickstrike" -- este script renombra
-- los datos HISTÓRICOS que ya existían con el nombre viejo, en cada lugar
-- donde el texto vive suelto (no como referencia a disciplines.id, que no
-- necesita tocarse: renombrar la fila del catálogo alcanza para que
-- cualquier join automáticamente muestre el nombre nuevo).
--
-- Auditoría de dónde vive el nombre como TEXTO LIBRE (no FK) -- se revisó
-- todo el repo antes de escribir esto, no se adivinó:
--   1. disciplines.name                  -- la fila del catálogo en sí.
--   2. socios.plan (text[])              -- plan del socio, texto libre.
--   3. pagos_socio.paquete               -- snapshot del nombre al pagar.
--   4. packs.name                        -- puede aparecer como substring
--                                            (ej. "Pack 12 clases Kickboxing").
--   5. classes.title                     -- título de clase, texto libre.
--   6. community_posts.author_discipline -- snapshot desnormalizado (RLS).
--   7. configuracion.precio_kickboxing   -- ACÁ es el nombre de la COLUMNA,
--                                            no un valor -- el código de
--                                            ambos repos ya lee/escribe
--                                            precio_kickstrike.
--
-- Chequeado y DESCARTADO (no guardan el nombre como texto en ningún lado,
-- pese a que el pedido los mencionaba como ejemplo):
--   - xp_events: solo tiene reference_id (uuid) + event_type (un enum fijo
--     que ni siquiera incluye disciplinas) -- no hay nada que migrar acá.
--   - bookings / credit_transactions / user_credits: todas referencian
--     disciplines.id por FK, ninguna guarda el nombre como texto propio.

-- 1) El catálogo real.
update disciplines
set name = 'Kickstrike'
where name ilike 'Kickboxing';

-- 2) socios.plan es un array de texto libre (ej. ['CrossFit', 'Kickboxing'])
--    -- se reconstruye elemento por elemento comparando en minúsculas (por
--    si alguna alta vieja importada de Crossfy quedó con otra
--    capitalización) y preservando el orden original con WITH ORDINALITY.
update socios
set plan = (
  select array_agg(
    case when lower(elem) = 'kickboxing' then 'Kickstrike' else elem end
    order by ord
  )
  from unnest(plan) with ordinality as t(elem, ord)
)
where exists (select 1 from unnest(plan) as elem where lower(elem) = 'kickboxing');

-- 3) Historial de pagos -- `paquete` puede ser el nombre exacto de la
--    disciplina ("Kickboxing") o parte de un nombre de pack más largo
--    ("Pack 12 clases Kickboxing", vía Mercado Pago) -- regexp_replace con
--    flag 'gi' (global + case-insensitive) cubre las dos formas.
update pagos_socio
set paquete = regexp_replace(paquete, 'Kickboxing', 'Kickstrike', 'gi')
where paquete ~* 'Kickboxing';

-- 4) Nombres de packs (ej. "Pack 12 clases Kickboxing", "Combo Kickboxing + CrossFit").
update packs
set name = regexp_replace(name, 'Kickboxing', 'Kickstrike', 'gi')
where name ~* 'Kickboxing';

-- 5) Títulos de clases cargadas en la Agenda.
update classes
set title = regexp_replace(title, 'Kickboxing', 'Kickstrike', 'gi')
where title ~* 'Kickboxing';

-- 6) Snapshot desnormalizado de Comunidad (posts ya publicados antes de este cambio).
update community_posts
set author_discipline = regexp_replace(author_discipline, 'Kickboxing', 'Kickstrike', 'gi')
where author_discipline ~* 'Kickboxing';

-- 7) configuracion.precio_kickboxing -> precio_kickstrike. RENOMBRA LA
--    COLUMNA, no toca ningún valor -- el precio configurado (si alguno) se
--    preserva tal cual. Correr esto es obligatorio: el código de ambos
--    repos ya pide precio_kickstrike, así que sin este paso Configuración
--    fallaría con "column does not exist" en la PWA (que sí pide columnas
--    explícitas, a diferencia del panel Admin que usa select('*')).
alter table configuracion
  rename column precio_kickboxing to precio_kickstrike;

-- ── Verificación rápida (opcional, después de correr todo lo de arriba) ────
-- Todas estas deberían devolver 0 filas / la columna nueva:
--
-- select name from disciplines where name ilike '%kickbox%';
-- select id, plan from socios where plan::text ilike '%kickbox%';
-- select id, paquete from pagos_socio where paquete ilike '%kickbox%';
-- select id, name from packs where name ilike '%kickbox%';
-- select id, title from classes where title ilike '%kickbox%';
-- select id, author_discipline from community_posts where author_discipline ilike '%kickbox%';
-- select column_name from information_schema.columns
--   where table_name = 'configuracion' and column_name like 'precio_kick%';
