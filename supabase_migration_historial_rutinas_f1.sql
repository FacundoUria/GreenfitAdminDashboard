-- =====================================================================================
-- HISTORIAL DE RUTINAS -- FASE 1. Las rutinas de los socios nunca se borran: se acumulan.
-- Corrida en producción el 25/11/2026 (prueba 22 OK, 0 FALLA, 1 SALTEADO). El SALTEADO es
-- (m): borrar la cuenta de test falla por la FK notifications_sender_id_fkey, que ya
-- existía (no es de esta tanda; queda como pendiente aparte).
--
-- Diagnóstico (investigacion_historial_rutinas.sql, 25/11/2026): 55 rutinas de socios, 44
-- socios, 5 con más de una, 11 anteriores; 9 de esas 11 están VACÍAS (copias cortadas a
-- mitad: el panel copiaba de a un INSERT desde el navegador). 166 sesiones, 1124 tildes,
-- 41 rutinas re-guardadas con "Editar" (borraba y volvía a crear los días). RLS activada en
-- las 6 tablas. Huellas: finalizar_entrenamiento 349835fd9ab557bfe45a4a5b2d9222f0,
-- eliminar_sesion_historial b025e91dc1845bc89fc39085c4f179a9.
--
-- Qué hace:
--  1) routines: vigente_desde, vigente_hasta (null = la vigente) y archivada_en. Un índice
--     único parcial: UNA sola vigente por socio. Un CHECK: las rutinas de socio tienen
--     vigencia; las plantillas no.
--  2) Recupera las fechas de las rutinas existentes: vigente_desde = created_at,
--     vigente_hasta = created_at de la siguiente del mismo socio. Las 9 anteriores vacías
--     quedan archivadas (archivada_en): no aparecen en el historial y NO se borran.
--  3) La regla vive en la base (triggers): insertar una rutina de socio cierra la vigente
--     anterior en la misma transacción; una rutina anterior (y sus días, ejercicios y
--     tildes) es de solo lectura; una rutina de socio no se borra, salvo que se esté
--     borrando la cuenta del socio (entonces se va con ella). Las plantillas se siguen
--     pudiendo borrar hasta la Fase 2 (archivar plantillas).
--  4) Dos funciones nuevas para el panel (SECURITY DEFINER + is_admin(), todo en UNA
--     transacción, nunca más una copia a medias):
--       admin_asignar_rutina(p_user_id, p_origen_id): copia una plantilla, o una rutina
--         anterior del mismo socio ("volver a asignar"), como su rutina vigente nueva.
--       admin_guardar_rutina(p_rutina jsonb): crea, o "Guardar cambios" actualizando lo que
--         cambió SIN borrar y volver a crear (los ejercicios que siguen conservan su id y
--         sus tildes), o "Guardar como rutina nueva" (la actual pasa al historial intacta).
--  5) routine_history: routine_id (en qué rutina se hizo; FK on delete set null) y
--     oculta_en. finalizar_entrenamiento recibe p_routine_id (default null: la PWA vieja en
--     caché sigue andando; con null usa la vigente). eliminar_sesion_historial ya no borra:
--     OCULTA la sesión para el socio. La policy de lectura pasa a "propio o admin": Seba ve
--     todo, también lo oculto.
--
-- Qué NO hace (Fase 2): historial de cargas (routine_cargas), archivar plantillas, atribuir
-- las sesiones viejas a su rutina (las 166 quedan con routine_id null).
--
-- Errores propios (la PWA y el panel los reconocen por el código):
--   GFR01 rutina del historial: solo lectura (también: tildar en una rutina que ya no es la
--         vigente -> la PWA recarga).
--   GFR02 una rutina de socio no se borra.
--   GFR03 cambio no permitido sobre una rutina de socio (de socio, plantilla, fechas).
--   GFR04 "Guardar cambios" borraría ejercicios con tildes (el registro del socio): se
--         rechaza entero; el panel ofrece "Guardar como rutina nueva".
--
-- Guardas (si alguna falla, no se aplica nada):
--   G0) Corre como postgres; existe is_admin(); el respaldo no existe (si existe, ya se corrió).
--   G1) finalizar_entrenamiento(text, integer, jsonb) y eliminar_sesion_historial(uuid):
--       huella EXACTA de producción, y su cuerpo es el de
--       backend/supabase_migration_routine_history_v2.sql (ignorando espacios). Permisos:
--       anon no, authenticated sí. No existe todavía una finalizar_entrenamiento de 4 args.
--   G2) Columnas: existen las que usa el panel; no existen todavía las nuevas. Ni
--       routine_days ni routine_exercises tienen índices únicos fuera de la PK (la edición
--       reordena en el lugar). Ningún trigger con los nombres nuevos.
--   G3) Datos como en el diagnóstico: 55 / 44 / 5 / 11 / 9 vacías entre las anteriores.
--   G4) routine_history tiene UNA sola policy: routine_history_select_own (SELECT).
--   DESPUÉS:
--   G5) Una vigente por socio (44); 11 anteriores con fechas; 9 archivadas, todas anteriores
--       y vacías; ninguna plantilla con vigencia; routine_history sin routine_id ni oculta_en.
--   G6) El CONTENIDO de routines, routine_days, routine_exercises, routine_completions,
--       routine_history y user_exercise_weights es idéntico (sin contar las columnas nuevas).
--   G7) Funciones nuevas con sus permisos (las del panel y las de trigger: authenticated sí,
--       anon no; las auxiliares: nadie); finalizar_entrenamiento: solo la de 4 args, con
--       EXECUTE explícito para authenticated y service_role, sin PUBLIC ni anon; eliminar con los
--       permisos de antes. Ninguna OTRA función de la base cambió. Ninguna OTRA policy
--       cambió. Triggers: los de antes + los 5 nuevos.
--
-- Respaldo: respaldo.historial_rutinas_f1_funciones / _politicas / _archivadas.
-- Prueba:   prueba_historial_rutinas_f1.sql (DESPUÉS de esta migración).
-- Rollback: rollback_historial_rutinas_f1.sql.
-- Apps: subir el Dashboard y la PWA de la Fase 1 DESPUÉS de correr esto (leen las columnas
-- nuevas). Con esta migración corrida, las apps de hoy siguen andando.
-- =====================================================================================

begin;

-- ── Constantes ──────────────────────────────────────────────────────────────────────
create temp table _hr on commit drop as
select '349835fd9ab557bfe45a4a5b2d9222f0'::text as huella_finalizar,
       'b025e91dc1845bc89fc39085c4f179a9'::text as huella_eliminar,
       55 as rutinas_de_socios, 44 as socios, 5 as socios_mas_de_1, 11 as anteriores, 9 as anteriores_vacias,
       -- Cuerpos de backend/supabase_migration_routine_history_v2.sql (para la G1).
       $v2fin$
