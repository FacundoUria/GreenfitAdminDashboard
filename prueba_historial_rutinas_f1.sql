-- =====================================================================================
-- PRUEBA del historial de rutinas, Fase 1 (supabase_migration_historial_rutinas_f1.sql).
-- Correr DESPUÉS de la migración. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA EN LA BASE: los casos van en una subtransacción que se deshace SIEMPRE. Crean
-- filas PROPIAS: ejercicios "PRUEBA HR ...", plantillas "PRUEBA HR ...", rutinas asignadas a
-- la cuenta de test, tildes y entrenamientos de esa cuenta. El caso (m) borra la cuenta de
-- test DENTRO de una subtransacción que se deshace en el acto (nadie más lo ve). El caso (z)
-- confirma que todo quedó igual que antes. Lo único que sobrevive es el log (tabla temporal).
--
-- La sesión simulada es la del socio de test o la del primer admin de profiles
-- (request.jwt.claims local a la transacción). Las lecturas con RLS van con
-- "set local role authenticated", cada una en su propia subtransacción.
--
-- CASOS
--   (p)  Permisos: admin_asignar_rutina / admin_guardar_rutina / finalizar (4 args) y las
--        funciones de trigger: anon no, authenticated sí; finalizar además service_role sí
--        y sin PUBLIC en su ACL; la finalizar de 3 args no existe; las auxiliares:
--        authenticated no.
--   (a0) admin_guardar_rutina sin socio -> plantilla (sin vigencia), con sus 3 ejercicios.
--   (a)  Asignar la plantilla -> copia exacta, una sola vigente; si la cuenta tenía rutina,
--        pasa al historial con fecha de fin = inicio de la nueva.
--   (a2) Asignar otra vez -> la de (a) pasa al historial; sigue habiendo una sola vigente.
--   (b)  El socio no puede asignar ni guardar rutinas (42501).
--   (c)  Rutina anterior, solo lectura: editar la cabecera, agregar un día, editar un
--        ejercicio, borrar un día, guardarla con el editor -> GFR01; no cambió nada.
--   (d)  Borrar una rutina de socio (vigente o anterior) -> GFR02; cambiarla de socio o
--        cerrarla a mano -> GFR03; una plantilla todavía se puede borrar (Fase 2: archivar).
--   (e)  "Guardar cambios": los ejercicios que siguen conservan su id y el tilde de hoy;
--        se actualizan series/reps/carga/descanso; el día renombrado conserva su id.
--   (f)  En el mismo guardado, con bloques SIN tildes: el que cambió de ejercicio es una
--        fila nueva; el ejercicio quitado se borra; uno nuevo se crea en la biblioteca; el
--        día nuevo se agrega al final.
--   (f2) Con tildes -> GFR04 "Este cambio borraría el registro de la alumna..." y no cambia
--        nada: sacar un ejercicio con tildes; cambiar el ejercicio de un bloque con tildes;
--        sacar un día cuyos ejercicios tienen tildes. Sacar un día SIN tildes: se borra.
--   (g)  "Guardar como rutina nueva": otra rutina vigente con lo editado; la anterior pasa al
--        historial INTACTA (mismos ids y contenido) y conserva su tilde.
--   (h)  "Volver a asignar" una anterior -> copia exacta como vigente. No se puede volver a
--        asignar la vigente, ni una rutina de otro socio, ni una archivada.
--   (i)  Tildar en la vigente -> anda; tildar o destildar en una anterior -> GFR01.
--   (j1) Finalizar con la rutina vigente -> las filas quedan con ese routine_id.
--   (j2) Finalizar sin p_routine_id -> la vigente.
--   (j3) Llamada vieja (3 argumentos con nombre, PWA en caché) -> anda, con la vigente.
--   (j4) Finalizar en una rutina anterior propia (pantalla vieja) -> queda con esa.
--   (j5) Finalizar con la rutina de OTRO socio -> 42501.
--   (k)  "Eliminar" una sesión: se oculta (oculta_en), no se borra; la segunda vez devuelve 0;
--        otro usuario no la puede ocultar.
--   (l)  Lectura (RLS): el socio ve su sesión (también oculta), sus rutinas anteriores y sus
--        días; el admin ve las sesiones y rutinas del socio; otro socio no ve la sesión.
--   (l4) El socio NO ve rutinas de otro socio. Si esto FALLA no es de esta migración (no toca
--        la policy de routines): la policy de producción ya lo permitía. No hace falta rollback;
--        se cierra aparte.
--   (m)  Borrar la cuenta del socio se lleva sus rutinas (los triggers no lo frenan).
--        SALTEADO si borrar la cuenta de test falla por otra razón que ya existía.
--   (z)  No quedó nada.
-- Resultado esperado: 23 OK, 0 FALLA (algún SALTEADO posible: (j5)/(l4) sin otro socio con
-- rutina vigente, (j*)/(k)/(l) si la cuenta de test ya tiene 20 entrenamientos hoy, o (m)).
-- =====================================================================================
begin;

drop table if exists pg_temp._log;
create temp table _log (n bigserial primary key, caso text, linea text);

-- Huella de TODO lo que la prueba puede tocar (se compara en (z)).
create function pg_temp.hr_huella() returns text
language sql stable as $f$
  select md5(
       coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(t)::text as x from public.routines t) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(t)::text as x from public.routine_days t) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(t)::text as x from public.routine_exercises t) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(t)::text as x from public.routine_completions t) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(t)::text as x from public.routine_history t) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(t)::text as x from public.user_exercise_weights t) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(t)::text as x from public.exercises t) s), '-')
    || '|' || coalesce((select string_agg(x, ',' order by x) from (select to_jsonb(t)::text as x from public.profiles t
                                                                    where t.dni = '44537978') s), '-'))
$f$;

