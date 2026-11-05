-- =====================================================================================
-- PRUEBA de Tanda B -- supabase_migration_tanda_b_hoy_argentina.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA TANDA B TERMINADA -- se deshizo todo"). El mensaje de ese error ES el informe:
-- "N de M OK" y una línea por chequeo.
--
-- Cómo corre:
--   * DESPUÉS de la migración. Antes, (0) a (4) fallan y los casos de "noche" dan el día UTC.
--   * Guarda de horario: igual que la migración, frena SOLO si el día UTC y el de Argentina
--     son distintos (21:00 a 23:59 de Argentina).
--   * LA NOCHE SIMULADA: a partir del caso (5), la sesión pasa a una zona horaria en la que
--     current_date NO es el día de Argentina (Pacific/Kiritimati, UTC+14, o Etc/GMT+12,
--     UTC-12, según la hora). Es lo mismo que pasa de verdad entre las 21:00 y las 23:59: si
--     algo todavía usara current_date, grabaría otro día y el caso fallaría.
--   * Los casos van dentro de una subtransacción que se deshace al final; cada caso en su
--     propio bloque (si uno revienta, se informa como FALLA y siguen los demás). El caso (l)
--     se mide DESPUÉS de deshacer y confirma que no quedó ningún rastro.
--   * Sesión simulada (request.jwt.claims, local): la cuenta de test para "¡Hoy entrené!" y
--     el primer admin de profiles para admin_resetear_ranking (que, deshecho, no resetea nada).
-- =====================================================================================

do $prueba$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  c_fin_casos constant text := 'FIN_CASOS_TANDA_B';
  c_deshacer constant text := 'DESHACER_CASO_TANDA_B';
  c_dni constant text := '44537978';
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_hora int := extract(hour from (now() at time zone 'America/Argentina/Mendoza'))::int;
  v_zona_falsa text;
  v_user uuid;
  v_admin uuid;
  v_aparatos uuid;
  v_ok boolean;
  v_err text;
  v_txt text;
  v_fecha date;
  v_n int;
  v_m int;
  v_mp_id text;
  v_pago record;
  v_r record;
  v_huella_antes text;
  v_huella_despues text;
  ok int := 0;
  total int := 0;
  informe text := '';
