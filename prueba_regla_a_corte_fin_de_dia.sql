-- =====================================================================================
-- PRUEBA de supabase_migration_regla_a_corte_fin_de_dia.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA REGLA A TERMINADA -- se deshizo todo"). El mensaje de ese error ES el informe:
-- "N de M OK" y una línea por chequeo.
--
-- Cómo corre:
--   * Se corre DESPUÉS de la migración. Antes, (0), (a) y (A1) a (A7) fallan (los lotes
--     nuevos vencen a la hora de "ahora", no a las 23:59:59.999999 AR).
--   * El candado T7 es DIFERIDO: se chequea al COMMIT y esta prueba nunca hace commit. Cada
--     caso, después de escribir, corre pg_temp.ra_candado() (SET CONSTRAINTS ... IMMEDIATE y
--     vuelta a DEFERRED), igual que prueba_t7.sql.
--   * Cada caso va en su propio bloque y se DESHACE solo al terminar (error interno a
--     propósito). Si un caso revienta, se informa como FALLA y siguen los demás.
--   * Cada caso arranca vencido (solo dentro del caso) todo lo vigente de la cuenta de test.
--   * Sesión simulada: el primer admin de profiles para las funciones de Admin. acreditar_pack
--     y resolver_fecha_plan_actual se llaman directo (como en prueba_t7.sql).
--   * "Corte" = ((día + 1)::timestamp at time zone AR) - 1 µs. Plan "a hora exacta" = hoy + 20
--     a las 11:05 AR (como los lotes de producción).
--   * Fechas relativas a HOY en Argentina. Evitar correrla justo alrededor de las 00:00.
-- =====================================================================================

do $prueba$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  c_fin_casos constant text := 'FIN_CASOS_RA';
  c_deshacer constant text := 'DESHACER_CASO_RA';
  c_dni constant text := '44537978';
  v_user uuid;
  v_admin uuid;
  v_aparatos uuid;
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_corte30 timestamptz;
  v_corte15 timestamptz;
  v_corte20 timestamptz;
  v_corte21 timestamptz;
  v_hora_exacta timestamptz;
  v_otra timestamptz;
  v_a uuid;
  v_b uuid;
  v_pack30 uuid;
  v_pack15 uuid;
  v_lote uuid;
  v_r record;
  v_ok boolean;
  v_err text;
  v_txt text;
  v_huella_antes text;
  v_huella_despues text;
  ok int := 0;
  total int := 0;
  informe text := '';