declare
  v_user_id uuid := auth.uid();
  v_ahora timestamptz := now();
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_cantidad int;
  v_ultimo timestamptz;
  v_sesiones_hoy int;
  v_sesion_id uuid := gen_random_uuid();
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Formato de ejercicios inválido';
  end if;

  v_cantidad := jsonb_array_length(p_items);
  if v_cantidad = 0 then
    raise exception 'Marcá al menos un ejercicio para finalizar';
  end if;
  if v_cantidad > 100 then
    raise exception 'Demasiados ejercicios en un solo entrenamiento';
  end if;
  if p_total_ejercicios is null or p_total_ejercicios < v_cantidad then
    raise exception 'Total de ejercicios inválido';
  end if;

  -- Serializa las llamadas del mismo socio: dos requests simultáneos no
  -- pueden pasar los dos el chequeo de abajo.
  perform pg_advisory_xact_lock(hashtext('routine_history:' || v_user_id::text));

  select max(created_at) into v_ultimo
  from routine_history
  where user_id = v_user_id;

  if v_ultimo is not null and v_ultimo > v_ahora - interval '10 seconds' then
    return jsonb_build_object(
      'registrado', false,
      'sesion_id', null,
      'motivo', 'reciente',
      'disponible_desde', v_ultimo + interval '10 seconds'
    );
  end if;

  select count(distinct sesion_id) into v_sesiones_hoy
  from routine_history
  where user_id = v_user_id and fecha = v_hoy;

  if v_sesiones_hoy >= 20 then
    return jsonb_build_object(
      'registrado', false,
      'sesion_id', null,
      'motivo', 'tope_diario',
      'disponible_desde', null
    );
  end if;

  insert into routine_history (
    user_id, sesion_id, fecha, titulo_dia, nombre_ejercicio, grupo_muscular,
    series, repeticiones, peso, orden, total_ejercicios, completo, created_at
  )
  select
    v_user_id,
    v_sesion_id,
    v_hoy,
    nullif(left(trim(p_titulo_dia), 120), ''),
    coalesce(nullif(left(trim(t.item->>'nombre'), 200), ''), 'Ejercicio'),
    nullif(left(trim(t.item->>'grupo'), 80), ''),
    case when (t.item->>'series') ~ '^\d{1,4}$' then (t.item->>'series')::int end,
    nullif(left(trim(t.item->>'repeticiones'), 40), ''),
    nullif(left(trim(t.item->>'peso'), 40), ''),
    (t.ord - 1)::int,
    p_total_ejercicios,
    v_cantidad = p_total_ejercicios,
    v_ahora
  from jsonb_array_elements(p_items) with ordinality as t(item, ord);

  return jsonb_build_object(
    'registrado', true,
    'sesion_id', v_sesion_id,
    'motivo', null,
    'disponible_desde', v_ahora + interval '10 seconds'
  );
end;
$v2fin$::text as cuerpo_v2_finalizar,
       $v2eli$
declare
  v_user_id uuid := auth.uid();
  v_borradas int;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;
  if p_sesion_id is null then
    raise exception 'Falta la sesión a eliminar';
  end if;

  delete from routine_history
  where sesion_id = p_sesion_id
    and user_id = v_user_id;
  get diagnostics v_borradas = row_count;

  return v_borradas;
end;
$v2eli$::text as cuerpo_v2_eliminar;

-- "Rutina de socio" = con user_id y no plantilla (mismo criterio que la investigación).
-- Huella del CONTENIDO de las tablas, sin las columnas que agrega esta migración (G6).
create function pg_temp.hr_huella_contenido() returns text
language sql stable as $f$
  select md5(
       coalesce((select string_agg(x, ',' order by x) from (
         select (to_jsonb(r) - 'vigente_desde' - 'vigente_hasta' - 'archivada_en')::text as x from public.routines r) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(d)::text as x from public.routine_days d) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(e)::text as x from public.routine_exercises e) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(c)::text as x from public.routine_completions c) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (
         select (to_jsonb(h) - 'routine_id' - 'oculta_en')::text as x from public.routine_history h) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(w)::text as x from public.user_exercise_weights w) s), '-'))
$f$;

-- ── G0 a G4 ─────────────────────────────────────────────────────────────────────────
do $guarda$
declare
  k record;
  v_fin regprocedure := to_regprocedure('public.finalizar_entrenamiento(text, integer, jsonb)');
  v_eli regprocedure := to_regprocedure('public.eliminar_sesion_historial(uuid)');
  v_faltan text;
  v_sobran text;
  v_n int;
  v_policies text;
  v_rutinas int;
  v_socios int;
  v_anteriores int;
  v_vacias int;
  v_mas_de_1 int;
begin
  select * into k from _hr;

  -- G0
  if current_user <> 'postgres' then
    raise exception 'Historial F1: hay que correrla como postgres (está corriendo como %). No se aplicó nada.', current_user;
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception 'Historial F1: no existe public.is_admin(). No se aplicó nada.';
  end if;
  if to_regclass('auth.users') is null or not has_table_privilege('postgres', 'auth.users', 'SELECT') then
    raise exception 'Historial F1: postgres no puede leer auth.users (lo usa socio_se_esta_borrando). No se aplicó nada.';
  end if;
  if to_regclass('respaldo.historial_rutinas_f1_funciones') is not null then
    raise exception 'Historial F1: ya existe respaldo.historial_rutinas_f1_funciones (¿ya se corrió?). No se aplicó nada.';
  end if;

  -- G1
  if v_fin is null or v_eli is null then
    raise exception 'Historial F1: no encuentro finalizar_entrenamiento(text, integer, jsonb) o eliminar_sesion_historial(uuid). No se aplicó nada.';
  end if;
  if md5(pg_get_functiondef(v_fin)) <> k.huella_finalizar then
    raise exception 'Historial F1: finalizar_entrenamiento cambió desde el diagnóstico (huella %, se esperaba %). No se aplicó nada.',
      md5(pg_get_functiondef(v_fin)), k.huella_finalizar;
  end if;
  if md5(pg_get_functiondef(v_eli)) <> k.huella_eliminar then
    raise exception 'Historial F1: eliminar_sesion_historial cambió desde el diagnóstico (huella %, se esperaba %). No se aplicó nada.',
      md5(pg_get_functiondef(v_eli)), k.huella_eliminar;
  end if;
  if regexp_replace((select prosrc from pg_proc where oid = v_fin), '\s+', '', 'g')
     <> regexp_replace(k.cuerpo_v2_finalizar, '\s+', '', 'g') then
    raise exception 'Historial F1: el cuerpo de finalizar_entrenamiento en producción NO es el de routine_history_v2.sql. Pasame su definición. No se aplicó nada.';
  end if;
  if regexp_replace((select prosrc from pg_proc where oid = v_eli), '\s+', '', 'g')
     <> regexp_replace(k.cuerpo_v2_eliminar, '\s+', '', 'g') then
    raise exception 'Historial F1: el cuerpo de eliminar_sesion_historial en producción NO es el de routine_history_v2.sql. Pasame su definición. No se aplicó nada.';
  end if;
  if has_function_privilege('anon', v_fin, 'EXECUTE') or not has_function_privilege('authenticated', v_fin, 'EXECUTE')
     or has_function_privilege('anon', v_eli, 'EXECUTE') or not has_function_privilege('authenticated', v_eli, 'EXECUTE') then
    raise exception 'Historial F1: los permisos de finalizar/eliminar no son los esperados (anon no, authenticated sí). No se aplicó nada.';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('finalizar_entrenamiento', 'eliminar_sesion_historial',
                                 'admin_asignar_rutina', 'admin_guardar_rutina',
                                 'routines_abrir_vigencia', 'routines_proteger_historial',
                                 'routine_days_proteger_historial', 'routine_exercises_proteger_historial',
                                 'routine_completions_proteger_historial', 'rutina_es_historial',
                                 'rutina_de_dia', 'rutina_de_ejercicio', 'socio_se_esta_borrando')
               and p.oid not in (v_fin, v_eli)) then
    raise exception 'Historial F1: ya existe alguna de las funciones nuevas (o otra versión de finalizar/eliminar). No se aplicó nada.';
  end if;

  -- G2: columnas que usa el panel
  select string_agg(format('%s.%s', t, c), ', ') into v_faltan
  from (values ('routines', 'id'), ('routines', 'user_id'), ('routines', 'title'), ('routines', 'coach_name'),
               ('routines', 'notes'), ('routines', 'created_at'), ('routines', 'is_template'),
               ('routine_days', 'id'), ('routine_days', 'routine_id'), ('routine_days', 'title'), ('routine_days', 'order_index'),
               ('routine_exercises', 'id'), ('routine_exercises', 'day_id'), ('routine_exercises', 'exercise_id'),
               ('routine_exercises', 'sets'), ('routine_exercises', 'reps'), ('routine_exercises', 'rest_seconds'),
               ('routine_exercises', 'weight_suggestion'), ('routine_exercises', 'notes'), ('routine_exercises', 'order_index'),
               ('routine_completions', 'user_id'), ('routine_completions', 'routine_exercise_id'),
               ('routine_completions', 'completed_date'),
               ('routine_history', 'user_id'), ('routine_history', 'sesion_id'), ('routine_history', 'created_at'),
               ('exercises', 'id'), ('exercises', 'name'), ('exercises', 'muscle_group'),
               ('exercises', 'description'), ('exercises', 'video_url')) as e(t, c)
  where not exists (select 1 from information_schema.columns ic
                    where ic.table_schema = 'public' and ic.table_name = e.t and ic.column_name = e.c);
  if v_faltan is not null then
    raise exception 'Historial F1: faltan columnas: %. No se aplicó nada.', v_faltan;
  end if;
  -- ... y las nuevas todavía no existen
  select string_agg(format('%s.%s', ic.table_name, ic.column_name), ', ') into v_sobran
  from information_schema.columns ic
  where ic.table_schema = 'public'
    and ((ic.table_name = 'routines' and ic.column_name in ('vigente_desde', 'vigente_hasta', 'archivada_en'))
      or (ic.table_name = 'routine_history' and ic.column_name in ('routine_id', 'oculta_en')));
  if v_sobran is not null then
    raise exception 'Historial F1: ya existen columnas nuevas: %. No se aplicó nada.', v_sobran;
  end if;
  select count(*) into v_n
  from pg_index i
  where i.indrelid in ('public.routine_days'::regclass, 'public.routine_exercises'::regclass)
    and i.indisunique and not i.indisprimary;
  if v_n > 0 then
    raise exception 'Historial F1: routine_days / routine_exercises tienen % índice(s) único(s) fuera de la PK (la edición en el lugar podría chocar). No se aplicó nada.', v_n;
  end if;
  if exists (select 1 from pg_trigger
             where tgname in ('routines_abrir_vigencia', 'routines_proteger_historial', 'routine_days_proteger_historial',
                              'routine_exercises_proteger_historial', 'routine_completions_proteger_historial')) then
    raise exception 'Historial F1: ya existe alguno de los triggers nuevos. No se aplicó nada.';
  end if;

  -- G3
  with socio as (
    select r.id, r.user_id,
           lead(r.created_at) over (partition by r.user_id order by r.created_at, r.id) as siguiente
    from public.routines r
    where r.user_id is not null and not coalesce(r.is_template, false)
  )
  select count(*),
         count(distinct socio.user_id),
         count(*) filter (where socio.siguiente is not null),
         count(*) filter (where socio.siguiente is not null and not exists (
           select 1 from public.routine_days rd join public.routine_exercises re on re.day_id = rd.id
           where rd.routine_id = socio.id))
    into v_rutinas, v_socios, v_anteriores, v_vacias
  from socio;
  select count(*) into v_mas_de_1
  from (select user_id from public.routines
        where user_id is not null and not coalesce(is_template, false)
        group by user_id having count(*) > 1) x;
  if v_rutinas <> k.rutinas_de_socios or v_socios <> k.socios or v_mas_de_1 <> k.socios_mas_de_1
     or v_anteriores <> k.anteriores or v_vacias <> k.anteriores_vacias then
    raise exception 'Historial F1: los números cambiaron desde el diagnóstico: rutinas de socios %, socios %, con más de una %, anteriores %, anteriores vacías % (se esperaba %, %, %, %, %). Volvé a correr las QUERY 5 y 6. No se aplicó nada.',
      v_rutinas, v_socios, v_mas_de_1, v_anteriores, v_vacias,
      k.rutinas_de_socios, k.socios, k.socios_mas_de_1, k.anteriores, k.anteriores_vacias;
  end if;

  -- G4
  select string_agg(policyname || ':' || cmd, ', ' order by policyname) into v_policies
  from pg_policies where schemaname = 'public' and tablename = 'routine_history';
  if v_policies is distinct from 'routine_history_select_own:SELECT' then
    raise exception 'Historial F1: las policies de routine_history no son las esperadas (hay: %; se esperaba routine_history_select_own:SELECT). No se aplicó nada.',
      coalesce(v_policies, 'ninguna');
  end if;
