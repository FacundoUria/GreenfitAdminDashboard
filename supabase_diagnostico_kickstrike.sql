-- Ejecutar en el SQL Editor de Supabase -- ES SOLO DE LECTURA, no cambia
-- nada. Correlo primero y pasame el resultado antes de que yo escriba
-- ningún UPDATE corrector: así confirmamos la causa real en vez de adivinar.
--
-- Contexto: agoté la búsqueda en el código -- el mensaje "No se encontró
-- el plan de este socio (Kickstrike) en configuracion" no existe en
-- ningún archivo ni en el historial de git de este repo. Nada en
-- handleAjustarCredito ni en sincronizarCreditosPwa consulta
-- `configuracion` para créditos (`configuracion` en Socios.jsx solo se usa
-- para `dias_tolerancia`, sin relación con esto).
--
-- Lo que SÍ encontré, y es un sospechoso mucho más sólido: disciplines.name
-- tiene una unique constraint CASE-SENSITIVE (backend/supabase-schema.sql).
-- Eso permite que "Kickstrike" y "kickstrike" (o cualquier otra variante de
-- mayúsculas) convivan como DOS filas legítimas y "únicas" para Postgres,
-- aunque para el resto del código (que resuelve por nombre con `ilike`,
-- case-insensitive) sean ambiguas. Ya corregí el código para tolerar esto
-- (ver creditosPwa.js/SociosTabla.jsx), pero si el dato real en producción
-- tiene esta duplicación, conviene consolidarlo también a nivel de datos.

-- 1) ¿Hay más de una fila en disciplines cuyo nombre normalizado
--    (minúsculas + sin espacios) coincide? Si esta query devuelve alguna
--    fila, ESA es la causa real -- copiá el resultado completo.
select
  lower(trim(name)) as nombre_normalizado,
  count(*) as cuantas_filas,
  array_agg(id) as ids,
  array_agg(name) as nombres_exactos,
  array_agg(created_at order by created_at) as creadas
from disciplines
group by lower(trim(name))
having count(*) > 1;

-- 2) Específicamente para Kickstrike -- todas las filas que matchean sin
--    importar mayúsculas (debería haber UNA sola).
select id, name, kind, created_at
from disciplines
where name ilike '%kickstr%' or name ilike '%kickbox%';

-- 3) ¿Terminó de correr supabase_migration_rename_kickstrike.sql la última
--    vez? Si esto NO devuelve ninguna fila, ese script se cortó a mitad de
--    camino (probablemente en el UPDATE de disciplines, si topó con el
--    caso del punto 1) y ningún paso posterior (socios.plan, packs.name,
--    classes.title, community_posts.author_discipline, y sobre todo el
--    rename de la columna configuracion.precio_kickboxing) llegó a correr.
select column_name
from information_schema.columns
where table_name = 'configuracion' and column_name like 'precio_kick%';

-- 4) El caso puntual de Aixa -- a qué discipline_id apunta su balance real
--    de user_credits, y qué dice su socios.plan exactamente (con las
--    comillas para ver espacios/mayúsculas ocultos).
select
  s.dni,
  s.nombre,
  s.apellido,
  s.plan,
  uc.discipline_id,
  d.name as nombre_disciplina_real,
  uc.remaining_credits,
  uc.created_at
from socios s
join profiles p on p.dni = s.dni
join user_credits uc on uc.user_id = p.id
left join disciplines d on d.id = uc.discipline_id
where s.dni = 'DNI_DE_AIXA_ACA' -- reemplazar por el DNI real
order by uc.created_at desc;