do $prueba$
declare
  c_fin     constant text := 'FIN_CASOS_HR';
  c_grupo   constant text := 'Piernas';
  v_user    uuid;
  v_admin   uuid;
  v_otro    uuid;
  v_otra_rutina uuid;
  v_archivada uuid;
  v_hoy     date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_huella_antes text;
  v_huella_despues text;
  v_ex      uuid[];
  v_plantilla uuid;
  v_plantilla2 uuid;
  v_r0 uuid; v_r1 uuid; v_r2 uuid; v_r3 uuid; v_r4 uuid;
  v_da uuid; v_db uuid;
  v_re_a uuid; v_re_b uuid; v_re_c uuid;
  v_x uuid; v_y uuid;
  v_huella_r1 text;
  v_huella_r2 text;
  v_payload jsonb;
  v_base    jsonb;
  v_res     jsonb;
  v_sesion  uuid;
  v_id      uuid;
  v_n int; v_m int; v_k int;
  r1 text; r2 text; r3 text; r4 text; r5 text; r6 text; r7 text;
  v_ok boolean;
  v_txt text;
  v_sqlstate text;
  v_fk record;
  -- El log se junta en arrays (ok null = SALTEADO): sobreviven a la subtransacción.
  v_casos  text[]    := '{}';
  v_oks    boolean[] := '{}';
  v_textos text[]    := '{}';