begin
  -- ── Preparación (fuera de los casos) ─────────────────────────────────────────────
  select id into v_user from profiles where dni = c_dni;
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  select id into v_admin from profiles where role = 'admin' order by created_at limit 1;
  if v_admin is null then
    raise exception 'No hay ningún perfil admin.';
  end if;
  if (select count(*) from disciplines where kind = 'membership') <> 1 then
    raise exception 'PRUEBA REGLA A: tiene que haber exactamente 1 disciplina membership (Aparatos). No se probó nada.';
  end if;
  select id into v_aparatos from disciplines where kind = 'membership';
  if not exists (select 1 from socios s join profiles p on p.dni = s.dni where p.id = v_user) then
    raise exception 'PRUEBA REGLA A: la cuenta de test (DNI 44537978) no tiene ficha en socios. No se probó nada.';
  end if;

  v_corte30     := ((v_hoy + 31)::timestamp at time zone c_zona) - interval '1 microsecond';
  v_corte15     := ((v_hoy + 16)::timestamp at time zone c_zona) - interval '1 microsecond';
  v_corte20     := ((v_hoy + 21)::timestamp at time zone c_zona) - interval '1 microsecond';
  v_corte21     := ((v_hoy + 22)::timestamp at time zone c_zona) - interval '1 microsecond';
  v_hora_exacta := ((v_hoy + 20)::timestamp + time '11:05') at time zone c_zona;
  v_otra        := ((v_hoy + 5)::timestamp + time '11:05') at time zone c_zona;

  -- Huella de todo lo real de la cuenta de test que la prueba puede tocar.
  select md5(coalesce((select string_agg(concat_ws(':', id, discipline_id, remaining_credits, expires_at, created_at), ',' order by id)
                       from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', s.id, s.plan, s.creditos, s.fecha_vencimiento, s.ultimo_pago), ',' order by s.id)
                                 from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
    into v_huella_antes;

  -- ── (0) La migración está aplicada ────────────────────────────────────────────────
  total := total + 1;
  begin
    select string_agg(b.funcion, ', ') into v_txt
    from respaldo.regla_a_funciones b
    where to_regprocedure(b.funcion) is null
       or md5(regexp_replace(pg_get_functiondef(to_regprocedure(b.funcion)), '\s+', '', 'g')) <> b.huella_nueva_sin_espacios
       or position(b.reemplazo in pg_get_functiondef(to_regprocedure(b.funcion))) = 0;
    if (select count(*) from respaldo.regla_a_funciones) = 6 and v_txt is null then
      ok := ok + 1; informe := informe || E'\nOK     (0) migración aplicada (las 6 funciones con la huella del respaldo y el corte de fin de día)';
    else informe := informe || E'\nFALLA  (0) no quedaron como dejó la migración: ' || coalesce(v_txt, 'faltan filas en el respaldo'); end if;
  exception when others then
    informe := informe || E'\nFALLA  (0) la migración no está aplicada (' || sqlerrm || ')';
  end;

  -- ── (a) Permisos EXACTAMENTE iguales a los de antes ──────────────────────────────
  total := total + 1;
  begin
    select string_agg(b.funcion || ' (antes ' || b.permisos || ', ahora ' || coalesce(p.proacl::text, '(por defecto)') || ')', ', ') into v_txt
    from respaldo.regla_a_funciones b
    join pg_proc p on p.oid = to_regprocedure(b.funcion)
    where coalesce(p.proacl::text, '(por defecto)') <> b.permisos or p.prosecdef <> b.security_definer;
    if v_txt is null then
      ok := ok + 1; informe := informe || E'\nOK     (a) permisos y security definer de las 6 iguales a antes';
    else informe := informe || E'\nFALLA  (a) ' || v_txt; end if;
  exception when others then
    informe := informe || E'\nFALLA  (a) ERROR: ' || sqlerrm;
  end;

  -- ── Casos: subtransacción que se deshace al final ─────────────────────────────────
  begin
    create function pg_temp.ra_como(p_user uuid) returns void language plpgsql as $f$
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', p_user::text, true);
    end;
    $f$;
    create function pg_temp.ra_limpiar(p_user uuid) returns void language sql as $f$
      update user_credits set expires_at = least(expires_at, now() - interval '2 days')
      where user_id = p_user and expires_at > now();
    $f$;
    create function pg_temp.ra_lote(p_user uuid, p_disc uuid, p_saldo int, p_vence timestamptz) returns uuid language sql as $f$
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
      values (p_user, p_disc, p_saldo, p_vence) returning id;
    $f$;
    create function pg_temp.ra_candado() returns void language plpgsql as $f$
    begin
      set constraints public.candado_una_fecha_vigente_ins, public.candado_una_fecha_vigente_upd immediate;
      set constraints public.candado_una_fecha_vigente_ins, public.candado_una_fecha_vigente_upd deferred;
    end;
    $f$;
    -- Cantidad de días distintos (AR) entre lo que el socio puede usar (criterio del candado).
    create function pg_temp.ra_fechas(p_user uuid) returns int language sql as $f$
      select count(distinct public.ultimo_dia_plan(uc.expires_at))::int
      from user_credits uc join disciplines d on d.id = uc.discipline_id
      where uc.user_id = p_user and uc.expires_at > now()
        and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership');
    $f$;
    -- Los expires_at DISTINTOS de las filas vigentes. Cada caso arranca con todo vencido, así que
    -- en (A1)-(A6) y (T7e) lo vigente es solo lo que acaba de crear la función.
    create function pg_temp.ra_nuevas(p_user uuid) returns timestamptz[] language sql as $f$
      select array_agg(distinct expires_at order by expires_at)
      from user_credits where user_id = p_user and expires_at > now();
    $f$;
    -- Corre ya el candado; devuelve 'SIN ERROR' o 'sqlstate mensaje'.
    create function pg_temp.ra_chequear() returns text language plpgsql as $f$
    begin
      perform pg_temp.ra_candado();
      return 'SIN ERROR';
    exception when others then
      return sqlstate || ' ' || sqlerrm;
    end;
    $f$;

    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA RA A ' || gen_random_uuid(), 'credits', false, false) returning id into v_a;
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA RA B ' || gen_random_uuid(), 'credits', false, false) returning id into v_b;
    insert into packs (name, price, incluye_aparatos, dias_vigencia, creditos, is_active)
    values ('PRUEBA RA 30 ' || gen_random_uuid(), 1, false, null,
            jsonb_build_array(jsonb_build_object('discipline_id', v_a, 'credits', 5)), false)
    returning id into v_pack30;
    insert into packs (name, price, incluye_aparatos, dias_vigencia, creditos, is_active)
    values ('PRUEBA RA 15 ' || gen_random_uuid(), 1, true, 15,
            jsonb_build_array(jsonb_build_object('discipline_id', v_a, 'credits', 3)), false)
    returning id into v_pack15;
    perform pg_temp.ra_candado();

    -- ════ Cada función crea el plan nuevo con corte al fin del día en Argentina ════

    -- (A1) acreditar_pack, pack SIN dias_vigencia (comprobante / MP): hoy + 30, fin del día.
    total := total + 1;
    begin
      perform pg_temp.ra_limpiar(v_user);
      select * into v_r from public.acreditar_pack(v_user, v_pack30, 'manual', null);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err = 'SIN ERROR' and v_r.creditos_otorgados = 5 and pg_temp.ra_nuevas(v_user) = array[v_corte30];
      v_txt := v_err || ' / vence ' || coalesce((pg_temp.ra_nuevas(v_user))::text, 'nada');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (A1) acreditar_pack sin dias_vigencia: vence hoy + 30 a las 23:59:59.999999 AR';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (A1) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (A1) ERROR: ' || sqlerrm; end if;
    end;

    -- (A2) acreditar_pack, pack de 15 días con Aparatos: créditos Y Aparatos al fin del día
    --      hoy + 15; lo devuelto y la ficha dicen hoy + 15 (el día no cambia).
    total := total + 1;
    begin
      perform pg_temp.ra_limpiar(v_user);
      select * into v_r from public.acreditar_pack(v_user, v_pack15, 'manual', null);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err = 'SIN ERROR'
              and pg_temp.ra_nuevas(v_user) = array[v_corte15]
              and exists (select 1 from user_credits where user_id = v_user and discipline_id = v_aparatos and expires_at = v_corte15)
              and v_r.nueva_fecha_vencimiento_aparatos = v_hoy + 15
              and (select bool_and(s.fecha_vencimiento = v_hoy + 15) from socios s join profiles p on p.dni = s.dni where p.id = v_user);
      v_txt := v_err || ' / vence ' || coalesce((pg_temp.ra_nuevas(v_user))::text, 'nada') || ' / devuelve ' || coalesce(v_r.nueva_fecha_vencimiento_aparatos::text, 'null');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (A2) acreditar_pack 15 días con Aparatos: todo al fin del día hoy + 15; ficha y respuesta = hoy + 15';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (A2) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (A2) ERROR: ' || sqlerrm; end if;
    end;

    -- (A3) Cobro manual SIN fecha de inicio (la rama que tenía la hora): fin del día hoy + 30.
    total := total + 1;
    begin
      perform pg_temp.ra_como(v_admin);
      perform pg_temp.ra_limpiar(v_user);
      perform public.admin_acreditar_creditos_manual(
        v_user, jsonb_build_array(jsonb_build_object('discipline_id', v_a, 'credits', 3)), true, 30, null);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err = 'SIN ERROR' and pg_temp.ra_nuevas(v_user) = array[v_corte30];
      v_txt := v_err || ' / vence ' || coalesce((pg_temp.ra_nuevas(v_user))::text, 'nada');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (A3) cobro manual sin fecha de inicio (con Aparatos): fin del día hoy + 30';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (A3) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (A3) ERROR: ' || sqlerrm; end if;
    end;

    -- (A3b) Cobro manual CON fecha de inicio = hoy (rama de T2, no se tocó): el MISMO corte.
    total := total + 1;
    begin
      perform pg_temp.ra_como(v_admin);
      perform pg_temp.ra_limpiar(v_user);
      perform public.admin_acreditar_creditos_manual(
        v_user, jsonb_build_array(jsonb_build_object('discipline_id', v_a, 'credits', 3)), true, 30, v_hoy);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err = 'SIN ERROR' and pg_temp.ra_nuevas(v_user) = array[v_corte30];
      v_txt := v_err || ' / vence ' || coalesce((pg_temp.ra_nuevas(v_user))::text, 'nada');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (A3b) cobro manual con fecha de inicio hoy: el mismo corte que sin fecha';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (A3b) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (A3b) ERROR: ' || sqlerrm; end if;
    end;

    -- (A4) Fijar créditos sin plan vigente: fin del día hoy + 30.
    total := total + 1;
    begin
      perform pg_temp.ra_como(v_admin);
      perform pg_temp.ra_limpiar(v_user);
      perform public.admin_fijar_creditos_disciplina(v_user, v_b, 4);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err = 'SIN ERROR' and pg_temp.ra_nuevas(v_user) = array[v_corte30];
      v_txt := v_err || ' / vence ' || coalesce((pg_temp.ra_nuevas(v_user))::text, 'nada');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (A4) fijar créditos sin plan: fin del día hoy + 30';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (A4) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (A4) ERROR: ' || sqlerrm; end if;
    end;

    -- (A5) Ajustar +2 sin plan vigente: fin del día hoy + 30.
    total := total + 1;
    begin
      perform pg_temp.ra_como(v_admin);
      perform pg_temp.ra_limpiar(v_user);
      perform public.admin_ajustar_credito_disciplina(v_user, v_b, 2);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err = 'SIN ERROR' and pg_temp.ra_nuevas(v_user) = array[v_corte30];
      v_txt := v_err || ' / vence ' || coalesce((pg_temp.ra_nuevas(v_user))::text, 'nada');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (A5) ajustar +2 sin plan: fin del día hoy + 30';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (A5) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (A5) ERROR: ' || sqlerrm; end if;
    end;

    -- (A6) Agregar Aparatos sin plan vigente: fin del día hoy + 30 y la ficha = hoy + 30.
    total := total + 1;
    begin
      perform pg_temp.ra_como(v_admin);
      perform pg_temp.ra_limpiar(v_user);
      perform public.admin_agregar_aparatos_socio(v_user);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err = 'SIN ERROR' and pg_temp.ra_nuevas(v_user) = array[v_corte30]
              and (select bool_and(s.fecha_vencimiento = v_hoy + 30) from socios s join profiles p on p.dni = s.dni where p.id = v_user);
      v_txt := v_err || ' / vence ' || coalesce((pg_temp.ra_nuevas(v_user))::text, 'nada');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (A6) agregar Aparatos sin plan: fin del día hoy + 30, ficha hoy + 30';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (A6) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (A6) ERROR: ' || sqlerrm; end if;
    end;

    -- (A7) resolver_fecha_plan_actual sin plan: fin del día hoy + 30; y el DÍA es el mismo que
    --      daba la versión vieja (now() + 30 días).
    total := total + 1;
    begin
      perform pg_temp.ra_limpiar(v_user);
      if public.resolver_fecha_plan_actual(v_user) = v_corte30
         and public.ultimo_dia_plan(v_corte30) = public.ultimo_dia_plan(now() + interval '30 days') then
        ok := ok + 1; informe := informe || E'\nOK     (A7) resolver_fecha_plan_actual sin plan: fin del día hoy + 30 (mismo día que now() + 30)';
      else informe := informe || E'\nFALLA  (A7) devolvió ' || coalesce(public.resolver_fecha_plan_actual(v_user)::text, 'null'); end if;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm <> c_deshacer then informe := informe || E'\nFALLA  (A7) ERROR: ' || sqlerrm; end if;
    end;

    -- ════ Candado T7: hora exacta y fin de día conviven si son el MISMO día ════

    -- (T7a) Plan existente a hora exacta (hoy + 20, 11:05): ajustar +1 en otra disciplina hereda
    --       ESA hora (los existentes no se tocan), el candado pasa y queda 1 fecha.
    total := total + 1;
    begin
      perform pg_temp.ra_como(v_admin);
      perform pg_temp.ra_limpiar(v_user);
      v_lote := pg_temp.ra_lote(v_user, v_a, 3, v_hora_exacta);
      perform pg_temp.ra_candado();
      perform public.admin_ajustar_credito_disciplina(v_user, v_b, 1);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err = 'SIN ERROR' and pg_temp.ra_fechas(v_user) = 1
              and (select expires_at from user_credits where id = v_lote) = v_hora_exacta
              and exists (select 1 from user_credits where user_id = v_user and discipline_id = v_b and remaining_credits = 1 and expires_at = v_hora_exacta);
      v_txt := v_err || ' / fechas ' || pg_temp.ra_fechas(v_user);
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (T7a) plan a las 11:05: ajustar +1 hereda las 11:05, el lote viejo no se toca, 1 fecha';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (T7a) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (T7a) ERROR: ' || sqlerrm; end if;
    end;

    -- (T7b) Igual con agregar Aparatos.
    total := total + 1;
    begin
      perform pg_temp.ra_como(v_admin);
      perform pg_temp.ra_limpiar(v_user);
      perform pg_temp.ra_lote(v_user, v_a, 3, v_hora_exacta);
      perform pg_temp.ra_candado();
      perform public.admin_agregar_aparatos_socio(v_user);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err = 'SIN ERROR' and pg_temp.ra_fechas(v_user) = 1
              and exists (select 1 from user_credits where user_id = v_user and discipline_id = v_aparatos and expires_at = v_hora_exacta);
      v_txt := v_err || ' / fechas ' || pg_temp.ra_fechas(v_user);
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (T7b) plan a las 11:05: agregar Aparatos hereda las 11:05, 1 fecha';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (T7b) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (T7b) ERROR: ' || sqlerrm; end if;
    end;

    -- (T7c) Mismo día, distinta hora: un lote a las 11:05 y otro a las 23:59:59.999999 de hoy + 20.
    --       El candado compara por día: pasa.
    total := total + 1;
    begin
      perform pg_temp.ra_limpiar(v_user);
      perform pg_temp.ra_lote(v_user, v_a, 3, v_hora_exacta);
      perform pg_temp.ra_lote(v_user, v_b, 2, v_corte20);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err = 'SIN ERROR' and pg_temp.ra_fechas(v_user) = 1;
      v_txt := v_err;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (T7c) 11:05 y 23:59:59.999999 del mismo día: el candado pasa (una sola fecha)';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (T7c) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (T7c) ERROR: ' || sqlerrm; end if;
    end;

    -- (T7d) Control: 11:05 de hoy + 20 y fin del día de hoy + 21 SÍ son dos fechas: 23514.
    total := total + 1;
    begin
      perform pg_temp.ra_limpiar(v_user);
      perform pg_temp.ra_lote(v_user, v_a, 3, v_hora_exacta);
      perform pg_temp.ra_lote(v_user, v_b, 2, v_corte21);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err like '23514 %';
      v_txt := v_err;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (T7d) control: días distintos siguen frenados por el candado (23514)';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (T7d) se esperaba 23514 y dio: ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (T7d) ERROR: ' || sqlerrm; end if;
    end;

    -- (T7e) acreditar_pack sobre un plan a hora exacta de OTRO día (hoy + 5, 11:05): vence lo
    --       viejo, crea hoy + 30 fin del día, el candado pasa y queda 1 fecha.
    total := total + 1;
    begin
      perform pg_temp.ra_limpiar(v_user);
      v_lote := pg_temp.ra_lote(v_user, v_b, 4, v_otra);
      perform pg_temp.ra_candado();
      perform public.acreditar_pack(v_user, v_pack30, 'manual', null);
      v_err := pg_temp.ra_chequear();
      v_ok := v_err = 'SIN ERROR' and pg_temp.ra_fechas(v_user) = 1
              and (select remaining_credits = 0 and expires_at <= now() from user_credits where id = v_lote)
              and pg_temp.ra_nuevas(v_user) = array[v_corte30];
      v_txt := v_err || ' / fechas ' || pg_temp.ra_fechas(v_user);
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (T7e) acreditar_pack sobre un plan a hora exacta de otro día: lo viejo vence, 1 fecha (hoy + 30 fin de día)';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (T7e) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (T7e) ERROR: ' || sqlerrm; end if;
    end;

    raise exception '%', c_fin_casos;
  exception when others then
    if sqlerrm <> c_fin_casos then
      total := total + 1;
      informe := informe || E'\nFALLA  ERROR inesperado en los casos: ' || sqlerrm;
    end if;
  end;

  -- ── (l) Ya deshecha la subtransacción: lo real de la cuenta de test quedó igual ────
  select md5(coalesce((select string_agg(concat_ws(':', id, discipline_id, remaining_credits, expires_at, created_at), ',' order by id)
                       from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', s.id, s.plan, s.creditos, s.fecha_vencimiento, s.ultimo_pago), ',' order by s.id)
                                 from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
    into v_huella_despues;
  total := total + 1;
  if v_huella_despues = v_huella_antes then
    ok := ok + 1; informe := informe || E'\nOK     (l) créditos y ficha reales de la cuenta de test intactos';
  else informe := informe || E'\nFALLA  (l) cambió algo real de la cuenta de test'; end if;

  -- ── Fin: SIEMPRE con error, para deshacer todo. ─────────────────────────────────────
  raise exception 'PRUEBA REGLA A TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
