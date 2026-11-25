-- =====================================================================================
-- ROLLBACK del historial de rutinas, Fase 1 (supabase_migration_historial_rutinas_f1.sql).
-- NO SE CORRIÓ TODAVÍA. ESTAMOS EN PRODUCCIÓN. Solo si la prueba falla.
--
-- ANTES de correrlo: si el Dashboard o la PWA de la Fase 1 ya se publicaron, volverlos
-- atrás primero (leen las columnas y funciones nuevas).
--
-- Vuelve todo a como estaba, desde el respaldo:
--   * finalizar_entrenamiento: borra la de 4 argumentos y ejecuta tal cual la definición de
--     antes (3 argumentos), con los permisos EXACTOS de antes.
--   * eliminar_sesion_historial: la definición de antes (vuelve a BORRAR).
--   * routine_history: la policy de antes (solo lo propio).
--   * Saca los 5 triggers, las funciones nuevas, el índice único, el CHECK y las columnas
--     nuevas (routines.vigente_desde/vigente_hasta/archivada_en, routine_history.routine_id/
--     oculta_en).
--
-- Ninguna FILA se borra ni se modifica. Lo que se pierde son las columnas:
--   * Las sesiones que un socio "eliminó" después de la migración estaban OCULTAS, no
--     borradas: le vuelven a aparecer (el rollback avisa cuántas).
--   * Las rutinas creadas después (asignaciones, "guardar como nueva", "volver a asignar")
--     quedan. La app de antes toma como vigente la más nueva por created_at: es la misma.
--   * Las 9 archivadas vuelven a ser anteriores comunes (vacías), como antes. Sus ids quedan
--     en respaldo.historial_rutinas_f1_archivadas.
--   * El routine_id de las sesiones registradas después de la migración.
-- El respaldo queda guardado. Para volver a correr la migración hay que renombrar o borrar
-- las tablas respaldo.historial_rutinas_f1_* (la G0 de la migración no corre si existen).
--
-- Guardas (si alguna falla, no se hace nada):
--   G1) Existe el respaldo (las dos funciones y la policy).
--   G2) finalizar_entrenamiento (4 args) y eliminar_sesion_historial son las que dejó la
--       migración (huella_nueva); la policy de routine_history es la nueva. Si alguien las
--       cambió después, no se pisa nada.
--   DESPUÉS:
--   G3) finalizar (3 args) y eliminar vuelven a la huella de antes (si solo difieren en
--       espacios, se acepta y se avisa), con los permisos de antes; no existe la de 4 args.
--   G4) No queda nada de la migración: columnas, triggers, funciones, índice, CHECK. La
--       policy de routine_history es la de antes.
--   G5) El contenido de las tablas de rutinas (sin las columnas que se sacan) no cambió.
-- =====================================================================================

begin;

do $rollback$
declare
  v_fin record;
  v_eli record;
  v_pol record;
  v_def text;
  v_txt text;
  v_ocultas int;
  v_huella_antes text;
  v_huella_despues text;
  a record;
  c_fin_vieja constant text := 'public.finalizar_entrenamiento(text, integer, jsonb)';
  c_fin_nueva constant text := 'public.finalizar_entrenamiento(text, integer, jsonb, uuid)';
  c_eli       constant text := 'public.eliminar_sesion_historial(uuid)';
