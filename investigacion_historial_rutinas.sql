-- =====================================================================================
-- HISTORIAL DE RUTINAS -- DIAGNÓSTICO (SOLO LECTURA). Son SELECT: no modifican nada.
-- Correr DE A UNA (el editor muestra solo la última grilla) y pasarme el resultado.
--
-- Para qué: Seba quiere que las rutinas nunca se borren y que se acumulen en un historial
-- visible en el Dashboard y en la PWA. Antes de diseñar la migración:
--   * Las tablas routines / routine_days / routine_exercises / routine_completions se
--     crearon a mano en Supabase: su CREATE TABLE no está en ningún repo. Las QUERY 1 a 4
--     sacan del catálogo las columnas, FKs (y qué hacen al borrar), RLS, permisos, triggers
--     y funciones que las tocan. Van en las guardas de la migración.
--   * QUERY 5 a 7: cuántos socios tienen hoy más de una rutina y qué se puede recuperar.
--   * QUERY 8: estado de la cuenta de prueba (DNI 44537978).
-- =====================================================================================


-- ============================================================
-- QUERY 1 -- COLUMNAS reales de las tablas de rutinas.
-- Me interesa sobre todo: is_template (¿nullable?), si routine_days / routine_exercises
-- tienen created_at, y el tipo de routine_completions.completed_date.
-- ============================================================
select table_name, ordinal_position as pos, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('routines', 'routine_days', 'routine_exercises', 'routine_completions',
                     'routine_history', 'user_exercise_weights')
order by table_name, ordinal_position;


-- ============================================================
-- QUERY 2 -- FKs (con lo que hacen al borrar el padre), PK/UNIQUE/CHECK, TRIGGERS,
-- ÍNDICES y VISTAS que tocan rutinas.
-- Clave: routines.user_id -> profiles: ¿CASCADE? (define qué pasa si se borra un socio).
-- ============================================================
with t(rel) as (
  select x::oid
  from unnest(array[to_regclass('public.routines'), to_regclass('public.routine_days'),
                    to_regclass('public.routine_exercises'), to_regclass('public.routine_completions'),
                    to_regclass('public.routine_history'), to_regclass('public.user_exercise_weights')]) as x
  where x is not null
)
select 'FK' as tipo, con.conrelid::regclass::text as tabla, con.conname::text as nombre,
       case con.confdeltype when 'a' then 'no action' when 'r' then 'restrict' when 'c' then 'CASCADE'
                            when 'n' then 'set null' when 'd' then 'set default' end as al_borrar_el_padre,
       pg_get_constraintdef(con.oid) as definicion
from pg_constraint con
where con.contype = 'f'
  and (con.conrelid in (select rel from t) or con.confrelid in (select rel from t))
union all
select 'PK/UNIQUE/CHECK', con.conrelid::regclass::text, con.conname::text, con.contype::text,
       pg_get_constraintdef(con.oid)
from pg_constraint con
where con.contype in ('p', 'u', 'c') and con.conrelid in (select rel from t)
union all
select 'TRIGGER', tg.tgrelid::regclass::text, tg.tgname::text,
       case when tg.tgenabled = 'D' then 'deshabilitado' else 'activo' end, pg_get_triggerdef(tg.oid)
from pg_trigger tg
where not tg.tgisinternal and tg.tgrelid in (select rel from t)
union all
select 'INDICE', i.tablename::text, i.indexname::text, null, i.indexdef
from pg_indexes i
where i.schemaname = 'public'
  and i.tablename in ('routines', 'routine_days', 'routine_exercises', 'routine_completions',
                      'routine_history', 'user_exercise_weights')
union all
select 'VISTA', v.schemaname || '.' || v.viewname, null, null, left(v.definition, 400)
from pg_views v
where v.schemaname not in ('pg_catalog', 'information_schema') and v.definition ~* 'routine'
order by 1, 2, 3;


-- ============================================================
-- QUERY 3 -- RLS, POLICIES y PRIVILEGIOS de anon / authenticated.
-- Clave: quién puede hacer DELETE en routines hoy, y si el socio puede leer rutinas ajenas
-- o el admin no puede leer routine_history (hoy la policy es "solo lo propio").
-- ============================================================
with tablas(tabla) as (
  select unnest(array['routines', 'routine_days', 'routine_exercises', 'routine_completions',
                      'routine_history', 'user_exercise_weights'])
)
select 'RLS' as tipo, c.relname::text as tabla,
       case when c.relrowsecurity then 'activada' else 'DESACTIVADA' end as nombre,
       null::text as comando, null::text as roles, null::text as condicion_using, null::text as with_check
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in (select tabla from tablas)
union all
select 'POLICY', pol.tablename::text, pol.policyname::text, pol.cmd::text, pol.roles::text, pol.qual, pol.with_check
from pg_policies pol
where pol.schemaname = 'public' and pol.tablename in (select tabla from tablas)
union all
select 'PRIVILEGIO', t.tabla, r.rol, string_agg(p.priv, ', ' order by p.priv), null, null, null
from tablas t
cross join unnest(array['anon', 'authenticated']) as r(rol)
cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
where coalesce(has_table_privilege(r.rol, to_regclass('public.' || t.tabla)::oid, p.priv), false)
group by t.tabla, r.rol
order by 1, 2, 3, 4;