end;
$guarda$;

-- ── Foto de antes ───────────────────────────────────────────────────────────────────
create temp table _antes on commit drop as
select pg_temp.hr_huella_contenido() as huella_contenido,
       (select md5(coalesce(string_agg(format('%s|%s|%s|%s|%s|%s|%s', schemaname, tablename, policyname, permissive,
                                              roles, cmd, coalesce(qual, '') || '/' || coalesce(with_check, '')),
                                       ';' order by schemaname, tablename, policyname), ''))
        from pg_policies where not (schemaname = 'public' and tablename = 'routine_history')) as huella_otras_policies,
       (select coalesce(string_agg(tgrelid::regclass::text || '.' || tgname, ',' order by tgrelid::regclass::text, tgname), '')
        from pg_trigger
        where not tgisinternal
          and tgrelid in ('public.routines'::regclass, 'public.routine_days'::regclass, 'public.routine_exercises'::regclass,
                          'public.routine_completions'::regclass, 'public.routine_history'::regclass)) as triggers_antes,
       (select coalesce(p.proacl::text, 'NULL') from pg_proc p
        where p.oid = 'public.eliminar_sesion_historial(uuid)'::regprocedure) as permisos_eliminar;

create temp table _funcs_antes on commit drop as
select p.oid, coalesce(p.proacl::text, 'NULL') || '=' || md5(coalesce(p.prosrc, '')) as huella
from pg_proc p
where p.pronamespace not in (select n.oid from pg_namespace n where n.nspname like 'pg_temp%')
  and p.oid not in ('public.finalizar_entrenamiento(text, integer, jsonb)'::regprocedure,
                    'public.eliminar_sesion_historial(uuid)'::regprocedure);

-- ── Respaldo ────────────────────────────────────────────────────────────────────────
create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

-- Sin "if not exists": si ya existen, esta migración ya se corrió y no se aplica nada.
create table respaldo.historial_rutinas_f1_funciones (
  funcion           text primary key,
  definicion_antes  text not null,
  huella_antes      text not null,
  permisos_antes    text not null,
  definicion_nueva  text,
  huella_nueva      text,
  permisos_nuevos   text,
  guardado_en       timestamptz not null default now()
);
create table respaldo.historial_rutinas_f1_politicas (
  tabla             text not null,
  nombre_antes      text not null,
  definicion_antes  text not null,
  nombre_nueva      text not null,
  guardado_en       timestamptz not null default now(),
  primary key (tabla, nombre_antes)
);
create table respaldo.historial_rutinas_f1_archivadas (
  routine_id        uuid primary key,
  user_id           uuid not null,
  titulo            text,
  creada_el         timestamptz,
  archivada_en      timestamptz not null default now()
);
revoke all on respaldo.historial_rutinas_f1_funciones, respaldo.historial_rutinas_f1_politicas,
              respaldo.historial_rutinas_f1_archivadas from public, anon, authenticated;

-- Clave fija (no regprocedure::text, que sale sin "public." y sin espacios): el rollback la
-- busca tal cual.
insert into respaldo.historial_rutinas_f1_funciones (funcion, definicion_antes, huella_antes, permisos_antes)
select v.funcion, pg_get_functiondef(p.oid), md5(pg_get_functiondef(p.oid)), coalesce(p.proacl::text, 'NULL')
from (values ('public.finalizar_entrenamiento(text, integer, jsonb)',
              'public.finalizar_entrenamiento(text, integer, jsonb)'::regprocedure::oid),
             ('public.eliminar_sesion_historial(uuid)',
              'public.eliminar_sesion_historial(uuid)'::regprocedure::oid)) as v(funcion, oid)
join pg_proc p on p.oid = v.oid;

insert into respaldo.historial_rutinas_f1_politicas (tabla, nombre_antes, definicion_antes, nombre_nueva)
select 'routine_history', pol.policyname,
       format('create policy %I on public.routine_history as %s for %s to %s using (%s)%s',
              pol.policyname, pol.permissive, pol.cmd,
              (select string_agg(case when x = 'public' then 'public' else quote_ident(x) end, ', ') from unnest(pol.roles) x),
              pol.qual,
              case when pol.with_check is not null then format(' with check (%s)', pol.with_check) else '' end),
       'routine_history_select_own_or_admin'
from pg_policies pol
where pol.schemaname = 'public' and pol.tablename = 'routine_history' and pol.policyname = 'routine_history_select_own';

-- ── 1) Columnas, recuperación de fechas y restricciones ─────────────────────────────
alter table public.routines
  add column vigente_desde timestamptz,
  add column vigente_hasta timestamptz,
  add column archivada_en  timestamptz;

