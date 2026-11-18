-- =====================================================================
-- INVESTIGACIÓN (SOLO LECTURA): carga / reps / descanso vacíos en rutinas
-- Bug: en el editor del panel, "20kg" en CARGA era un placeholder (campo
-- vacío) que parecía un valor real. Esto mide cuántos ejercicios de rutinas
-- tienen hoy la carga vacía y cuántos tienen "20kg" escrito de verdad.
-- Solo SELECTs. No modifica nada. Correr en el SQL Editor de Supabase.
-- =====================================================================

-- 1) Resumen general de CARGA (weight_suggestion), separado en rutinas
--    asignadas a socios vs plantillas.
select
  case when r.is_template then 'plantilla' else 'asignada a socio' end          as tipo,
  count(*)                                                                       as total_ejercicios,
  count(*) filter (where re.weight_suggestion is null)                           as carga_null,
  count(*) filter (where re.weight_suggestion is not null
                     and btrim(re.weight_suggestion) = '')                       as carga_string_vacio,
  count(*) filter (where lower(regexp_replace(re.weight_suggestion, '\s', '', 'g')) = '20kg')
                                                                                 as carga_20kg_literal,
  count(*) filter (where re.weight_suggestion ~* '20\s*kg')                      as carga_contiene_20kg,
  count(*) filter (where nullif(btrim(re.weight_suggestion), '') is not null)    as carga_con_valor
from routine_exercises re
join routine_days rd on rd.id = re.day_id
join routines r      on r.id  = rd.routine_id
group by rollup (case when r.is_template then 'plantilla' else 'asignada a socio' end)
order by tipo nulls last;

-- 2) Mismo resumen para REPS y DESCANSO (por si tienen el mismo problema).
select
  count(*)                                                                as total_ejercicios,
  count(*) filter (where re.reps is null)                                 as reps_null,
  count(*) filter (where re.reps is not null and btrim(re.reps) = '')     as reps_string_vacio,
  count(*) filter (where btrim(re.reps) = '10-12')                        as reps_10_12,
  count(*) filter (where re.rest_seconds is null)                         as descanso_null,
  count(*) filter (where re.rest_seconds = 0)                             as descanso_cero,
  count(*) filter (where re.rest_seconds = 60)                            as descanso_60
from routine_exercises re;

-- 3) Distribución de los valores de carga más frecuentes (para ver si "20kg"
--    aparece sospechosamente más que el resto).
select
  coalesce(re.weight_suggestion, '<null>') as carga,
  count(*)                                 as ejercicios
from routine_exercises re
group by 1
order by 2 desc
limit 25;

-- 4) Detalle de los "20kg" literales: qué rutina, socio, día y ejercicio.
--    Sirve para preguntarle al profe si lo escribió a propósito.
select
  r.id                                 as routine_id,
  r.title                              as rutina,
  r.is_template                        as es_plantilla,
  p.full_name                          as socio,
  rd.title                             as dia,
  e.name                               as ejercicio,
  re.weight_suggestion                 as carga,
  r.created_at                         as rutina_creada
from routine_exercises re
join routine_days rd on rd.id = re.day_id
join routines r      on r.id  = rd.routine_id
join exercises e     on e.id  = re.exercise_id
left join profiles p on p.id  = r.user_id
where re.weight_suggestion ~* '20\s*kg'
order by r.created_at desc, rd.order_index, re.order_index;