-- ============================================================
-- QUERY 4 -- FUNCIONES que tocan rutinas, historial o cargas (y is_admin).
-- Las huellas de finalizar_entrenamiento y eliminar_sesion_historial van en las guardas:
-- la migración va a cambiar finalizar_entrenamiento (para guardar en qué rutina se hizo).
-- Si aparece alguna función que ESCRIBE en routines que no conozco, avisame.
-- ============================================================
select p.oid::regprocedure::text                                                         as funcion,
       md5(pg_get_functiondef(p.oid))                                                    as huella,
       coalesce(p.proacl::text, '(por defecto)')                                         as permisos,
       pg_get_userbyid(p.proowner)                                                       as duenio,
       p.prosecdef                                                                       as security_definer,
       p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?routines\y'        as escribe_routines,
       p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?routine_(days|exercises|completions|history)\y'
                                                                                         as escribe_tablas_hijas,
       p.prosrc ~* 'user_exercise_weights'                                               as toca_cargas,
       pg_get_functiondef(p.oid)                                                         as definicion
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and (p.prosrc ~* 'routine|user_exercise_weights' or p.proname = 'is_admin')
order by 1;


-- ============================================================
-- QUERY 5 -- RESUMEN: cuántos socios tienen más de una rutina (una sola fila).
-- "Rutina de socio" = user_id con valor y no plantilla. Hoy la vigente es la más nueva
-- por created_at; las demás ya son, en los hechos, "anteriores" sin marcar.
-- ============================================================
with asignadas as (
  select user_id, count(*) as rutinas
  from routines
  where user_id is not null and not coalesce(is_template, false)
  group by user_id
)
select
  (select count(*) from routines)                                                             as rutinas_en_total,
  (select count(*) from routines where coalesce(is_template, false))                          as plantillas,
  (select count(*) from routines where user_id is not null and not coalesce(is_template, false)) as rutinas_de_socios,
  (select count(*) from asignadas)                                                            as socios_con_alguna_rutina,
  (select count(*) from asignadas where rutinas = 1)                                          as socios_con_1,
  (select count(*) from asignadas where rutinas > 1)                                          as socios_con_mas_de_1,
  (select coalesce(sum(rutinas - 1), 0) from asignadas)                                       as rutinas_anteriores_en_la_base,
  (select coalesce(max(rutinas), 0) from asignadas)                                           as max_rutinas_de_un_socio,
  (select count(*) from asignadas a join profiles p on p.id = a.user_id where p.role <> 'socio') as socios_que_no_son_role_socio,
  (select count(*) from asignadas a left join profiles p on p.id = a.user_id where p.id is null) as user_id_sin_perfil,
  (select count(*) from routines where user_id is null and not coalesce(is_template, false))  as raras_sin_socio_y_no_plantilla,
  (select count(*) from routines where user_id is not null and coalesce(is_template, false))  as raras_plantilla_con_socio,
  (select count(*) from routines where is_template is null)                                   as is_template_null;