comment on column public.routines.vigente_desde is
  'Rutina de socio: desde cuándo es (o fue) la vigente. Plantillas: null. (Historial de rutinas F1)';
comment on column public.routines.vigente_hasta is
  'Rutina de socio: cuándo pasó al historial (se le asignó otra). null = la vigente. Plantillas: null.';
comment on column public.routines.archivada_en is
  'Archivada: no aparece en el historial ni en las listas. Nunca se borra.';

-- Fechas de las rutinas que ya existen: inicio = created_at; fin = created_at de la siguiente.
update public.routines r
set vigente_desde = s.created_at,
    vigente_hasta = s.siguiente
from (
  select id, created_at,
         lead(created_at) over (partition by user_id order by created_at, id) as siguiente
  from public.routines
  where user_id is not null and not coalesce(is_template, false)
) s
where s.id = r.id;

-- Las anteriores VACÍAS (copias cortadas a mitad): archivadas, no borradas.
insert into respaldo.historial_rutinas_f1_archivadas (routine_id, user_id, titulo, creada_el)
select r.id, r.user_id, r.title, r.created_at
from public.routines r
where r.user_id is not null and not coalesce(r.is_template, false)
  and r.vigente_hasta is not null
  and not exists (select 1 from public.routine_days rd join public.routine_exercises re on re.day_id = rd.id
                  where rd.routine_id = r.id);

update public.routines r
set archivada_en = a.archivada_en
from respaldo.historial_rutinas_f1_archivadas a
where a.routine_id = r.id;

alter table public.routines add constraint routines_vigencia_coherente check (
  case when user_id is not null and not coalesce(is_template, false)
       then vigente_desde is not null and (vigente_hasta is null or vigente_hasta >= vigente_desde)
       else vigente_desde is null and vigente_hasta is null
  end
);

create unique index routines_una_vigente_por_socio on public.routines (user_id)
  where user_id is not null and not coalesce(is_template, false) and vigente_hasta is null;

alter table public.routine_history
  add column routine_id uuid references public.routines(id) on delete set null,
  add column oculta_en  timestamptz;

comment on column public.routine_history.routine_id is
  'Rutina en la que se hizo el entrenamiento (desde la F1 del historial de rutinas; las viejas, null hasta la F2).';
comment on column public.routine_history.oculta_en is
  'El socio la sacó de su historial ("Eliminar"): no se borra; el admin la sigue viendo.';

create index routine_history_routine_idx on public.routine_history (routine_id) where routine_id is not null;

-- ── 2) Funciones de apoyo de los triggers (uso interno) ─────────────────────────────
create function public.rutina_es_historial(p_routine_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from routines r
    where r.id = p_routine_id
      and r.user_id is not null
      and not coalesce(r.is_template, false)
      and r.vigente_hasta is not null
  );
$$;

-- ¿Se está borrando la cuenta de este socio? Cuando la Edge Function admin-delete-socio
-- borra auth.users, la cascada llega a sus rutinas, tildes, etc. Se mira auth.users Y
-- profiles: según qué FK cascadee primero, una de las dos filas ya no está.
create function public.socio_se_esta_borrando(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select not exists (select 1 from public.profiles p where p.id = p_user_id)
      or not exists (select 1 from auth.users u where u.id = p_user_id);
$$;

create function public.rutina_de_dia(p_day_id uuid)
returns uuid
language sql
security definer
set search_path = public
as $$
  select rd.routine_id from routine_days rd where rd.id = p_day_id;
$$;

create function public.rutina_de_ejercicio(p_routine_exercise_id uuid)
returns uuid
language sql
security definer
set search_path = public
as $$
  select rd.routine_id
  from routine_exercises re
  join routine_days rd on rd.id = re.day_id
  where re.id = p_routine_exercise_id;
$$;

-- ── 3) Triggers ─────────────────────────────────────────────────────────────────────
-- Insertar una rutina de socio: abre su vigencia y cierra la vigente anterior, en la misma
-- transacción. Vale para cualquier camino (funciones del panel, panel viejo en caché, SQL
-- Editor). El lock por socio serializa dos asignaciones simultáneas.
create function public.routines_abrir_vigencia()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ahora timestamptz := clock_timestamp();
begin
  if new.user_id is null or coalesce(new.is_template, false) then
    new.vigente_desde := null;
    new.vigente_hasta := null;
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('routines_vigente:' || new.user_id::text));

  new.vigente_desde := v_ahora;
  new.vigente_hasta := null;
  new.archivada_en := null;

  perform set_config('greenfit.cierre_rutina', 'on', true);
  update routines
  set vigente_hasta = v_ahora
  where user_id = new.user_id
    and not coalesce(is_template, false)
    and vigente_hasta is null;
  perform set_config('greenfit.cierre_rutina', 'off', true);

  return new;
end;
$$;

-- Rutina de socio: no se borra (salvo con la cuenta del socio); una anterior es de solo
-- lectura; de la vigente solo cambia el contenido. Plantillas: se borran y editan como hoy.
create function public.routines_proteger_historial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_de_socio boolean := old.user_id is not null and not coalesce(old.is_template, false);
begin
  if tg_op = 'DELETE' then
    if not v_de_socio then
      return old;
    end if;
    -- Se está borrando la cuenta del socio (cascada): sus rutinas se van con ella.
    if socio_se_esta_borrando(old.user_id) then
      return old;
    end if;
    raise exception 'Las rutinas de los socios no se borran: quedan en su historial.'
      using errcode = 'GFR02';
  end if;

  if not v_de_socio then
    if new.user_id is not null and not coalesce(new.is_template, false) then
      raise exception 'Una plantilla no se convierte en rutina de un socio: hay que asignarla.'
        using errcode = 'GFR03';
    end if;
    return new;
  end if;

  if old.vigente_hasta is not null then
    raise exception 'Esta rutina es del historial del socio: es de solo lectura.'
      using errcode = 'GFR01';
  end if;

  if new.user_id is distinct from old.user_id
     or coalesce(new.is_template, false)
     or new.vigente_desde is distinct from old.vigente_desde
     or new.created_at is distinct from old.created_at
     or new.archivada_en is distinct from old.archivada_en then
    raise exception 'De la rutina de un socio solo se cambia el contenido (nombre, notas, días y ejercicios).'
      using errcode = 'GFR03';
  end if;

  if new.vigente_hasta is distinct from old.vigente_hasta
     and coalesce(current_setting('greenfit.cierre_rutina', true), '') <> 'on' then
    raise exception 'Una rutina pasa al historial solo cuando se le asigna otra al socio.'
      using errcode = 'GFR03';
  end if;

  return new;
end;
$$;

-- Días y ejercicios de una rutina anterior: solo lectura. Si la rutina ya no existe (se
-- está borrando la cuenta del socio, cascada), se deja pasar.
create function public.routine_days_proteger_historial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and rutina_es_historial(old.routine_id) then
    raise exception 'Esta rutina es del historial del socio: es de solo lectura.' using errcode = 'GFR01';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and rutina_es_historial(new.routine_id) then
    raise exception 'Esta rutina es del historial del socio: es de solo lectura.' using errcode = 'GFR01';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create function public.routine_exercises_proteger_historial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and rutina_es_historial(rutina_de_dia(old.day_id)) then
    raise exception 'Esta rutina es del historial del socio: es de solo lectura.' using errcode = 'GFR01';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and rutina_es_historial(rutina_de_dia(new.day_id)) then
    raise exception 'Esta rutina es del historial del socio: es de solo lectura.' using errcode = 'GFR01';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Tildar o destildar en una rutina que ya no es la vigente (la app del socio la tenía
-- abierta cuando Seba asignó otra): GFR01 -> la PWA recarga. Destildar sí pasa si se está
-- borrando la cuenta del socio.
create function public.routine_completions_proteger_historial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if rutina_es_historial(rutina_de_ejercicio(new.routine_exercise_id)) then
      raise exception 'Esa rutina ya no es la vigente: es de solo lectura.' using errcode = 'GFR01';
    end if;
    return new;
  end if;

  if rutina_es_historial(rutina_de_ejercicio(old.routine_exercise_id))
     and not socio_se_esta_borrando(old.user_id) then
    raise exception 'Esa rutina ya no es la vigente: es de solo lectura.' using errcode = 'GFR01';
  end if;
  return old;