begin
  -- ── Preparación (fuera de la subtransacción) ──────────────────────────────────────
  if to_regclass('respaldo.historial_rutinas_f1_funciones') is null then
    raise exception 'Falta correr supabase_migration_historial_rutinas_f1.sql';
  end if;
  select id into v_user from profiles where dni = '44537978';
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  select id into v_admin from profiles where role = 'admin' order by created_at limit 1;
  if v_admin is null then
    raise exception 'No hay ningún perfil admin.';
  end if;
  -- Otro socio con rutina vigente: solo se LEE (casos "ajenos").
  select r.user_id, r.id into v_otro, v_otra_rutina
  from routines r
  where r.user_id is not null and r.user_id <> v_user and r.user_id <> v_admin
    and not coalesce(r.is_template, false) and r.vigente_hasta is null
  order by r.created_at
  limit 1;
  select r.id into v_archivada from routines r where r.archivada_en is not null order by r.created_at limit 1;
  select r.id into v_r0 from routines r
  where r.user_id = v_user and not coalesce(r.is_template, false) and r.vigente_hasta is null;

  v_huella_antes := pg_temp.hr_huella();

  -- ── (p) Permisos ────────────────────────────────────────────────────────────────────
  v_ok := not has_function_privilege('anon', 'public.admin_asignar_rutina(uuid, uuid)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.admin_asignar_rutina(uuid, uuid)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.admin_guardar_rutina(jsonb)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.admin_guardar_rutina(jsonb)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.finalizar_entrenamiento(text, integer, jsonb, uuid)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.finalizar_entrenamiento(text, integer, jsonb, uuid)', 'EXECUTE')
      and has_function_privilege('service_role', 'public.finalizar_entrenamiento(text, integer, jsonb, uuid)', 'EXECUTE')
      and not exists (select 1 from pg_proc p, aclexplode(p.proacl) x
                      where p.oid = 'public.finalizar_entrenamiento(text, integer, jsonb, uuid)'::regprocedure
                        and x.grantee = 0)
      and to_regprocedure('public.finalizar_entrenamiento(text, integer, jsonb)') is null
      and not has_function_privilege('anon', 'public.routine_completions_proteger_historial()', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.routine_completions_proteger_historial()', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.rutina_es_historial(uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.socio_se_esta_borrando(uuid)', 'EXECUTE');
  v_casos := v_casos || 'p'::text; v_oks := v_oks || v_ok;
  v_textos := v_textos || case when v_ok
    then 'panel, finalizar (4 args) y triggers: anon no / authenticated sí; finalizar: service_role sí y sin PUBLIC; la de 3 args no existe; auxiliares cerradas'
    else 'los permisos NO son los esperados' end;

  -- ── Casos: subtransacción que se deshace al final ─────────────────────────────────
  begin
    create function pg_temp.hr_como(p_id uuid) returns void language sql as $f$
      select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true),
             set_config('request.jwt.claim.sub', p_id::text, true);
      select null::void;
    $f$;

    -- Ejecuta un SQL: 'anduvo' o "<sqlstate> <mensaje>" (cada intento en su subtransacción).
    create function pg_temp.hr_intentar(p_sql text) returns text language plpgsql as $f$
    begin
      execute p_sql;
      return 'anduvo';
    exception when others then
      return sqlstate || ' ' || sqlerrm;
    end $f$;

    -- Lee como un usuario de la app (rol authenticated + JWT), con RLS. Devuelve el valor o
    -- 'ERROR ...'. Siempre se deshace (también el "set local role").
    create function pg_temp.hr_leer_como(p_user uuid, p_sql text) returns text language plpgsql as $f$
    declare
      v text;
      resultado text;
    begin
      begin
        execute 'set local role authenticated';
        perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
        perform set_config('request.jwt.claim.sub', p_user::text, true);
        execute p_sql into v;
        resultado := v;
        raise exception 'DESHACER' using errcode = 'P0999';
      exception
        when sqlstate 'P0999' then null;
        when others then resultado := 'ERROR ' || sqlstate || ' ' || sqlerrm;
      end;
      return resultado;
    end $f$;

    -- Contenido de una rutina SIN ids (para comparar copias).
    create function pg_temp.hr_contenido(p_routine uuid) returns text language sql stable as $f$
      select md5(coalesce(string_agg(concat_ws('|', rd.title, rd.order_index, re.exercise_id, re.sets, re.reps,
                                               re.rest_seconds, re.weight_suggestion, re.notes, re.order_index),
                                     ';' order by rd.order_index, re.order_index), '-'))
      from public.routine_days rd
      left join public.routine_exercises re on re.day_id = rd.id
      where rd.routine_id = p_routine
    $f$;

    -- Contenido CON ids (para "quedó intacta"); de la cabecera se ignora vigente_hasta.
    create function pg_temp.hr_contenido_ids(p_routine uuid) returns text language sql stable as $f$
      select md5(coalesce((select (to_jsonb(r) - 'vigente_hasta')::text from public.routines r where r.id = p_routine), '-')
                 || coalesce((select string_agg(to_jsonb(rd)::text || coalesce(to_jsonb(re)::text, ''), ';'
                                                order by rd.id, re.id)
                              from public.routine_days rd
                              left join public.routine_exercises re on re.day_id = rd.id
                              where rd.routine_id = p_routine), '-'))
    $f$;

    -- Lo que mandaría el editor para "Guardar cambios" de una rutina tal como está en la
    -- base, sin los ejercicios p_sin_re ni los días p_sin_dias, y con el bloque p_cambiar_re
    -- pasado al ejercicio p_nuevo_ex.
    create function pg_temp.hr_payload(p_routine uuid, p_sin_re uuid[], p_sin_dias uuid[],
                                       p_cambiar_re uuid, p_nuevo_ex uuid) returns jsonb
    language sql stable as $f$
      select jsonb_build_object(
        'id', r.id, 'title', r.title, 'notes', r.notes, 'como_nueva', false,
        'days', (select jsonb_agg(jsonb_build_object(
                   'id', d.id, 'title', d.title,
                   'exercises', coalesce((select jsonb_agg(jsonb_build_object(
                                   'id', e.id,
                                   'exercise_id', case when e.id = p_cambiar_re then p_nuevo_ex else e.exercise_id end,
                                   'sets', e.sets, 'reps', e.reps, 'rest_seconds', e.rest_seconds,
                                   'weight_suggestion', e.weight_suggestion, 'notes', e.notes) order by e.order_index)
                                 from public.routine_exercises e
                                 where e.day_id = d.id and e.id <> all (p_sin_re)), '[]'::jsonb))
                   order by d.order_index)
                 from public.routine_days d
                 where d.routine_id = r.id and d.id <> all (p_sin_dias)))
      from public.routines r
      where r.id = p_routine
    $f$;

    -- Datos propios: 4 ejercicios de prueba.
    insert into exercises (name, muscle_group)
    select 'PRUEBA HR ' || g || ' ' || gen_random_uuid(), c_grupo from generate_series(1, 4) g;
    select array_agg(id order by name) into v_ex from exercises where name like 'PRUEBA HR %';

    -- (a0) Plantilla creada con admin_guardar_rutina.
    begin
      perform pg_temp.hr_como(v_admin);
      v_base := jsonb_build_object(
        'id', null, 'user_id', null, 'como_nueva', false,
        'title', 'PRUEBA HR plantilla', 'notes', 'nota de prueba',
        'days', jsonb_build_array(
          jsonb_build_object('id', null, 'title', 'Día A', 'exercises', jsonb_build_array(
            jsonb_build_object('id', null, 'exercise_id', v_ex[1], 'sets', 4, 'reps', '10', 'rest_seconds', 60,
                               'weight_suggestion', '20kg', 'notes', null),
            jsonb_build_object('id', null, 'exercise_id', v_ex[2], 'sets', 3, 'reps', '12', 'rest_seconds', null,
                               'weight_suggestion', null, 'notes', 'lento'))),
          jsonb_build_object('id', null, 'title', 'Día B', 'exercises', jsonb_build_array(
            jsonb_build_object('id', null, 'exercise_id', v_ex[3], 'sets', 2, 'reps', '15', 'rest_seconds', 45,
                               'weight_suggestion', null, 'notes', null)))));
      v_plantilla := public.admin_guardar_rutina(v_base);
      select count(*) into v_n
      from routine_days rd join routine_exercises re on re.day_id = rd.id
      where rd.routine_id = v_plantilla;
      v_ok := v_n = 3
              and exists (select 1 from routines where id = v_plantilla and user_id is null and is_template
                                                       and vigente_desde is null and vigente_hasta is null);
      v_txt := format('plantilla creada con %s ejercicios, sin socio y sin vigencia', v_n);
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'a0'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (a) Asignar la plantilla.
    begin
      perform pg_temp.hr_como(v_admin);
      v_r1 := public.admin_asignar_rutina(v_user, v_plantilla);
      select count(*) into v_n from routines
      where user_id = v_user and not coalesce(is_template, false) and vigente_hasta is null;
      v_ok := v_n = 1
              and exists (select 1 from routines where id = v_r1 and user_id = v_user and not is_template
                                                       and vigente_desde is not null and vigente_hasta is null
                                                       and title = 'PRUEBA HR plantilla')
              and pg_temp.hr_contenido(v_r1) = pg_temp.hr_contenido(v_plantilla)
              and (v_r0 is null
                   or (select r0.vigente_hasta = r1.vigente_desde from routines r0, routines r1
                       where r0.id = v_r0 and r1.id = v_r1));
      v_txt := format('asignó la plantilla: copia exacta, %s vigente(s)', v_n)
               || case when v_r0 is null then ' (la cuenta no tenía rutina)'
                       else '; la que tenía pasó al historial con fin = inicio de la nueva' end;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'a'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (a2) Asignar otra vez.
    begin
      perform pg_temp.hr_como(v_admin);
      v_r2 := public.admin_asignar_rutina(v_user, v_plantilla);
      select count(*) into v_n from routines
      where user_id = v_user and not coalesce(is_template, false) and vigente_hasta is null;
      v_ok := v_n = 1
              and (select vigente_hasta is not null from routines where id = v_r1)
              and (select vigente_hasta is null from routines where id = v_r2)
              and (select r1.vigente_hasta = r2.vigente_desde from routines r1, routines r2 where r1.id = v_r1 and r2.id = v_r2);
      v_txt := format('segunda asignación: la de (a) pasó al historial, %s vigente(s)', v_n);
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'a2'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (b) El socio no puede asignar ni guardar.
    begin
      perform pg_temp.hr_como(v_user);
      r1 := pg_temp.hr_intentar(format('select public.admin_asignar_rutina(%L::uuid, %L::uuid)', v_user, v_plantilla));
      r2 := pg_temp.hr_intentar(format('select public.admin_guardar_rutina(%L::jsonb)', v_base));
      v_ok := r1 like '42501%' and r2 like '42501%';
      v_txt := 'socio asigna -> ' || r1 || ' / socio guarda -> ' || r2;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'b'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (c) La anterior (v_r1) es de solo lectura.
    begin
      perform pg_temp.hr_como(v_admin);
      v_huella_r1 := pg_temp.hr_contenido_ids(v_r1);
      r1 := pg_temp.hr_intentar(format('update public.routines set title = %L where id = %L', 'X', v_r1));
      r2 := pg_temp.hr_intentar(format('insert into public.routine_days (routine_id, title, order_index) values (%L, %L, 9)', v_r1, 'X'));
      r3 := pg_temp.hr_intentar(format(
        'update public.routine_exercises set reps = %L where id = (select re.id from public.routine_exercises re '
        'join public.routine_days rd on rd.id = re.day_id where rd.routine_id = %L limit 1)', '99', v_r1));
      r4 := pg_temp.hr_intentar(format('delete from public.routine_days where routine_id = %L', v_r1));
      r5 := pg_temp.hr_intentar(format('select public.admin_guardar_rutina(%L::jsonb)', v_base || jsonb_build_object('id', v_r1)));
      v_ok := r1 like 'GFR01%' and r2 like 'GFR01%' and r3 like 'GFR01%' and r4 like 'GFR01%' and r5 like 'GFR01%'
              and pg_temp.hr_contenido_ids(v_r1) = v_huella_r1;
      v_txt := format('cabecera -> %s / día nuevo -> %s / ejercicio -> %s / borrar día -> %s / editor -> %s%s',
                      left(r1, 5), left(r2, 5), left(r3, 5), left(r4, 5), left(r5, 5),
                      case when pg_temp.hr_contenido_ids(v_r1) = v_huella_r1 then '; no cambió nada' else '; CAMBIÓ' end);
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'c'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (d) Borrar / cambiar de socio / cerrar a mano; plantilla todavía se borra.
    begin
      perform pg_temp.hr_como(v_admin);
      r1 := pg_temp.hr_intentar(format('delete from public.routines where id = %L', v_r2));
      r2 := pg_temp.hr_intentar(format('delete from public.routines where id = %L', v_r1));
      r3 := pg_temp.hr_intentar(format('update public.routines set user_id = %L where id = %L', v_admin, v_r2));
      r4 := pg_temp.hr_intentar(format('update public.routines set vigente_hasta = now() where id = %L', v_r2));
      v_plantilla2 := public.admin_guardar_rutina(v_base || jsonb_build_object('title', 'PRUEBA HR plantilla 2'));
      r5 := pg_temp.hr_intentar(format('delete from public.routines where id = %L', v_plantilla2));
      v_ok := r1 like 'GFR02%' and r2 like 'GFR02%' and r3 like 'GFR03%' and r4 like 'GFR03%' and r5 = 'anduvo'
              and exists (select 1 from routines where id = v_r1)
              and exists (select 1 from routines where id = v_r2 and user_id = v_user and vigente_hasta is null)
              and not exists (select 1 from routines where id = v_plantilla2);
      v_txt := format('borrar vigente -> %s / borrar anterior -> %s / cambiar de socio -> %s / cerrar a mano -> %s / borrar plantilla -> %s',
                      left(r1, 5), left(r2, 5), left(r3, 5), left(r4, 5), r5);
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'd'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (e) y (f) "Guardar cambios" sobre la vigente (v_r2). Tilde de hoy SOLO en el ejercicio
    -- que sigue (v_re_a); los que cambian o se sacan (v_re_b, v_re_c) no tienen tildes.
    begin
      perform pg_temp.hr_como(v_admin);
      select id into v_da from routine_days where routine_id = v_r2 and order_index = 0;
      select id into v_db from routine_days where routine_id = v_r2 and order_index = 1;
      select id into v_re_a from routine_exercises where day_id = v_da and order_index = 0;
      select id into v_re_b from routine_exercises where day_id = v_da and order_index = 1;
      select id into v_re_c from routine_exercises where day_id = v_db and order_index = 0;
      insert into routine_completions (user_id, routine_exercise_id, completed_date)
      values (v_user, v_re_a, v_hoy);

      v_payload := jsonb_build_object(
        'id', v_r2, 'title', 'PRUEBA HR editada', 'notes', null,
        'days', jsonb_build_array(
          jsonb_build_object('id', v_da, 'title', 'Día A (editado)', 'exercises', jsonb_build_array(
            jsonb_build_object('id', v_re_a, 'exercise_id', v_ex[1], 'sets', 5, 'reps', '12', 'rest_seconds', 90,
                               'weight_suggestion', '25kg', 'notes', null),
            jsonb_build_object('id', v_re_b, 'exercise_id', v_ex[4], 'sets', 3, 'reps', '10', 'rest_seconds', null,
                               'weight_suggestion', null, 'notes', null))),
          jsonb_build_object('id', v_db, 'title', 'Día B', 'exercises', jsonb_build_array(
            jsonb_build_object('id', null, 'exercise_id', null,
                               'nuevo', jsonb_build_object('name', 'PRUEBA HR nuevo ' || gen_random_uuid(), 'muscle_group', c_grupo),
                               'sets', 2, 'reps', '8'))),
          jsonb_build_object('id', null, 'title', 'Día C', 'exercises', jsonb_build_array(
            jsonb_build_object('id', null, 'exercise_id', v_ex[3], 'sets', 1, 'reps', '20')))));
      v_id := public.admin_guardar_rutina(v_payload);

      -- (e)
      v_ok := v_id = v_r2
              and exists (select 1 from routines where id = v_r2 and title = 'PRUEBA HR editada' and vigente_hasta is null)
              and exists (select 1 from routine_days where id = v_da and routine_id = v_r2 and title = 'Día A (editado)' and order_index = 0)
              and exists (select 1 from routine_days where id = v_db and routine_id = v_r2 and order_index = 1)
              and exists (select 1 from routine_exercises where id = v_re_a and day_id = v_da and sets = 5 and reps = '12'
                                                            and rest_seconds = 90 and weight_suggestion = '25kg' and order_index = 0)
              and exists (select 1 from routine_completions where user_id = v_user and routine_exercise_id = v_re_a and completed_date = v_hoy);
      v_txt := case when v_ok
        then 'misma rutina; el ejercicio que sigue conservó su id, se actualizó (5x12, 25kg, 90 s) y su tilde de hoy sigue; días con su id'
        else 'NO conservó ids/tildes o no actualizó como se esperaba' end;
      v_casos := v_casos || 'e'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

      -- (f)
      select count(*) into v_n from routine_days where routine_id = v_r2;
      v_ok := not exists (select 1 from routine_exercises where id in (v_re_b, v_re_c))
              and exists (select 1 from routine_exercises where day_id = v_da and exercise_id = v_ex[4] and order_index = 1)
              and exists (select 1 from routine_exercises re join exercises e on e.id = re.exercise_id
                          where re.day_id = v_db and e.name like 'PRUEBA HR nuevo %' and e.muscle_group = c_grupo)
              and exists (select 1 from routine_days rd join routine_exercises re on re.day_id = rd.id
                          where rd.routine_id = v_r2 and rd.title = 'Día C' and rd.order_index = 2 and re.exercise_id = v_ex[3])
              and v_n = 3;
      v_txt := case when v_ok
        then 'sin tildes: cambio de ejercicio = fila nueva; el quitado se borró; el nuevo se creó en la biblioteca; Día C al final (3 días)'
        else format('NO quedó como se esperaba (días: %s)', v_n) end;
      v_casos := v_casos || 'f'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;
    exception when others then
      v_casos := v_casos || 'e'::text; v_oks := v_oks || false; v_textos := v_textos || ('error inesperado: ' || sqlerrm);
      v_casos := v_casos || 'f'::text; v_oks := v_oks || false; v_textos := v_textos || 'no se pudo probar (falló (e))'::text;
    end;

    -- (f2) Con tildes, "Guardar cambios" NO borra: GFR04 y la rutina queda igual. Ahora v_r2
    -- tiene: Día A = v_re_a (Ej. 1, con tilde) + la fila nueva de Ej. 4 (le ponemos tilde);
    -- Día B = el ejercicio nuevo; Día C = Ej. 3 (sin tildes).
    begin
      perform pg_temp.hr_como(v_admin);
      select id into v_x from routine_exercises where day_id = v_da and exercise_id = v_ex[4];
      insert into routine_completions (user_id, routine_exercise_id, completed_date) values (v_user, v_x, v_hoy - 3);
      select id into v_y from routine_days where routine_id = v_r2 and title = 'Día C';
      v_huella_r2 := pg_temp.hr_contenido_ids(v_r2);
      select count(*) into v_n from routine_completions where routine_exercise_id in (v_re_a, v_x);

      -- sacar un ejercicio con tildes (uno de hace 3 días: vale cualquier fecha)
      r1 := pg_temp.hr_intentar(format('select public.admin_guardar_rutina(%L::jsonb)',
              pg_temp.hr_payload(v_r2, array[v_x], '{}'::uuid[], null, null)));
      -- cambiar el ejercicio de un bloque con tildes
      r2 := pg_temp.hr_intentar(format('select public.admin_guardar_rutina(%L::jsonb)',
              pg_temp.hr_payload(v_r2, '{}'::uuid[], '{}'::uuid[], v_re_a, v_ex[2])));
      -- sacar un día cuyos ejercicios tienen tildes
      r3 := pg_temp.hr_intentar(format('select public.admin_guardar_rutina(%L::jsonb)',
              pg_temp.hr_payload(v_r2, '{}'::uuid[], array[v_da], null, null)));
      v_ok := r1 like 'GFR04 Este cambio borraría el registro de la alumna. Usá «Guardar como rutina nueva».'
              and r2 like 'GFR04 %' and r3 like 'GFR04 %'
              and pg_temp.hr_contenido_ids(v_r2) = v_huella_r2
              and (select count(*) from routine_completions where routine_exercise_id in (v_re_a, v_x)) = v_n;
      v_txt := format('con tildes -> sacar ejercicio: %s / cambiar ejercicio: %s / sacar día: %s%s',
                      left(r1, 5), left(r2, 5), left(r3, 5),
                      case when pg_temp.hr_contenido_ids(v_r2) = v_huella_r2 then '; la rutina y sus tildes quedaron igual' else '; CAMBIÓ' end);

      -- sacar un día SIN tildes: se borra como siempre
      r4 := pg_temp.hr_intentar(format('select public.admin_guardar_rutina(%L::jsonb)',
              pg_temp.hr_payload(v_r2, '{}'::uuid[], array[v_y], null, null)));
      v_ok := v_ok and r4 = 'anduvo'
              and not exists (select 1 from routine_days where id = v_y)
              and (select count(*) from routine_completions where routine_exercise_id in (v_re_a, v_x)) = v_n;
      v_txt := v_txt || ' / sacar día sin tildes: ' || r4;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'f2'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (g) "Guardar como rutina nueva" desde v_r2.
    begin
      perform pg_temp.hr_como(v_admin);
      v_huella_r2 := pg_temp.hr_contenido_ids(v_r2);
      -- Lo editado: el Día A como quedó en (e) (con sus ids: al crear se ignoran) y un Día B
      -- distinto. Sin "nuevo": no se crea otro ejercicio con el mismo nombre.
      v_r3 := public.admin_guardar_rutina(
        jsonb_build_object('id', v_r2, 'como_nueva', true, 'title', 'PRUEBA HR como nueva', 'notes', null,
                           'days', jsonb_build_array(
                             v_payload->'days'->0,
                             jsonb_build_object('id', v_db, 'title', 'Día B', 'exercises', jsonb_build_array(
                               jsonb_build_object('id', null, 'exercise_id', v_ex[2], 'sets', 2, 'reps', '8'))))));
      select count(*) into v_n from routine_days where routine_id = v_r3;
      v_ok := v_r3 <> v_r2
              and exists (select 1 from routines where id = v_r3 and user_id = v_user and vigente_hasta is null
                                                       and title = 'PRUEBA HR como nueva')
              and (select r2.vigente_hasta = r3.vigente_desde from routines r2, routines r3 where r2.id = v_r2 and r3.id = v_r3)
              and pg_temp.hr_contenido_ids(v_r2) = v_huella_r2
              and exists (select 1 from routine_completions where routine_exercise_id = v_re_a and completed_date = v_hoy)
              and v_n = 2;
      v_txt := format('rutina nueva vigente con %s días; la anterior pasó al historial intacta (mismos ids y contenido) con su tilde', v_n);
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'g'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (h) Volver a asignar v_r1.
    begin
      perform pg_temp.hr_como(v_admin);
      v_r4 := public.admin_asignar_rutina(v_user, v_r1);
      r1 := pg_temp.hr_intentar(format('select public.admin_asignar_rutina(%L::uuid, %L::uuid)', v_user, v_r4));
      r2 := case when v_otra_rutina is null then null
                 else pg_temp.hr_intentar(format('select public.admin_asignar_rutina(%L::uuid, %L::uuid)', v_user, v_otra_rutina)) end;
      r3 := case when v_archivada is null then null
                 else pg_temp.hr_intentar(format('select public.admin_asignar_rutina(%L::uuid, %L::uuid)', v_user, v_archivada)) end;
      v_ok := exists (select 1 from routines where id = v_r4 and user_id = v_user and vigente_hasta is null)
              and (select vigente_hasta is not null from routines where id = v_r3)
              and pg_temp.hr_contenido(v_r4) = pg_temp.hr_contenido(v_r1)
              and r1 like '%ya es la rutina vigente%'
              and (r2 is null or r2 like '%mismo socio%')
              and (r3 is null or r3 like '%archivada%');
      v_txt := 'copia exacta de la anterior como vigente / la vigente -> ' || r1
               || ' / de otro socio -> ' || coalesce(r2, '(sin otro socio, no se probó)')
               || ' / archivada -> ' || coalesce(r3, '(sin archivadas, no se probó)');
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'h'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (i) Tildes.
    begin
      perform pg_temp.hr_como(v_user);
      select re.id into v_x from routine_exercises re join routine_days rd on rd.id = re.day_id
      where rd.routine_id = v_r4 order by rd.order_index, re.order_index limit 1;
      select re.id into v_y from routine_exercises re join routine_days rd on rd.id = re.day_id
      where rd.routine_id = v_r3 order by rd.order_index, re.order_index limit 1;
      r1 := pg_temp.hr_intentar(format('insert into public.routine_completions (user_id, routine_exercise_id, completed_date) values (%L, %L, %L)', v_user, v_x, v_hoy));
      r2 := pg_temp.hr_intentar(format('insert into public.routine_completions (user_id, routine_exercise_id, completed_date) values (%L, %L, %L)', v_user, v_y, v_hoy));
      r3 := pg_temp.hr_intentar(format('delete from public.routine_completions where user_id = %L and routine_exercise_id = %L and completed_date = %L', v_user, v_re_a, v_hoy));
      v_ok := r1 = 'anduvo' and r2 like 'GFR01%' and r3 like 'GFR01%'
              and exists (select 1 from routine_completions where routine_exercise_id = v_re_a and completed_date = v_hoy);
      v_txt := 'tildar en la vigente -> ' || r1 || ' / tildar en una anterior -> ' || left(r2, 5)
               || ' / destildar en una anterior -> ' || left(r3, 5);
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'i'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (j1..j5) finalizar_entrenamiento. Cada uno se deshace al terminar (la ventana de 10 s
    -- del servidor haría que el siguiente diera "reciente").
    -- (j1) con la vigente.
    begin
      perform pg_temp.hr_como(v_user);
      v_res := null; v_n := null; v_m := null;
      begin
        v_res := public.finalizar_entrenamiento('PRUEBA HR', 2, '[{"nombre":"A"},{"nombre":"B"}]'::jsonb, v_r4);
        select count(*), count(*) filter (where routine_id = v_r4) into v_n, v_m
        from routine_history where sesion_id = (v_res->>'sesion_id')::uuid;
        raise exception 'DESHACER' using errcode = 'P0999';
      exception when sqlstate 'P0999' then null;
      end;
      if v_res->>'motivo' = 'tope_diario' then
        v_ok := null; v_txt := 'la cuenta de test ya tiene 20 entrenamientos hoy';
      else
        v_ok := coalesce((v_res->>'registrado')::boolean, false) and v_n = 2 and v_m = 2;
        v_txt := format('respuesta %s; %s filas, %s con la rutina vigente', v_res, v_n, v_m);
      end if;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'j1'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (j2) sin p_routine_id -> la vigente.
    begin
      perform pg_temp.hr_como(v_user);
      v_res := null; v_n := null; v_m := null;
      begin
        v_res := public.finalizar_entrenamiento('PRUEBA HR', 1, '[{"nombre":"A"}]'::jsonb, null);
        select count(*), count(*) filter (where routine_id = v_r4) into v_n, v_m
        from routine_history where sesion_id = (v_res->>'sesion_id')::uuid;
        raise exception 'DESHACER' using errcode = 'P0999';
      exception when sqlstate 'P0999' then null;
      end;
      if v_res->>'motivo' = 'tope_diario' then
        v_ok := null; v_txt := 'la cuenta de test ya tiene 20 entrenamientos hoy';
      else
        v_ok := coalesce((v_res->>'registrado')::boolean, false) and v_n = 1 and v_m = 1;
        v_txt := format('sin rutina -> %s fila(s), %s con la vigente', v_n, v_m);
      end if;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'j2'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (j3) llamada vieja: 3 argumentos con nombre (como manda la PWA en caché).
    begin
      perform pg_temp.hr_como(v_user);
      v_res := null; v_n := null; v_m := null;
      begin
        v_res := public.finalizar_entrenamiento(p_titulo_dia => 'PRUEBA HR', p_total_ejercicios => 1,
                                                p_items => '[{"nombre":"A"}]'::jsonb);
        select count(*), count(*) filter (where routine_id = v_r4) into v_n, v_m
        from routine_history where sesion_id = (v_res->>'sesion_id')::uuid;
        raise exception 'DESHACER' using errcode = 'P0999';
      exception when sqlstate 'P0999' then null;
      end;
      if v_res->>'motivo' = 'tope_diario' then
        v_ok := null; v_txt := 'la cuenta de test ya tiene 20 entrenamientos hoy';
      else
        v_ok := coalesce((v_res->>'registrado')::boolean, false) and v_n = 1 and v_m = 1;
        v_txt := format('llamada de 3 args -> %s fila(s), %s con la vigente', v_n, v_m);
      end if;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'j3'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (j4) en una anterior propia (pantalla vieja) -> queda con esa.
    begin
      perform pg_temp.hr_como(v_user);
      v_res := null; v_n := null; v_m := null;
      begin
        v_res := public.finalizar_entrenamiento('PRUEBA HR', 1, '[{"nombre":"A"}]'::jsonb, v_r2);
        select count(*), count(*) filter (where routine_id = v_r2) into v_n, v_m
        from routine_history where sesion_id = (v_res->>'sesion_id')::uuid;
        raise exception 'DESHACER' using errcode = 'P0999';
      exception when sqlstate 'P0999' then null;
      end;
      if v_res->>'motivo' = 'tope_diario' then
        v_ok := null; v_txt := 'la cuenta de test ya tiene 20 entrenamientos hoy';
      else
        v_ok := coalesce((v_res->>'registrado')::boolean, false) and v_n = 1 and v_m = 1;
        v_txt := format('rutina anterior propia -> %s fila(s), %s con esa rutina', v_n, v_m);
      end if;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'j4'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (j5) con la rutina de OTRO socio -> 42501.
    begin
      if v_otra_rutina is null then
        v_ok := null; v_txt := 'no hay otro socio con rutina vigente';
      else
        perform pg_temp.hr_como(v_user);
        r1 := pg_temp.hr_intentar(format(
          'select public.finalizar_entrenamiento(%L, 1, %L::jsonb, %L::uuid)', 'PRUEBA HR', '[{"nombre":"A"}]', v_otra_rutina));
        v_ok := r1 like '42501%';
        v_txt := 'rutina de otro socio -> ' || r1;
      end if;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'j5'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (k) y (l): una sesión de prueba, "Eliminar" (ocultar) y lecturas con RLS. Se deshace.
    begin
      v_res := null; v_n := null; v_m := null; v_k := null;
      r1 := null; r2 := null; r3 := null; r4 := null; r5 := null; r6 := null; r7 := null;
      begin
        perform pg_temp.hr_como(v_user);
        v_res := public.finalizar_entrenamiento('PRUEBA HR', 1, '[{"nombre":"A"}]'::jsonb, v_r4);
        v_sesion := (v_res->>'sesion_id')::uuid;
        -- Otro usuario (el admin, como usuario de la app) intenta ocultarla.
        perform pg_temp.hr_como(v_admin);
        v_k := public.eliminar_sesion_historial(v_sesion);
        perform pg_temp.hr_como(v_user);
        v_n := public.eliminar_sesion_historial(v_sesion);
        v_m := public.eliminar_sesion_historial(v_sesion);
        r7 := (select count(*) || ' filas, ' || count(*) filter (where oculta_en is not null) || ' ocultas'
               from routine_history where sesion_id = v_sesion);
        -- (l)
        r1 := pg_temp.hr_leer_como(v_user, format('select count(*) from public.routine_history where sesion_id = %L', v_sesion));
        r2 := pg_temp.hr_leer_como(v_admin, format('select count(*) from public.routine_history where sesion_id = %L', v_sesion));
        r3 := case when v_otro is null then null
                   else pg_temp.hr_leer_como(v_otro, format('select count(*) from public.routine_history where sesion_id = %L', v_sesion)) end;
        r4 := case when v_otro is null then null
                   else pg_temp.hr_leer_como(v_user, format('select count(*) from public.routines where user_id = %L', v_otro)) end;
        r5 := pg_temp.hr_leer_como(v_user, format(
          'select count(*) from public.routines where user_id = %L and id in (%L, %L, %L, %L)', v_user, v_r1, v_r2, v_r3, v_r4));
        r6 := pg_temp.hr_leer_como(v_user, format('select count(*) from public.routine_days where routine_id = %L', v_r1));
        v_txt := pg_temp.hr_leer_como(v_admin, format(
          'select count(*) from public.routines where user_id = %L and id in (%L, %L, %L, %L)', v_user, v_r1, v_r2, v_r3, v_r4));
        raise exception 'DESHACER' using errcode = 'P0999';
      exception when sqlstate 'P0999' then null;
      end;

      if v_res->>'motivo' = 'tope_diario' then
        v_casos := v_casos || 'k'::text; v_oks := v_oks || null::boolean;
        v_textos := v_textos || 'la cuenta de test ya tiene 20 entrenamientos hoy'::text;
        v_casos := v_casos || 'l'::text; v_oks := v_oks || null::boolean;
        v_textos := v_textos || 'la cuenta de test ya tiene 20 entrenamientos hoy'::text;
      else
        -- (k)
        v_ok := v_k = 0 and v_n = 1 and v_m = 0 and r7 = '1 filas, 1 ocultas';
        v_casos := v_casos || 'k'::text; v_oks := v_oks || v_ok;
        v_textos := v_textos || format('otro usuario -> %s / el socio -> %s / otra vez -> %s; en la tabla: %s', v_k, v_n, v_m, r7);
        -- (l)
        v_ok := r1 = '1' and r2 = '1' and (r3 is null or r3 = '0') and r5 = '4' and v_txt = '4'
                and case when r6 ~ '^\d+$' then r6::int > 0 else false end;
        v_casos := v_casos || 'l'::text; v_oks := v_oks || v_ok;
        v_textos := v_textos || format('socio ve su sesión oculta: %s / admin la ve: %s / otro socio: %s / socio ve sus 4 rutinas: %s / días de su anterior: %s / admin ve las 4: %s',
                                       r1, r2, coalesce(r3, '(sin otro socio)'), r5, r6, v_txt);
      end if;

      -- (l4)
      if r4 is null then
        v_ok := null; v_txt := 'no hay otro socio con rutina';
      else
        v_ok := r4 = '0';
        v_txt := 'el socio de test ve ' || r4 || ' rutina(s) de otro socio'
                 || case when r4 = '0' then '' else ' (la policy de routines de producción ya lo permitía: cerrarla aparte)' end;
      end if;
      v_casos := v_casos || 'l4'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;
    exception when others then
      v_casos := v_casos || 'k'::text; v_oks := v_oks || false; v_textos := v_textos || ('error inesperado: ' || sqlerrm);
      v_casos := v_casos || 'l'::text; v_oks := v_oks || false; v_textos := v_textos || 'no se pudo probar (falló (k))'::text;
      v_casos := v_casos || 'l4'::text; v_oks := v_oks || false; v_textos := v_textos || 'no se pudo probar (falló (k))'::text;
    end;

    -- (m) Borrar la cuenta se lleva las rutinas. Se borra la fila padre de la FK de
    -- routines.user_id (profiles o auth.users) y se deshace en el acto.
    begin
      select con.confrelid::regclass::text as padre, con.confdeltype into v_fk
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
      where con.contype = 'f' and con.conrelid = 'public.routines'::regclass and att.attname = 'user_id'
      limit 1;
      v_n := null; v_sqlstate := null; v_txt := null;
      if v_fk.padre is not null then
        begin
          execute format('delete from %s where id = %L', v_fk.padre, v_user);
          select count(*) into v_n from routines where user_id = v_user;
          raise exception 'DESHACER' using errcode = 'P0999';
        exception
          when sqlstate 'P0999' then null;
          when others then
            get stacked diagnostics v_sqlstate = returned_sqlstate;
            v_txt := sqlerrm;
        end;
      end if;
      if v_fk.padre is null then
        v_ok := null;
        v_txt := 'routines.user_id no tiene FK: no hay cascada que probar';
      elsif v_sqlstate is null then
        v_ok := v_n = 0;
        v_txt := format('borrar la cuenta (%s) -> quedan %s rutinas del socio', v_fk.padre, v_n);
      elsif v_sqlstate like 'GFR%' then
        v_ok := false;
        v_txt := 'los triggers del historial FRENARON el borrado de la cuenta: ' || v_sqlstate || ' ' || v_txt;
      else
        v_ok := null;
        v_txt := format('borrar la cuenta de test falla por otra razón que ya existía (%s, FK %s en modo %s): %s',
                        v_sqlstate, v_fk.padre, v_fk.confdeltype, v_txt);
      end if;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'm'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    raise exception '%', c_fin;
  exception when others then
    if sqlerrm <> c_fin then
      v_casos := v_casos || '!'::text; v_oks := v_oks || false;
      v_textos := v_textos || ('ERROR inesperado preparando los casos: ' || sqlerrm);
    end if;
  end;

  -- ── (z) Ya deshecha la subtransacción: no quedó nada ───────────────────────────────
  v_huella_despues := pg_temp.hr_huella();
  v_ok := v_huella_despues = v_huella_antes
          and not exists (select 1 from exercises where name like 'PRUEBA HR %')
          and not exists (select 1 from routines where title like 'PRUEBA HR %')
          and to_regprocedure('pg_temp.hr_intentar(text)') is null;
  v_casos := v_casos || 'z'::text; v_oks := v_oks || v_ok;
  v_textos := v_textos || case when v_ok
    then 'rutinas, días, ejercicios, tildes, historial, cargas, biblioteca y la cuenta de test iguales que antes'
    else 'QUEDÓ ALGO de la prueba o cambió algo real' end;

  insert into pg_temp._log (caso, linea)
  select u.caso,
         case when u.ok is null then 'SALTEADO  ' when u.ok then 'OK        ' else 'FALLA     ' end
         || '(' || u.caso || ') ' || u.texto
  from unnest(v_casos, v_oks, v_textos) with ordinality as u(caso, ok, texto, i)
  order by u.i;
end;
$prueba$;

drop function pg_temp.hr_huella();

insert into _log (caso, linea)
select 'RESUMEN', format('%s OK, %s FALLA, %s SALTEADO',
  count(*) filter (where linea like 'OK%'), count(*) filter (where linea like 'FALLA%'),
  count(*) filter (where linea like 'SALTEADO%'))
from _log;

commit;

select caso, linea from pg_temp._log order by n;