-- ============================================================
-- QUERY 6 -- DETALLE de los socios con MÁS DE UNA rutina: una fila por rutina, en orden.
--   reemplazada_el            = cuándo se creó la siguiente (sería su "fecha de fin").
--   minutos_desde_la_anterior = chico (< 5) sugiere doble asignación por error.
--   re_guardada_con_editar    = 'SÍ' si sus días son posteriores a la rutina (Seba la editó:
--                               la versión original ya no existe). 'sin dato' si
--                               routine_days no tiene created_at.
--   tildes                    = routine_completions que sobrevivieron (Editar las borra).
--   sesiones_historial        = entrenamientos finalizados (routine_history) entre su
--                               asignación y su reemplazo: así se atribuirían en el backfill.
--   cargas_en_ese_periodo     = cargas actuales (user_exercise_weights) cuyo último cambio
--                               cae en ese período (el valor anterior se pisó).
-- ============================================================
with asignadas as (
  select r.id, r.user_id, r.title, r.created_at,
         row_number()       over w                              as n,
         count(*)           over (partition by r.user_id)       as total_socio,
         lead(r.created_at) over w                              as reemplazada_el,
         lag(r.created_at)  over w                              as anterior_creada_el
  from routines r
  where r.user_id is not null and not coalesce(r.is_template, false)
  window w as (partition by r.user_id order by r.created_at, r.id)
),
contenido as (
  select rd.routine_id, count(distinct rd.id) as dias, count(re.id) as ejercicios,
         min((to_jsonb(rd) ->> 'created_at')::timestamptz) as dia_mas_viejo
  from routine_days rd
  left join routine_exercises re on re.day_id = rd.id
  group by rd.routine_id
),
tildes as (
  select rd.routine_id, count(*) as tildes, count(distinct rc.completed_date) as dias_con_tildes,
         min(rc.completed_date) as primer_tilde, max(rc.completed_date) as ultimo_tilde
  from routine_completions rc
  join routine_exercises re on re.id = rc.routine_exercise_id
  join routine_days rd      on rd.id = re.day_id
  group by rd.routine_id
),
sesiones as (
  select a.id as routine_id, count(distinct h.sesion_id) as sesiones,
         min(h.fecha) as primera_sesion, max(h.fecha) as ultima_sesion
  from asignadas a
  join routine_history h on h.user_id = a.user_id
                        and h.created_at >= a.created_at
                        and (a.reemplazada_el is null or h.created_at < a.reemplazada_el)
  group by a.id
),
cargas as (
  select a.id as routine_id, count(*) as cargas
  from asignadas a
  join user_exercise_weights w on w.user_id = a.user_id
                              and w.updated_at >= a.created_at
                              and (a.reemplazada_el is null or w.updated_at < a.reemplazada_el)
  group by a.id
)
select coalesce(p.full_name, '(sin perfil)')                                                 as socio,
       p.dni,
       a.n || ' de ' || a.total_socio                                                        as rutina,
       case when a.reemplazada_el is null then 'VIGENTE' else 'anterior' end                 as estado_hoy,
       a.title                                                                               as titulo,
       to_char(a.created_at at time zone 'America/Argentina/Mendoza', 'DD/MM/YYYY HH24:MI')  as asignada_el,
       to_char(a.reemplazada_el at time zone 'America/Argentina/Mendoza', 'DD/MM/YYYY HH24:MI') as reemplazada_el,
       round(extract(epoch from (a.created_at - a.anterior_creada_el)) / 60)                 as minutos_desde_la_anterior,
       coalesce(c.dias, 0)                                                                   as dias,
       coalesce(c.ejercicios, 0)                                                             as ejercicios,
       case when c.dia_mas_viejo is null then 'sin dato'
            when c.dia_mas_viejo > a.created_at + interval '5 minutes' then 'SÍ'
            else 'no' end                                                                    as re_guardada_con_editar,
       coalesce(t.tildes, 0)                                                                 as tildes,
       coalesce(t.dias_con_tildes, 0)                                                        as dias_con_tildes,
       t.primer_tilde,
       t.ultimo_tilde,
       coalesce(s.sesiones, 0)                                                               as sesiones_historial,
       s.primera_sesion,
       s.ultima_sesion,
       coalesce(g.cargas, 0)                                                                 as cargas_en_ese_periodo,
       a.id                                                                                  as routine_id
from asignadas a
left join profiles p  on p.id = a.user_id
left join contenido c on c.routine_id = a.id
left join tildes t    on t.routine_id = a.id
left join sesiones s  on s.routine_id = a.id
left join cargas g    on g.routine_id = a.id
where a.total_socio > 1
order by socio, a.n;