begin
  -- G1
  if to_regclass('respaldo.historial_rutinas_f1_funciones') is null
     or to_regclass('respaldo.historial_rutinas_f1_politicas') is null then
    raise exception 'Rollback historial F1: no existe el respaldo. No se hizo nada.';
  end if;
  select * into v_fin from respaldo.historial_rutinas_f1_funciones where funcion = c_fin_vieja;
  select * into v_eli from respaldo.historial_rutinas_f1_funciones where funcion = c_eli;
  select * into v_pol from respaldo.historial_rutinas_f1_politicas where tabla = 'routine_history';
  if v_fin.funcion is null or v_eli.funcion is null or v_pol.tabla is null then
    raise exception 'Rollback historial F1: el respaldo está incompleto (funciones o policy). No se hizo nada.';
  end if;
  if v_fin.permisos_antes = 'NULL' or v_eli.permisos_antes = 'NULL' then
    raise exception 'Rollback historial F1: el respaldo tiene permisos por defecto (NULL); no se esperaba. No se hizo nada.';
  end if;

  -- G2
  if to_regprocedure(c_fin_nueva) is null
     or md5(pg_get_functiondef(to_regprocedure(c_fin_nueva))) is distinct from v_fin.huella_nueva then
    raise exception 'Rollback historial F1: finalizar_entrenamiento no es la que dejó la migración. No se hizo nada.';
  end if;
  if md5(pg_get_functiondef(to_regprocedure(c_eli))) is distinct from v_eli.huella_nueva then
    raise exception 'Rollback historial F1: eliminar_sesion_historial no es la que dejó la migración. No se hizo nada.';
  end if;
  select string_agg(policyname || ':' || cmd, ', ' order by policyname) into v_txt
  from pg_policies where schemaname = 'public' and tablename = 'routine_history';
  if v_txt is distinct from v_pol.nombre_nueva || ':SELECT' then
    raise exception 'Rollback historial F1: las policies de routine_history no son las que dejó la migración (hay: %). No se hizo nada.',
      coalesce(v_txt, 'ninguna');
  end if;

  -- Foto de antes del rollback
  select md5(
       coalesce((select string_agg(x, ',' order by x) from (
         select (to_jsonb(r) - 'vigente_desde' - 'vigente_hasta' - 'archivada_en')::text as x from public.routines r) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(d)::text as x from public.routine_days d) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(e)::text as x from public.routine_exercises e) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(c)::text as x from public.routine_completions c) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (
         select (to_jsonb(h) - 'routine_id' - 'oculta_en')::text as x from public.routine_history h) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(w)::text as x from public.user_exercise_weights w) s), '-'))
    into v_huella_antes;
  select count(distinct sesion_id) into v_ocultas from public.routine_history where oculta_en is not null;

  -- 1) Triggers
  drop trigger routines_abrir_vigencia on public.routines;
  drop trigger routines_proteger_historial on public.routines;
  drop trigger routine_days_proteger_historial on public.routine_days;
  drop trigger routine_exercises_proteger_historial on public.routine_exercises;
  drop trigger routine_completions_proteger_historial on public.routine_completions;

  -- 2) Funciones nuevas
  drop function public.admin_asignar_rutina(uuid, uuid);
  drop function public.admin_guardar_rutina(jsonb);
  drop function public.routines_abrir_vigencia();
  drop function public.routines_proteger_historial();
  drop function public.routine_days_proteger_historial();
  drop function public.routine_exercises_proteger_historial();
  drop function public.routine_completions_proteger_historial();
  drop function public.rutina_es_historial(uuid);
  drop function public.socio_se_esta_borrando(uuid);
  drop function public.rutina_de_dia(uuid);
  drop function public.rutina_de_ejercicio(uuid);

  -- 3) finalizar_entrenamiento: la de antes, con los permisos exactos de antes
  drop function public.finalizar_entrenamiento(text, integer, jsonb, uuid);
  execute v_fin.definicion_antes;
  revoke all on function public.finalizar_entrenamiento(text, integer, jsonb) from public, anon, authenticated, service_role;
  for a in select * from aclexplode(v_fin.permisos_antes::aclitem[]) loop
    if a.privilege_type = 'EXECUTE' then
      execute format('grant execute on function public.finalizar_entrenamiento(text, integer, jsonb) to %s',
                     case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end);
    end if;
  end loop;

  -- 4) eliminar_sesion_historial: la de antes (create or replace conserva los permisos)
  execute v_eli.definicion_antes;

  -- 5) Policy de routine_history
  execute format('drop policy %I on public.routine_history', v_pol.nombre_nueva);
  execute v_pol.definicion_antes;

  -- 6) Índices, CHECK y columnas
  drop index public.routine_history_routine_idx;
  alter table public.routine_history drop column routine_id, drop column oculta_en;
  drop index public.routines_una_vigente_por_socio;
  alter table public.routines drop constraint routines_vigencia_coherente;
  alter table public.routines drop column vigente_desde, drop column vigente_hasta, drop column archivada_en;

  -- G3
  if to_regprocedure(c_fin_nueva) is not null or to_regprocedure(c_fin_vieja) is null then
    raise exception 'Rollback historial F1: finalizar_entrenamiento no quedó como antes (3 args). Se deshace todo.';
  end if;
  v_def := pg_get_functiondef(to_regprocedure(c_fin_vieja));
  if md5(v_def) <> v_fin.huella_antes then
    if md5(regexp_replace(v_def, '\s+', '', 'g')) <> md5(regexp_replace(v_fin.definicion_antes, '\s+', '', 'g')) then
      raise exception 'Rollback historial F1: finalizar_entrenamiento no volvió a la definición de antes. Se deshace todo.';
    end if;
    raise notice 'Rollback historial F1: finalizar_entrenamiento volvió a la de antes (difiere solo en espacios).';
  end if;
  if (select array_agg(x::text order by x::text) from pg_proc p, unnest(p.proacl) x where p.oid = to_regprocedure(c_fin_vieja))
     is distinct from (select array_agg(x::text order by x::text) from unnest(v_fin.permisos_antes::aclitem[]) x) then
    raise exception 'Rollback historial F1: los permisos de finalizar_entrenamiento no son los de antes (%; antes %). Se deshace todo.',
      (select coalesce(p.proacl::text, 'NULL') from pg_proc p where p.oid = to_regprocedure(c_fin_vieja)), v_fin.permisos_antes;
  end if;
  v_def := pg_get_functiondef(to_regprocedure(c_eli));
  if md5(v_def) <> v_eli.huella_antes then
    if md5(regexp_replace(v_def, '\s+', '', 'g')) <> md5(regexp_replace(v_eli.definicion_antes, '\s+', '', 'g')) then
      raise exception 'Rollback historial F1: eliminar_sesion_historial no volvió a la definición de antes. Se deshace todo.';
    end if;
    raise notice 'Rollback historial F1: eliminar_sesion_historial volvió a la de antes (difiere solo en espacios).';
  end if;
  if (select coalesce(p.proacl::text, 'NULL') from pg_proc p where p.oid = to_regprocedure(c_eli)) <> v_eli.permisos_antes then
    raise exception 'Rollback historial F1: los permisos de eliminar_sesion_historial no son los de antes. Se deshace todo.';
  end if;

  -- G4
  if exists (select 1 from information_schema.columns
             where table_schema = 'public'
               and ((table_name = 'routines' and column_name in ('vigente_desde', 'vigente_hasta', 'archivada_en'))
                 or (table_name = 'routine_history' and column_name in ('routine_id', 'oculta_en')))) then
    raise exception 'Rollback historial F1: quedaron columnas de la migración. Se deshace todo.';
  end if;
  if exists (select 1 from pg_trigger
             where tgname in ('routines_abrir_vigencia', 'routines_proteger_historial', 'routine_days_proteger_historial',
                              'routine_exercises_proteger_historial', 'routine_completions_proteger_historial')) then
    raise exception 'Rollback historial F1: quedaron triggers de la migración. Se deshace todo.';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('admin_asignar_rutina', 'admin_guardar_rutina', 'routines_abrir_vigencia',
                                 'routines_proteger_historial', 'routine_days_proteger_historial',
                                 'routine_exercises_proteger_historial', 'routine_completions_proteger_historial',
                                 'rutina_es_historial', 'socio_se_esta_borrando', 'rutina_de_dia', 'rutina_de_ejercicio')) then
    raise exception 'Rollback historial F1: quedaron funciones de la migración. Se deshace todo.';
  end if;
  if to_regclass('public.routines_una_vigente_por_socio') is not null
     or to_regclass('public.routine_history_routine_idx') is not null
     or exists (select 1 from pg_constraint where conname = 'routines_vigencia_coherente') then
    raise exception 'Rollback historial F1: quedó el índice o el CHECK de la migración. Se deshace todo.';
  end if;
  select string_agg(policyname || ':' || cmd, ', ' order by policyname) into v_txt
  from pg_policies where schemaname = 'public' and tablename = 'routine_history';
  if v_txt is distinct from v_pol.nombre_antes || ':SELECT' then
    raise exception 'Rollback historial F1: la policy de routine_history no volvió (hay: %). Se deshace todo.', coalesce(v_txt, 'ninguna');
  end if;

  -- G5
  select md5(
       coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(r)::text as x from public.routines r) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(d)::text as x from public.routine_days d) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(e)::text as x from public.routine_exercises e) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(c)::text as x from public.routine_completions c) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(h)::text as x from public.routine_history h) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(w)::text as x from public.user_exercise_weights w) s), '-'))
    into v_huella_despues;
  if v_huella_despues <> v_huella_antes then
    raise exception 'Rollback historial F1: cambió el contenido de alguna tabla de rutinas. Se deshace todo.';
  end if;

  raise notice 'Rollback historial F1 aplicado. finalizar_entrenamiento (3 args) %, eliminar_sesion_historial % (vuelve a borrar). % sesión(es) que estaban ocultas vuelven a verse en la PWA.',
    md5(pg_get_functiondef(to_regprocedure(c_fin_vieja))), md5(pg_get_functiondef(to_regprocedure(c_eli))), v_ocultas;
end;
$rollback$;

notify pgrst, 'reload schema';

commit;