end;
$$;

create trigger routines_abrir_vigencia
  before insert on public.routines
  for each row execute function public.routines_abrir_vigencia();
create trigger routines_proteger_historial
  before update or delete on public.routines
  for each row execute function public.routines_proteger_historial();
create trigger routine_days_proteger_historial
  before insert or update or delete on public.routine_days
  for each row execute function public.routine_days_proteger_historial();
create trigger routine_exercises_proteger_historial
  before insert or update or delete on public.routine_exercises
  for each row execute function public.routine_exercises_proteger_historial();
create trigger routine_completions_proteger_historial
  before insert or delete on public.routine_completions
  for each row execute function public.routine_completions_proteger_historial();

-- ── 4) Funciones del panel ──────────────────────────────────────────────────────────
-- Asigna como rutina vigente del socio una COPIA de una plantilla, o de una rutina anterior
-- del mismo socio ("volver a asignar"). Todo en una transacción: o queda la copia entera (y
-- la vigente anterior pasa al historial, por el trigger), o no cambia nada.
create function public.admin_asignar_rutina(p_user_id uuid, p_origen_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origen routines%rowtype;
  v_nueva uuid;
  v_dia record;
  v_dia_nuevo uuid;
begin
  if not is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.' using errcode = '42501';
  end if;
  if p_user_id is null or p_origen_id is null then
    raise exception 'Faltan datos para asignar la rutina.';
  end if;
  if not exists (select 1 from profiles where id = p_user_id) then
    raise exception 'No existe ese socio.';
  end if;

  select * into v_origen from routines where id = p_origen_id;
  if not found then
    raise exception 'Esa rutina ya no existe.';
  end if;
  if v_origen.archivada_en is not null then
    raise exception 'Esa rutina está archivada.';
  end if;
  if v_origen.user_id is null or coalesce(v_origen.is_template, false) then
    null; -- plantilla
  elsif v_origen.user_id = p_user_id then
    if v_origen.vigente_hasta is null then
      raise exception 'Esa ya es la rutina vigente del socio.';
    end if;
  else
    raise exception 'Solo se asigna una plantilla o una rutina del historial del mismo socio.';
  end if;
  if not exists (select 1 from routine_days rd join routine_exercises re on re.day_id = rd.id
                 where rd.routine_id = p_origen_id) then
    raise exception 'Esa rutina no tiene ejercicios: no se asigna vacía.';
  end if;

  insert into routines (user_id, title, coach_name, notes, is_template)
  values (p_user_id, v_origen.title, v_origen.coach_name, v_origen.notes, false)
  returning id into v_nueva;

  for v_dia in select * from routine_days where routine_id = p_origen_id order by order_index, id loop
    insert into routine_days (routine_id, title, order_index)
    values (v_nueva, v_dia.title, v_dia.order_index)
    returning id into v_dia_nuevo;

    insert into routine_exercises (day_id, exercise_id, sets, reps, rest_seconds, weight_suggestion, notes, order_index)
    select v_dia_nuevo, re.exercise_id, re.sets, re.reps, re.rest_seconds, re.weight_suggestion, re.notes, re.order_index
    from routine_exercises re
    where re.day_id = v_dia.id
    order by re.order_index, re.id;
  end loop;

  return v_nueva;
end;
$$;

-- Guarda una rutina del editor del panel. p_rutina:
--   { id, user_id, como_nueva, title, notes, [coach_name],
--     days: [ { id, title, exercises: [ { id, exercise_id, nuevo: {name, muscle_group,
--               description, video_url}, sets, reps, rest_seconds, weight_suggestion, notes } ] } ] }
-- * id null: crea (con user_id = rutina de ese socio, que pasa a ser su vigente; sin
--   user_id = plantilla).
-- * id + como_nueva: "Guardar como rutina nueva" (solo la vigente de un socio): crea otra
--   con lo editado; la actual pasa al historial TAL COMO ESTABA.
-- * id: "Guardar cambios" en el lugar. Días y ejercicios con id se ACTUALIZAN (conservan id
--   y tildes); sin id se insertan; los que ya no vienen se borran. Si un bloque cambió de
--   ejercicio, es una fila nueva y la vieja se borra. Pero si algo de lo que se borraría
--   (ejercicio, día con sus ejercicios, o la fila vieja de un bloque que cambió de ejercicio)
--   tiene tildes del socio, de CUALQUIER fecha, se rechaza todo con GFR04: borrarlo se
--   llevaría su registro. Para esos cambios está "Guardar como rutina nueva".
--   Nunca cambia el socio de una rutina. coach_name solo cambia si viene en p_rutina.
-- Ejercicio sin exercise_id: se crea en la biblioteca con los datos de "nuevo".
create function public.admin_guardar_rutina(p_rutina jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  c_cambio constant text := 'La rutina cambió mientras la editabas: cerrala y volvé a abrirla.';
  v_actual routines%rowtype;
  v_id uuid;
  v_user uuid;
  v_destino uuid;
  v_crear boolean;
  v_como_nueva boolean;
  v_titulo text;
  v_notas text;
  v_coach text;
  v_dias jsonb;
  v_dia jsonb;
  v_dia_idx int := 0;
  v_dia_id uuid;
  v_dia_titulo text;
  v_dias_quedan uuid[] := '{}';
  v_ej jsonb;
  v_ej_idx int;
  v_re_id uuid;
  v_ex_id uuid;
  v_ex_actual uuid;
  v_ej_quedan uuid[] := '{}';
  v_total int := 0;
begin
  if not is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.' using errcode = '42501';
  end if;
  if p_rutina is null or jsonb_typeof(p_rutina) <> 'object' then
    raise exception 'Formato de rutina inválido.';
  end if;

  v_titulo := nullif(left(btrim(p_rutina->>'title'), 200), '');
  if v_titulo is null then
    raise exception 'Ponele un nombre a la rutina.';
  end if;
  v_notas := nullif(btrim(p_rutina->>'notes'), '');
  v_coach := nullif(left(btrim(p_rutina->>'coach_name'), 120), '');
  v_como_nueva := coalesce((p_rutina->>'como_nueva')::boolean, false);

  v_dias := p_rutina->'days';
  if v_dias is null or jsonb_typeof(v_dias) <> 'array' or jsonb_array_length(v_dias) = 0 then
    raise exception 'Agregá al menos un día.';
  end if;
  if jsonb_array_length(v_dias) > 30 then
    raise exception 'Demasiados días en una rutina.';
  end if;
  for v_dia in select e.value from jsonb_array_elements(v_dias) as e loop
    if jsonb_typeof(v_dia) <> 'object' or jsonb_typeof(coalesce(v_dia->'exercises', '[]'::jsonb)) <> 'array' then
      raise exception 'Formato de día inválido.';
    end if;
    v_total := v_total + jsonb_array_length(coalesce(v_dia->'exercises', '[]'::jsonb));
  end loop;
  if v_total = 0 then
    raise exception 'La rutina tiene que tener al menos un ejercicio.';
  end if;
  if v_total > 300 then
    raise exception 'Demasiados ejercicios en una rutina.';
  end if;

  v_id := nullif(p_rutina->>'id', '')::uuid;
  if v_id is null then
    v_user := nullif(p_rutina->>'user_id', '')::uuid;
    if v_user is not null and not exists (select 1 from profiles where id = v_user) then
      raise exception 'No existe ese socio.';
    end if;
    v_crear := true;
  else
    select * into v_actual from routines where id = v_id for update;
    if not found then
      raise exception 'Esa rutina ya no existe.';
    end if;
    v_user := v_actual.user_id;
    if v_actual.user_id is not null and not coalesce(v_actual.is_template, false)
       and v_actual.vigente_hasta is not null then
      raise exception 'Esta rutina es del historial del socio: es de solo lectura.' using errcode = 'GFR01';
    end if;
    if v_como_nueva and (v_actual.user_id is null or coalesce(v_actual.is_template, false)) then
      raise exception '"Guardar como rutina nueva" es solo para la rutina de un socio.';
    end if;
    v_crear := v_como_nueva;
  end if;

  if v_crear then
    insert into routines (user_id, title, coach_name, notes, is_template)
    values (v_user, v_titulo,
            case when p_rutina ? 'coach_name' or v_actual.id is null then v_coach else v_actual.coach_name end,
            v_notas, v_user is null)
    returning id into v_destino;
  else
    v_destino := v_id;
    update routines
    set title = v_titulo,
        notes = v_notas,
        coach_name = case when p_rutina ? 'coach_name' then v_coach else coach_name end
    where id = v_destino;
  end if;

  for v_dia in select e.value from jsonb_array_elements(v_dias) with ordinality as e(value, i) order by e.i loop
    v_dia_titulo := coalesce(nullif(left(btrim(v_dia->>'title'), 120), ''), 'Día ' || (v_dia_idx + 1));
    v_dia_id := case when v_crear then null else nullif(v_dia->>'id', '')::uuid end;

    if v_dia_id is not null then
      if v_dia_id = any (v_dias_quedan)
         or not exists (select 1 from routine_days where id = v_dia_id and routine_id = v_destino) then
        raise exception '%', c_cambio;
      end if;
      update routine_days set title = v_dia_titulo, order_index = v_dia_idx where id = v_dia_id;
    else
      insert into routine_days (routine_id, title, order_index)
      values (v_destino, v_dia_titulo, v_dia_idx)
      returning id into v_dia_id;
    end if;
    v_dias_quedan := v_dias_quedan || v_dia_id;

    v_ej_idx := 0;
    for v_ej in select e.value from jsonb_array_elements(coalesce(v_dia->'exercises', '[]'::jsonb))
                with ordinality as e(value, i) order by e.i loop
      if jsonb_typeof(v_ej) <> 'object' then
        raise exception 'Formato de ejercicio inválido.';
      end if;

      v_ex_id := nullif(v_ej->>'exercise_id', '')::uuid;
      if v_ex_id is null then
        if nullif(btrim(v_ej #>> '{nuevo,name}'), '') is null then
          raise exception 'Completá el nombre del ejercicio en "%".', v_dia_titulo;
        end if;
        insert into exercises (name, muscle_group, description, video_url)
        values (btrim(v_ej #>> '{nuevo,name}'),
                v_ej #>> '{nuevo,muscle_group}',
                nullif(btrim(v_ej #>> '{nuevo,description}'), ''),
                nullif(btrim(v_ej #>> '{nuevo,video_url}'), ''))
        returning id into v_ex_id;
      end if;

      v_re_id := case when v_crear then null else nullif(v_ej->>'id', '')::uuid end;
      v_ex_actual := null;
      if v_re_id is not null then
        select re.exercise_id into v_ex_actual
        from routine_exercises re
        join routine_days rd on rd.id = re.day_id
        where re.id = v_re_id and rd.routine_id = v_destino;
        if not found or v_re_id = any (v_ej_quedan) then
          raise exception '%', c_cambio;
        end if;
      end if;

      if v_re_id is not null and v_ex_actual = v_ex_id then
        update routine_exercises
        set day_id = v_dia_id,
            sets = case when (v_ej->>'sets') ~ '^\d{1,4}$' and (v_ej->>'sets')::int > 0 then (v_ej->>'sets')::int end,
            reps = nullif(btrim(v_ej->>'reps'), ''),
            rest_seconds = case when (v_ej->>'rest_seconds') ~ '^\d{1,6}$' and (v_ej->>'rest_seconds')::int > 0
                                then (v_ej->>'rest_seconds')::int end,
            weight_suggestion = nullif(btrim(v_ej->>'weight_suggestion'), ''),
            notes = nullif(btrim(v_ej->>'notes'), ''),
            order_index = v_ej_idx
        where id = v_re_id;
      else
        insert into routine_exercises (day_id, exercise_id, sets, reps, rest_seconds, weight_suggestion, notes, order_index)
        values (v_dia_id, v_ex_id,
                case when (v_ej->>'sets') ~ '^\d{1,4}$' and (v_ej->>'sets')::int > 0 then (v_ej->>'sets')::int end,
                nullif(btrim(v_ej->>'reps'), ''),
                case when (v_ej->>'rest_seconds') ~ '^\d{1,6}$' and (v_ej->>'rest_seconds')::int > 0
                     then (v_ej->>'rest_seconds')::int end,
                nullif(btrim(v_ej->>'weight_suggestion'), ''),
                nullif(btrim(v_ej->>'notes'), ''),
                v_ej_idx)
        returning id into v_re_id;
      end if;
      v_ej_quedan := v_ej_quedan || v_re_id;
      v_ej_idx := v_ej_idx + 1;
    end loop;

    v_dia_idx := v_dia_idx + 1;
  end loop;

  if not v_crear then
    -- Lo que se va a borrar: los ejercicios que ya no vienen (incluye los de los días que se
    -- sacan, y la fila vieja de un bloque que cambió de ejercicio). Borrarlos cascadea a
    -- routine_completions: TODOS sus tildes, de todas las fechas. Si alguno tiene tildes, se
    -- rechaza el guardado entero (nada cambia: es una sola transacción) y el panel ofrece
    -- "Guardar como rutina nueva", que no borra nada. Sin tildes, se borra como siempre.
    if exists (
      select 1
      from routine_exercises re
      join routine_days rd on rd.id = re.day_id
      join routine_completions rc on rc.routine_exercise_id = re.id
      where rd.routine_id = v_destino and re.id <> all (v_ej_quedan)
    ) then
      raise exception 'Este cambio borraría el registro de la alumna. Usá «Guardar como rutina nueva».'
        using errcode = 'GFR04';
    end if;

    delete from routine_exercises re
    using routine_days rd
    where rd.id = re.day_id and rd.routine_id = v_destino and re.id <> all (v_ej_quedan);
    delete from routine_days where routine_id = v_destino and id <> all (v_dias_quedan);
  end if;

  return v_destino;
end;
$$;

-- ── 5) finalizar_entrenamiento (+ p_routine_id) y eliminar -> ocultar ──────────────
drop function public.finalizar_entrenamiento(text, integer, jsonb);

create function public.finalizar_entrenamiento(
  p_titulo_dia text,
  p_total_ejercicios int,
  p_items jsonb,
  p_routine_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_ahora timestamptz := now();
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_cantidad int;
  v_ultimo timestamptz;
  v_sesiones_hoy int;
  v_sesion_id uuid := gen_random_uuid();
  v_routine_id uuid;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Formato de ejercicios inválido';
  end if;

  v_cantidad := jsonb_array_length(p_items);
  if v_cantidad = 0 then
    raise exception 'Marcá al menos un ejercicio para finalizar';
  end if;
  if v_cantidad > 100 then
    raise exception 'Demasiados ejercicios en un solo entrenamiento';
  end if;
  if p_total_ejercicios is null or p_total_ejercicios < v_cantidad then
    raise exception 'Total de ejercicios inválido';
  end if;

  -- Historial de rutinas (F1): en qué rutina se hizo. La que manda la app (tiene que ser
  -- del socio; puede ser una que acaba de pasar al historial si la pantalla la tenía
  -- abierta: el entrenamiento se hizo en esa). Sin p_routine_id (PWA vieja): la vigente.
  if p_routine_id is not null then
    select r.id into v_routine_id
    from routines r
    where r.id = p_routine_id
      and r.user_id = v_user_id
      and not coalesce(r.is_template, false);
    if v_routine_id is null then
      raise exception 'Esa rutina no es tuya.' using errcode = '42501';
    end if;
  else
    select r.id into v_routine_id
    from routines r
    where r.user_id = v_user_id
      and not coalesce(r.is_template, false)
      and r.vigente_hasta is null;
  end if;

  -- Serializa las llamadas del mismo socio: dos requests simultáneos no
  -- pueden pasar los dos el chequeo de abajo.
  perform pg_advisory_xact_lock(hashtext('routine_history:' || v_user_id::text));

  select max(created_at) into v_ultimo
  from routine_history
  where user_id = v_user_id;

  if v_ultimo is not null and v_ultimo > v_ahora - interval '10 seconds' then
    return jsonb_build_object(
      'registrado', false,
      'sesion_id', null,
      'motivo', 'reciente',
      'disponible_desde', v_ultimo + interval '10 seconds'
    );
  end if;

  select count(distinct sesion_id) into v_sesiones_hoy
  from routine_history
  where user_id = v_user_id and fecha = v_hoy;

  if v_sesiones_hoy >= 20 then
    return jsonb_build_object(
      'registrado', false,
      'sesion_id', null,
      'motivo', 'tope_diario',
      'disponible_desde', null
    );
  end if;

  insert into routine_history (
    user_id, sesion_id, fecha, titulo_dia, nombre_ejercicio, grupo_muscular,
    series, repeticiones, peso, orden, total_ejercicios, completo, created_at, routine_id
  )
  select
    v_user_id,
    v_sesion_id,
    v_hoy,
    nullif(left(trim(p_titulo_dia), 120), ''),
    coalesce(nullif(left(trim(t.item->>'nombre'), 200), ''), 'Ejercicio'),
    nullif(left(trim(t.item->>'grupo'), 80), ''),
    case when (t.item->>'series') ~ '^\d{1,4}$' then (t.item->>'series')::int end,
    nullif(left(trim(t.item->>'repeticiones'), 40), ''),
    nullif(left(trim(t.item->>'peso'), 40), ''),
    (t.ord - 1)::int,
    p_total_ejercicios,
    v_cantidad = p_total_ejercicios,
    v_ahora,
    v_routine_id
  from jsonb_array_elements(p_items) with ordinality as t(item, ord);

  return jsonb_build_object(
    'registrado', true,
    'sesion_id', v_sesion_id,
    'motivo', null,
    'disponible_desde', v_ahora + interval '10 seconds'
  );
end;
$$;

-- "Eliminar" del socio: ya no borra. OCULTA la sesión (oculta_en); el admin la sigue
-- viendo. Mismo nombre y firma: la PWA en caché sigue andando. Devuelve cuántas filas
-- ocultó (0 = no existe, no es del socio que llama o ya estaba oculta).
create or replace function public.eliminar_sesion_historial(p_sesion_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_ocultadas int;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;
  if p_sesion_id is null then
    raise exception 'Falta la sesión a eliminar';
  end if;

  update routine_history
  set oculta_en = now()
  where sesion_id = p_sesion_id
    and user_id = v_user_id
    and oculta_en is null;
  get diagnostics v_ocultadas = row_count;

  return v_ocultadas;
end;
$$;

-- ── 6) Permisos ─────────────────────────────────────────────────────────────────────
-- drop + create = función NUEVA: sus permisos se dejan EXPLÍCITOS (no se confía en los
-- permisos por defecto): authenticated (la PWA) y service_role; ni PUBLIC ni anon. La G7
-- lo controla.
revoke all on function public.finalizar_entrenamiento(text, integer, jsonb, uuid) from public, anon;
grant execute on function public.finalizar_entrenamiento(text, integer, jsonb, uuid) to authenticated, service_role;

revoke all on function public.admin_asignar_rutina(uuid, uuid) from public, anon;
grant execute on function public.admin_asignar_rutina(uuid, uuid) to authenticated;
revoke all on function public.admin_guardar_rutina(jsonb) from public, anon;
grant execute on function public.admin_guardar_rutina(jsonb) to authenticated;

-- Auxiliares: solo las llaman los triggers, que son SECURITY DEFINER y corren como
-- postgres. Nadie más.
revoke all on function public.rutina_es_historial(uuid) from public, anon, authenticated;
revoke all on function public.socio_se_esta_borrando(uuid) from public, anon, authenticated;
revoke all on function public.rutina_de_dia(uuid) from public, anon, authenticated;
revoke all on function public.rutina_de_ejercicio(uuid) from public, anon, authenticated;
-- Funciones de trigger: mismo criterio que la Tanda C (las disparan authenticated -- la PWA
-- al tildar --, service_role o postgres, que conservan EXECUTE). Una función de trigger no
-- se puede llamar por /rpc.
revoke all on function public.routines_abrir_vigencia() from public, anon;
revoke all on function public.routines_proteger_historial() from public, anon;
revoke all on function public.routine_days_proteger_historial() from public, anon;
revoke all on function public.routine_exercises_proteger_historial() from public, anon;
revoke all on function public.routine_completions_proteger_historial() from public, anon;
grant execute on function public.routines_abrir_vigencia() to authenticated;
grant execute on function public.routines_proteger_historial() to authenticated;
grant execute on function public.routine_days_proteger_historial() to authenticated;
grant execute on function public.routine_exercises_proteger_historial() to authenticated;
grant execute on function public.routine_completions_proteger_historial() to authenticated;

-- routine_history: Seba (admin) lee todo; el socio, lo suyo.
drop policy routine_history_select_own on public.routine_history;
create policy routine_history_select_own_or_admin on public.routine_history
  for select using (auth.uid() = user_id or public.is_admin());

-- ── Respaldo de lo nuevo ────────────────────────────────────────────────────────────
update respaldo.historial_rutinas_f1_funciones f
set definicion_nueva = pg_get_functiondef(p.oid),
    huella_nueva = md5(pg_get_functiondef(p.oid)),
    permisos_nuevos = coalesce(p.proacl::text, 'NULL')
from pg_proc p
where f.funcion = 'public.finalizar_entrenamiento(text, integer, jsonb)'
  and p.oid = 'public.finalizar_entrenamiento(text, integer, jsonb, uuid)'::regprocedure;

update respaldo.historial_rutinas_f1_funciones f
set definicion_nueva = pg_get_functiondef(p.oid),
    huella_nueva = md5(pg_get_functiondef(p.oid)),
    permisos_nuevos = coalesce(p.proacl::text, 'NULL')
from pg_proc p
where f.funcion = 'public.eliminar_sesion_historial(uuid)'
  and p.oid = 'public.eliminar_sesion_historial(uuid)'::regprocedure;

-- ── G5 a G7: después ────────────────────────────────────────────────────────────────
do $despues$
declare
  k record;
  a record;
  v_n int;
  v_txt text;
  c_internas constant text[] := array[
    'public.rutina_es_historial(uuid)', 'public.rutina_de_dia(uuid)', 'public.rutina_de_ejercicio(uuid)',
    'public.socio_se_esta_borrando(uuid)'];
  -- authenticated sí, anon no: las del panel/PWA y las de trigger (criterio Tanda C).
  c_panel constant text[] := array[
    'public.admin_asignar_rutina(uuid, uuid)', 'public.admin_guardar_rutina(jsonb)',
    'public.finalizar_entrenamiento(text, integer, jsonb, uuid)', 'public.eliminar_sesion_historial(uuid)',
    'public.routines_abrir_vigencia()', 'public.routines_proteger_historial()',
    'public.routine_days_proteger_historial()', 'public.routine_exercises_proteger_historial()',
    'public.routine_completions_proteger_historial()'];
  v_f text;
begin
  select * into k from _hr;
  select * into a from _antes;

  -- G5
  select count(*) into v_n from public.routines
  where user_id is not null and not coalesce(is_template, false) and vigente_hasta is null;
  if v_n <> k.socios then
    raise exception 'Historial F1: quedaron % vigentes (se esperaba una por socio: %). Se deshace todo.', v_n, k.socios;
  end if;
  if (select count(distinct user_id) from public.routines
      where user_id is not null and not coalesce(is_template, false) and vigente_hasta is null) <> k.socios then
    raise exception 'Historial F1: algún socio quedó sin vigente. Se deshace todo.';
  end if;
  select count(*) into v_n from public.routines
  where user_id is not null and not coalesce(is_template, false) and vigente_hasta is not null;
  if v_n <> k.anteriores then
    raise exception 'Historial F1: quedaron % anteriores (se esperaba %). Se deshace todo.', v_n, k.anteriores;
  end if;
  if exists (select 1 from public.routines
             where user_id is not null and not coalesce(is_template, false)
               and (vigente_desde is distinct from created_at
                    or (vigente_hasta is not null and vigente_hasta < vigente_desde))) then
    raise exception 'Historial F1: alguna fecha recuperada no es la esperada. Se deshace todo.';
  end if;
  select count(*) into v_n from public.routines where archivada_en is not null;
  if v_n <> k.anteriores_vacias
     or exists (select 1 from public.routines r2
                where r2.archivada_en is not null
                  and (r2.vigente_hasta is null
                       or exists (select 1 from public.routine_days rd join public.routine_exercises re on re.day_id = rd.id
                                  where rd.routine_id = r2.id))) then
    raise exception 'Historial F1: las archivadas no son las % anteriores vacías (hay %). Se deshace todo.', k.anteriores_vacias, v_n;
  end if;
  if exists (select 1 from public.routines
             where (user_id is null or coalesce(is_template, false))
               and (vigente_desde is not null or vigente_hasta is not null or archivada_en is not null)) then
    raise exception 'Historial F1: alguna plantilla quedó con vigencia o archivada. Se deshace todo.';
  end if;
  if exists (select 1 from public.routine_history where routine_id is not null or oculta_en is not null) then
    raise exception 'Historial F1: routine_history quedó con routine_id u oculta_en. Se deshace todo.';
  end if;

  -- G6
  if pg_temp.hr_huella_contenido() <> a.huella_contenido then
    raise exception 'Historial F1: cambió el contenido de alguna tabla de rutinas (sin contar las columnas nuevas). Se deshace todo.';
  end if;

  -- G7: funciones nuevas y sus permisos
  foreach v_f in array c_panel loop
    if to_regprocedure(v_f) is null then
      raise exception 'Historial F1: no quedó creada %. Se deshace todo.', v_f;
    end if;
    if has_function_privilege('anon', to_regprocedure(v_f), 'EXECUTE')
       or not has_function_privilege('authenticated', to_regprocedure(v_f), 'EXECUTE') then
      raise exception 'Historial F1: permisos de % (anon no, authenticated sí). Se deshace todo.', v_f;
    end if;
  end loop;
  foreach v_f in array c_internas loop
    if to_regprocedure(v_f) is null then
      raise exception 'Historial F1: no quedó creada %. Se deshace todo.', v_f;
    end if;
    if has_function_privilege('anon', to_regprocedure(v_f), 'EXECUTE')
       or has_function_privilege('authenticated', to_regprocedure(v_f), 'EXECUTE') then
      raise exception 'Historial F1: % quedó llamable por anon/authenticated. Se deshace todo.', v_f;
    end if;
  end loop;
  if to_regprocedure('public.finalizar_entrenamiento(text, integer, jsonb)') is not null then
    raise exception 'Historial F1: sigue existiendo la finalizar_entrenamiento de 3 argumentos. Se deshace todo.';
  end if;
  -- finalizar (drop + create): permisos EXPLÍCITOS en su ACL. authenticated y service_role
  -- sí; ni PUBLIC (grantee 0) ni anon.
  select string_agg(g.nombre, ',' order by g.nombre) into v_txt
  from (select case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee)::text end as nombre
        from pg_proc p, aclexplode(p.proacl) x
        where p.oid = 'public.finalizar_entrenamiento(text, integer, jsonb, uuid)'::regprocedure
          and x.privilege_type = 'EXECUTE') g;
  if v_txt is null
     or position('authenticated' in v_txt) = 0 or position('service_role' in v_txt) = 0
     or position('PUBLIC' in v_txt) > 0 or v_txt ~ '(^|,)anon(,|$)' then
    raise exception 'Historial F1: permisos de finalizar_entrenamiento (EXECUTE para: %); se esperaba authenticated y service_role, sin PUBLIC ni anon. Se deshace todo.',
      coalesce(v_txt, 'nadie');
  end if;
  if (select coalesce(p.proacl::text, 'NULL') from pg_proc p
      where p.oid = 'public.eliminar_sesion_historial(uuid)'::regprocedure) <> a.permisos_eliminar then
    raise exception 'Historial F1: cambiaron los permisos de eliminar_sesion_historial. Se deshace todo.';
  end if;

  -- G7: el respaldo quedó completo (lo necesita el rollback)
  if (select count(*) from respaldo.historial_rutinas_f1_funciones
      where funcion in ('public.finalizar_entrenamiento(text, integer, jsonb)', 'public.eliminar_sesion_historial(uuid)')
        and definicion_antes is not null and huella_nueva is not null and permisos_nuevos is not null) <> 2
     or (select count(*) from respaldo.historial_rutinas_f1_politicas where tabla = 'routine_history') <> 1
     or (select count(*) from respaldo.historial_rutinas_f1_archivadas) <> k.anteriores_vacias then
    raise exception 'Historial F1: el respaldo quedó incompleto. Se deshace todo.';
  end if;

  -- G7: ninguna otra función cambió
  select count(*) into v_n
  from _funcs_antes f
  left join pg_proc p on p.oid = f.oid
  where p.oid is null or coalesce(p.proacl::text, 'NULL') || '=' || md5(coalesce(p.prosrc, '')) <> f.huella;
  if v_n > 0 then
    raise exception 'Historial F1: cambiaron % funciones que no son de esta migración. Se deshace todo.', v_n;
  end if;

  -- G7: policies
  if (select md5(coalesce(string_agg(format('%s|%s|%s|%s|%s|%s|%s', schemaname, tablename, policyname, permissive,
                                            roles, cmd, coalesce(qual, '') || '/' || coalesce(with_check, '')),
                                     ';' order by schemaname, tablename, policyname), ''))
      from pg_policies where not (schemaname = 'public' and tablename = 'routine_history')) <> a.huella_otras_policies then
    raise exception 'Historial F1: cambió alguna policy que no es la de routine_history. Se deshace todo.';
  end if;
  select string_agg(policyname || ':' || cmd, ', ' order by policyname) into v_txt
  from pg_policies where schemaname = 'public' and tablename = 'routine_history';
  if v_txt is distinct from 'routine_history_select_own_or_admin:SELECT' then
    raise exception 'Historial F1: policies de routine_history: % (se esperaba routine_history_select_own_or_admin:SELECT). Se deshace todo.', v_txt;
  end if;

  -- G7: triggers = los de antes + los 5 nuevos, todos activos
  select coalesce(string_agg(tgrelid::regclass::text || '.' || tgname, ',' order by tgrelid::regclass::text, tgname), '')
    into v_txt
  from pg_trigger
  where not tgisinternal
    and tgrelid in ('public.routines'::regclass, 'public.routine_days'::regclass, 'public.routine_exercises'::regclass,
                    'public.routine_completions'::regclass, 'public.routine_history'::regclass)
    and tgname not in ('routines_abrir_vigencia', 'routines_proteger_historial', 'routine_days_proteger_historial',
                       'routine_exercises_proteger_historial', 'routine_completions_proteger_historial');
  if v_txt <> a.triggers_antes then
    raise exception 'Historial F1: cambiaron los triggers que ya existían (antes: %; ahora: %). Se deshace todo.', a.triggers_antes, v_txt;
  end if;
  select count(*) into v_n from pg_trigger
  where tgname in ('routines_abrir_vigencia', 'routines_proteger_historial', 'routine_days_proteger_historial',
                   'routine_exercises_proteger_historial', 'routine_completions_proteger_historial')
    and tgenabled <> 'D';
  if v_n <> 5 then
    raise exception 'Historial F1: quedaron % triggers nuevos activos (se esperaban 5). Se deshace todo.', v_n;
  end if;

  raise notice 'Historial F1 aplicada: % vigentes, % anteriores (% archivadas por vacías). finalizar_entrenamiento: % (permisos %, antes %). eliminar_sesion_historial: %.',
    k.socios, k.anteriores, k.anteriores_vacias,
    (select huella_nueva from respaldo.historial_rutinas_f1_funciones where funcion = 'public.finalizar_entrenamiento(text, integer, jsonb)'),
    (select permisos_nuevos from respaldo.historial_rutinas_f1_funciones where funcion = 'public.finalizar_entrenamiento(text, integer, jsonb)'),
    (select permisos_antes from respaldo.historial_rutinas_f1_funciones where funcion = 'public.finalizar_entrenamiento(text, integer, jsonb)'),
    (select huella_nueva from respaldo.historial_rutinas_f1_funciones where funcion = 'public.eliminar_sesion_historial(uuid)');
end;
$despues$;

drop function pg_temp.hr_huella_contenido();

-- Que la API (PostgREST) vea las columnas y funciones nuevas enseguida.
notify pgrst, 'reload schema';

commit;