-- ============================================================
-- QUERY 7 -- QUÉ SE PUEDE RECUPERAR (una sola fila).
--   Sesiones: se atribuyen a la rutina vigente en el momento de finalizar.
--     titulo_dia_coincide / atribuibles_con_titulo_dia = qué tan confiable es esa
--     atribución (el título del día guardado coincide con un día de esa rutina).
--   Cargas: user_exercise_weights guarda solo la ÚLTIMA por ejercicio (pisa la anterior);
--     se puede atribuir esa última a la rutina vigente en su updated_at, nada más.
--   tildes_despues_del_reemplazo: tildes en una rutina ANTERIOR hechos días después de
--     que la reemplazaran (la app del socio seguía mostrando la vieja).
--   rutinas_re_guardadas_con_editar: su versión original se perdió (no recuperable).
-- ============================================================
with asignadas as (
  select r.id, r.user_id, r.created_at,
         lead(r.created_at) over (partition by r.user_id order by r.created_at, r.id) as reemplazada_el
  from routines r
  where r.user_id is not null and not coalesce(r.is_template, false)
),
ses as (
  select h.user_id, h.sesion_id, min(h.created_at) as creada, min(h.titulo_dia) as titulo_dia
  from routine_history h
  group by h.user_id, h.sesion_id
),
ses_atrib as (
  select s.*, a.id as routine_id, a.reemplazada_el
  from ses s
  left join asignadas a on a.user_id = s.user_id
                       and s.creada >= a.created_at
                       and (a.reemplazada_el is null or s.creada < a.reemplazada_el)
),
cargas_atrib as (
  select w.user_id, w.exercise_id, a.id as routine_id
  from user_exercise_weights w
  left join asignadas a on a.user_id = w.user_id
                       and w.updated_at >= a.created_at
                       and (a.reemplazada_el is null or w.updated_at < a.reemplazada_el)
),
tildes as (
  select rc.completed_date::date as fecha, a.reemplazada_el
  from routine_completions rc
  join routine_exercises re on re.id = rc.routine_exercise_id
  join routine_days rd      on rd.id = re.day_id
  join asignadas a          on a.id = rd.routine_id
),
contenido as (
  select a.id, a.created_at, count(re.id) as ejercicios,
         min((to_jsonb(rd) ->> 'created_at')::timestamptz) as dia_mas_viejo
  from asignadas a
  left join routine_days rd      on rd.routine_id = a.id
  left join routine_exercises re on re.day_id = rd.id
  group by a.id, a.created_at
)
select
  (select count(*) from ses_atrib)                                                          as sesiones_total,
  (select count(*) from ses_atrib where routine_id is not null)                             as sesiones_atribuibles,
  (select count(*) from ses_atrib where routine_id is not null and reemplazada_el is not null) as sesiones_de_rutinas_anteriores,
  (select count(*) from ses_atrib where routine_id is null)                                 as sesiones_sin_rutina_posible,
  (select count(*) from ses_atrib where routine_id is not null and titulo_dia is not null)  as atribuibles_con_titulo_dia,
  (select count(*) from ses_atrib s
    where s.routine_id is not null and s.titulo_dia is not null
      and exists (select 1 from routine_days rd
                   where rd.routine_id = s.routine_id
                     and lower(btrim(rd.title)) = lower(btrim(s.titulo_dia))))             as titulo_dia_coincide,
  (select count(*) from cargas_atrib)                                                       as cargas_total,
  (select count(*) from cargas_atrib where routine_id is not null)                          as cargas_atribuibles,
  (select count(*) from cargas_atrib c
    where c.routine_id is not null
      and exists (select 1 from routine_days rd
                  join routine_exercises re on re.day_id = rd.id
                  where rd.routine_id = c.routine_id and re.exercise_id = c.exercise_id))  as cargas_con_ejercicio_en_esa_rutina,
  (select count(*) from tildes)                                                             as tildes_total,
  (select count(*) from tildes where reemplazada_el is not null)                            as tildes_en_rutinas_anteriores,
  (select count(*) from tildes
    where reemplazada_el is not null
      and fecha > (reemplazada_el at time zone 'America/Argentina/Mendoza')::date)          as tildes_despues_del_reemplazo,
  (select count(*) from contenido where ejercicios = 0)                                     as rutinas_asignadas_vacias,
  (select count(*) from contenido where dia_mas_viejo > created_at + interval '5 minutes')  as rutinas_re_guardadas_con_editar,
  (select count(*) from contenido where dia_mas_viejo is null and ejercicios > 0)           as rutinas_sin_dato_de_edicion;


-- ============================================================
-- QUERY 8 -- CUENTA DE PRUEBA (DNI 44537978): perfil, sus rutinas, sesiones y cargas.
-- ============================================================
select p.id                                                                                   as user_id,
       p.full_name,
       p.role,
       r.id                                                                                   as routine_id,
       r.title,
       r.is_template,
       to_char(r.created_at at time zone 'America/Argentina/Mendoza', 'DD/MM/YYYY HH24:MI')   as creada_el,
       (select count(*) from routine_days rd where rd.routine_id = r.id)                      as dias,
       (select count(distinct h.sesion_id) from routine_history h where h.user_id = p.id)     as sesiones_del_socio,
       (select count(*) from user_exercise_weights w where w.user_id = p.id)                  as cargas_del_socio
from profiles p
left join routines r on r.user_id = p.id
where p.dni = '44537978'
order by r.created_at;