begin
  -- ── Guarda de horario ────────────────────────────────────────────────────────────────
  if current_date <> (now() at time zone 'America/Argentina/Mendoza')::date
     or (now() at time zone 'UTC')::date <> (now() at time zone 'America/Argentina/Mendoza')::date then
    raise exception 'Prueba Tanda B: entre las 21:00 y las 23:59 de Argentina no se puede correr (el día UTC ya es el siguiente). No se probó nada.';
  end if;

  -- ── Preparación (fuera de los casos) ─────────────────────────────────────────────────
  select id into v_user from profiles where dni = c_dni;
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  select id into v_admin from profiles where role = 'admin' order by created_at limit 1;
  if v_admin is null then
    raise exception 'No hay ningún perfil admin.';
  end if;
  if (select count(*) from disciplines where kind = 'membership') <> 1 then
    raise exception 'PRUEBA Tanda B: tiene que haber exactamente 1 disciplina de tipo membership (Aparatos). No se probó nada.';
  end if;
  select id into v_aparatos from disciplines where kind = 'membership';

  -- Zona en la que current_date <> día de Argentina a esta hora.
  v_zona_falsa := case when v_hora >= 7 then 'Pacific/Kiritimati' else 'Etc/GMT+12' end;

  select md5(coalesce((select string_agg(concat_ws(':', id, event_type, xp_amount, event_date, discipline_id), ',' order by id)
                       from xp_events where user_id = v_user), '-')
             || '|' || (select count(*) from pagos_socio where paquete = 'PRUEBA TANDA B')::text
             || '|' || (select count(*) from xp_events where event_type = 'reversion')::text
             || '|' || coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                                 from user_credits where user_id = v_user), '-'))
    into v_huella_antes;

  begin
    -- ── (0) Migración aplicada: respaldo y huellas de Tanda B ───────────────────────────
    total := total + 1;
    begin
      if to_regclass('respaldo.tanda_b_funciones') is null or to_regclass('respaldo.tanda_b_defaults') is null then
        informe := informe || E'\nFALLA  (0) no existe el respaldo: la migración Tanda B no está aplicada';
      else
        select string_agg(b.funcion, ', ') into v_txt
        from respaldo.tanda_b_funciones b
        where to_regprocedure(b.funcion) is null
           or md5(regexp_replace(pg_get_functiondef(to_regprocedure(b.funcion)), '\s+', '', 'g')) <> b.huella_nueva_sin_espacios
           or md5(regexp_replace(regexp_replace(b.definicion_antes, '\mcurrent_date\M', '(now() at time zone ''America/Argentina/Mendoza'')::date', 'gi'), '\s+', '', 'g'))
              <> b.huella_nueva_sin_espacios;
        if v_txt is null and (select count(*) from respaldo.tanda_b_funciones) = 4 and (select count(*) from respaldo.tanda_b_defaults) = 4 then
          ok := ok + 1; informe := informe || E'\nOK     (0) migración aplicada: las 4 funciones son la versión de producción con SOLO la fecha cambiada';
        else
          informe := informe || E'\nFALLA  (0) funciones que no son la versión Tanda B: ' || coalesce(v_txt, '(faltan filas en el respaldo)');
        end if;
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (0) ERROR: ' || sqlerrm;
    end;

    -- ── (1) Sin "hoy" UTC en el código de NINGUNA función de public ─────────────────────
    total := total + 1;
    begin
      select string_agg(p.oid::regprocedure::text, ', ') into v_txt
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where n.nspname = 'public'
        and l.lanname in ('plpgsql', 'sql')
        and (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\m(current_date|localtimestamp|localtime)\M|now\(\)\s*::\s*date'
             or (p.proname in ('registrar_hoy_entrene', 'mp_process_payment', 'admin_resetear_ranking', 'community_ranking_mes')
                 and (p.prosrc ~* '\mcurrent_date\M' or p.prosrc !~ 'America/Argentina/Mendoza')));
      if v_txt is null then
        ok := ok + 1; informe := informe || E'\nOK     (1) ninguna función de public usa current_date en el código; las 4 usan el día de Argentina';
      else
        informe := informe || E'\nFALLA  (1) todavía usan "hoy" UTC: ' || v_txt;
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (1) ERROR: ' || sqlerrm;
    end;

    -- ── (2) acreditar_pack y admin_acreditar_creditos_manual no se tocaron ──────────────
    total := total + 1;
    begin
      select string_agg(p.proname, ', ') into v_txt
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('acreditar_pack', 'admin_acreditar_creditos_manual')
        and p.prosrc ~ 'America/Argentina/Mendoza'' *\) *:: *date'
        and p.prosrc !~* '\mcurrent_date\M';
      if (select count(*) from respaldo.tanda_b_funciones
          where funcion like 'acreditar_pack(%' or funcion like 'admin_acreditar_creditos_manual(%') = 0
         and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('acreditar_pack', 'admin_acreditar_creditos_manual')
                and p.prosrc ~* '\mcurrent_date\M') >= 1 then
        ok := ok + 1; informe := informe || E'\nOK     (2) acreditar_pack y admin_acreditar_creditos_manual quedaron como estaban (current_date solo en comentarios)';
      else
        informe := informe || E'\nFALLA  (2) acreditar_pack / admin_acreditar_creditos_manual figuran en el respaldo o perdieron sus comentarios';
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (2) ERROR: ' || sqlerrm;
    end;

    -- ── (3) Permisos y atributos iguales a antes ────────────────────────────────────────
    total := total + 1;
    begin
      select string_agg(b.funcion || ': antes ' || b.permisos || ' / ahora ' || coalesce(p.proacl::text, '(por defecto)'), ' | ') into v_txt
      from respaldo.tanda_b_funciones b
      join pg_proc p on p.oid = b.funcion::regprocedure
      where coalesce(p.proacl::text, '(por defecto)') <> b.permisos
         or p.prosecdef <> b.security_definer
         or p.provolatile <> b.volatilidad
         or coalesce(array_to_string(p.proconfig, ','), '') <> b.config;
      if v_txt is null then
        ok := ok + 1; informe := informe || E'\nOK     (3) permisos, security definer, volatilidad y config de las 4 funciones: iguales a antes';
      else
        informe := informe || E'\nFALLA  (3) cambió: ' || v_txt;
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (3) ERROR: ' || sqlerrm;
    end;

    -- ── (4) Los 4 defaults: texto nuevo ─────────────────────────────────────────────────
    total := total + 1;
    begin
      select string_agg(x.tabla || '.' || x.columna || ' = ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '(sin default)'), ', ')
        into v_txt
      from (values ('asistencias', 'fecha'), ('pagos_socio', 'fecha'), ('socios', 'ultimo_pago'), ('xp_events', 'event_date')) as x(tabla, columna)
      left join pg_attribute a on a.attrelid = to_regclass('public.' || x.tabla) and a.attname = x.columna and not a.attisdropped
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where d.adbin is null
         or pg_get_expr(d.adbin, d.adrelid) ~* 'current_date'
         or pg_get_expr(d.adbin, d.adrelid) !~ 'America/Argentina/Mendoza';
      if v_txt is null then
        ok := ok + 1; informe := informe || E'\nOK     (4) asistencias.fecha, pagos_socio.fecha, socios.ultimo_pago y xp_events.event_date: default en día de Argentina';
      else
        informe := informe || E'\nFALLA  (4) defaults que siguen en UTC: ' || v_txt;
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (4) ERROR: ' || sqlerrm;
    end;

    -- ══ NOCHE SIMULADA: desde acá, current_date de la sesión NO es el día de Argentina ══
    perform set_config('timezone', v_zona_falsa, true);

    -- ── (5) La simulación vale: current_date <> hoy en Argentina ────────────────────────
    total := total + 1;
    if current_date <> v_hoy then
      ok := ok + 1; informe := informe || E'\nOK     (5) noche simulada (' || v_zona_falsa || '): current_date = ' || current_date || ', hoy en Argentina = ' || v_hoy;
    else
      informe := informe || E'\nFALLA  (5) la simulación no sirve: current_date = hoy en Argentina (' || v_hoy || ') en ' || v_zona_falsa;
    end if;

    -- ── (6) Los 4 defaults, evaluados de noche, dan el día de Argentina ─────────────────
    total := total + 1;
    begin
      v_txt := null;
      for v_r in
        select x.tabla, x.columna, pg_get_expr(d.adbin, d.adrelid) as expr
        from (values ('asistencias', 'fecha'), ('pagos_socio', 'fecha'), ('socios', 'ultimo_pago'), ('xp_events', 'event_date')) as x(tabla, columna)
        join pg_attribute a on a.attrelid = ('public.' || x.tabla)::regclass and a.attname = x.columna
        join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      loop
        execute 'select (' || v_r.expr || ')::date' into v_fecha;
        if v_fecha is distinct from v_hoy then
          v_txt := coalesce(v_txt || ', ', '') || v_r.tabla || '.' || v_r.columna || ' da ' || coalesce(v_fecha::text, 'null');
        end if;
      end loop;
      if v_txt is null then
        ok := ok + 1; informe := informe || E'\nOK     (6) de noche, los 4 defaults dan ' || v_hoy;
      else
        informe := informe || E'\nFALLA  (6) ' || v_txt || ' (hoy en Argentina: ' || v_hoy || ')';
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (6) ERROR: ' || sqlerrm;
    end;

    -- ── (7) Check-in de noche: xp_events sin event_date queda con el día de Argentina ───
    -- (es lo que hacen el Check-in rápido, el trigger de asistencia y revertir XP)
    total := total + 1;
    begin
      v_ok := false;
      insert into xp_events (user_id, event_type, xp_amount, created_by)
      values (v_user, 'reversion', -1, v_user)
      returning event_date into v_fecha;
      v_ok := v_fecha = v_hoy;
      v_txt := coalesce(v_fecha::text, 'null');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (7) evento de XP insertado de noche sin fecha: event_date = ' || v_txt;
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (7) event_date = ' || v_txt || ', hoy en Argentina = ' || v_hoy;
      else informe := informe || E'\nFALLA  (7) ERROR: ' || sqlerrm; end if;
    end;

    -- ── (8) Mercado Pago de noche: fecha, periodo_desde y periodo_hasta ─────────────────
    -- Estado 'pending': solo inserta el pago, no acredita nada (no llama a acreditar_pack).
    total := total + 1;
    begin
      v_ok := false;
      v_mp_id := 'prueba-tanda-b-' || gen_random_uuid()::text;
      select * into v_r
      from public.mp_process_payment(v_user, null, '[]'::jsonb, true, 30, v_aparatos, 1, 'PRUEBA TANDA B', v_mp_id, 'pending');
      select fecha, periodo_desde, periodo_hasta, estado into v_pago
      from pagos_socio where mercado_pago_payment_id = v_mp_id;
      v_txt := 'fecha ' || coalesce(v_pago.fecha::text, 'null') || ', desde ' || coalesce(v_pago.periodo_desde::text, 'null')
               || ', hasta ' || coalesce(v_pago.periodo_hasta::text, 'null') || ', estado ' || coalesce(v_pago.estado, 'null')
               || ', otorgado ' || coalesce(v_r.credito_otorgado::text, 'null');
      v_ok := v_pago.fecha = v_hoy and v_pago.periodo_desde = v_hoy and v_pago.periodo_hasta = v_hoy + 30
              and v_pago.estado = 'pendiente' and v_r.credito_otorgado = false;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (8) mp_process_payment de noche: ' || v_txt;
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (8) ' || coalesce(v_txt, '?') || ' (hoy en Argentina: ' || v_hoy || ')';
      else informe := informe || E'\nFALLA  (8) ERROR: ' || sqlerrm; end if;
    end;

    -- ── (9) "¡Hoy entrené!" de noche: graba hoy y lo cuenta como hoy ────────────────────
    total := total + 1;
    begin
      v_ok := false;
      perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', v_user::text, true);
      -- Aparatos vigente (para tener una disciplina activa) y sin "Hoy entrené" de hoy ni de "mañana".
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
      values (v_user, v_aparatos, 0, now() + interval '10 days');
      delete from xp_events
      where user_id = v_user and event_type = 'asistencia' and discipline_id is null
        and event_date in (v_hoy, current_date);

      select * into v_r from public.registrar_hoy_entrene();
      select count(*) into v_n from xp_events
      where user_id = v_user and event_type = 'asistencia' and discipline_id is null and event_date = v_hoy;
      select count(*) into v_m from xp_events
      where user_id = v_user and event_type = 'asistencia' and discipline_id is null and event_date = current_date;
      v_txt := 'otorgado ' || coalesce(v_r.otorgado::text, 'null') || ', entrenamientos_hoy ' || coalesce(v_r.entrenamientos_hoy::text, 'null')
               || ', filas del ' || v_hoy || ': ' || v_n || ', filas del ' || current_date || ': ' || v_m;
      v_ok := v_r.otorgado and v_r.entrenamientos_hoy = 1 and v_n = 1 and v_m = 0;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (9) registrar_hoy_entrene de noche: ' || v_txt;
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (9) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (9) ERROR: ' || sqlerrm; end if;
    end;

    -- ── (10) Resetear ranking de noche: las reversiones quedan con el día de Argentina ──
    total := total + 1;
    begin
      v_ok := false;
      perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', v_admin::text, true);
      v_n := public.admin_resetear_ranking();
      select count(*), count(*) filter (where event_date is distinct from v_hoy) into v_m, v_n
      from (select event_date from xp_events where event_type = 'reversion' and created_at = now()) t;
      v_txt := v_m || ' reversiones, ' || v_n || ' con otro día';
      v_ok := v_n = 0;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (10) admin_resetear_ranking de noche (deshecho): ' || v_txt || ', todas del ' || v_hoy;
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (10) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (10) ERROR: ' || sqlerrm; end if;
    end;

    -- ── (11) Ranking del mes de noche = el mes de Argentina ─────────────────────────────
    total := total + 1;
    begin
      with manual as (
        select b.user_id, count(*)::int as clases
        from bookings b
        join profiles p on p.id = b.user_id
        join classes c on c.id = b.class_id
        join disciplines d on d.id = c.discipline_id
        where b.attended = true
          and d.kind = 'credits'
          and b.booking_date >= date_trunc('month', v_hoy)::date
          and b.booking_date <= v_hoy
        group by b.user_id
      ), funcion as (
        select * from public.community_ranking_mes(null)
      )
      select (select count(*) from funcion f left join manual m on m.user_id = f.user_id where m.clases is distinct from f.clases),
             (select count(*) from funcion) - least(20, (select count(*) from manual))
        into v_n, v_m;
      if v_n = 0 and v_m = 0 then
        ok := ok + 1; informe := informe || E'\nOK     (11) community_ranking_mes de noche: cuenta desde el 1 hasta el ' || v_hoy;
      else
        informe := informe || E'\nFALLA  (11) community_ranking_mes no coincide con el mes de Argentina (' || v_n || ' socios distintos, ' || v_m || ' de diferencia en filas)';
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (11) ERROR: ' || sqlerrm;
    end;

    raise exception '%', c_fin_casos;
  exception when others then
    if sqlerrm <> c_fin_casos then
      total := total + 1;
      informe := informe || E'\nFALLA  ERROR inesperado en los casos: ' || sqlerrm;
    end if;
  end;

  -- ── (l) Ya deshecha la subtransacción: no quedó ningún rastro ───────────────────────
  select md5(coalesce((select string_agg(concat_ws(':', id, event_type, xp_amount, event_date, discipline_id), ',' order by id)
                       from xp_events where user_id = v_user), '-')
             || '|' || (select count(*) from pagos_socio where paquete = 'PRUEBA TANDA B')::text
             || '|' || (select count(*) from xp_events where event_type = 'reversion')::text
             || '|' || coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                                 from user_credits where user_id = v_user), '-'))
    into v_huella_despues;
  total := total + 1;
  if v_huella_despues = v_huella_antes and current_date = v_hoy then
    ok := ok + 1; informe := informe || E'\nOK     (l) XP, créditos y pagos reales intactos; la sesión volvió a su zona horaria';
  else informe := informe || E'\nFALLA  (l) cambió algo real (o la zona horaria de la sesión no volvió)'; end if;

  -- ── Fin: SIEMPRE con error, para deshacer todo. ─────────────────────────────────────
  raise exception 'PRUEBA TANDA B TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
