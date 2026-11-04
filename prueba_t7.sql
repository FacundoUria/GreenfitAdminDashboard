-- =====================================================================================
-- PRUEBA de T7 -- supabase_migration_t7_candado_una_fecha.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA T7 TERMINADA -- se deshizo todo"). El mensaje de ese error ES el informe:
-- "N de M OK" y una línea por chequeo.
--
-- Cómo corre:
--   * Se corre DESPUÉS de la migración. Antes, (0) falla y los casos que esperan el error del
--     candado dan "SIN ERROR".
--   * El candado es DIFERIDO: se chequea al COMMIT, y esta prueba nunca hace commit. Por eso cada
--     caso, después de escribir, corre pg_temp.t7_candado(): SET CONSTRAINTS ... IMMEDIATE (eso
--     ejecuta en ese momento los chequeos pendientes, igual que el COMMIT) y vuelve a DEFERRED.
--   * Cada caso va en su propio bloque y se DESHACE solo al terminar (error interno a propósito):
--     sus filas, sus chequeos pendientes y la sesión simulada no pasan al caso siguiente. Si un
--     caso revienta, se informa como FALLA y siguen los demás.
--   * Cada caso arranca vencido (solo dentro del caso) todo lo vigente de la cuenta de test.
--     Vencer filas no dispara el candado.
--   * "No dispara el candado": el caso arma primero un socio YA ROTO (2 fechas vigentes) sin dejar
--     chequeos pendientes -- un lote de saldo null en una disciplina de prueba de créditos (no
--     cuenta), y DESPUÉS esa disciplina se pasa a membership (no es una escritura en user_credits).
--     Si la operación disparara el candado, el chequeo vería las 2 fechas y daría error.
--   * Sesión simulada (request.jwt.claims, local a la transacción): el primer admin de profiles
--     para las funciones de Admin; la cuenta de test para book_class y cancel_booking_detalle.
--     _cancelar_reserva_por_gimnasio (interna) se llama directo. acreditar_pack, directo.
--   * Fecha del plan: hoy + 20 a las 18:00 de Argentina. "Otra fecha": hoy + 5 a las 12:00.
--     Reservas desde hoy + 40. Evitar correrla justo alrededor de las 00:00 de Argentina.
--   * La cuenta de test necesita ficha en socios (las funciones de T2/T3 la exigen).
-- =====================================================================================

do $prueba$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  c_fin_casos constant text := 'FIN_CASOS_T7';
  c_deshacer constant text := 'DESHACER_CASO_T7';
  c_dni constant text := '44537978';
  v_user uuid;
  v_admin uuid;
  v_aparatos uuid;
  v_nombre text;
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_plan timestamptz;
  v_otra timestamptz;
  v_otra2 timestamptz;
  v_base date;
  v_a uuid;
  v_b uuid;
  v_disfraz uuid;
  v_clase_a uuid;
  v_pack uuid;
  l1 uuid;
  l2 uuid;
  l3 uuid;
  v_r jsonb;
  v_ok boolean;
  v_err text;
  v_estado text;
  v_esperado text;
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
    raise exception 'PRUEBA T7: tiene que haber exactamente 1 disciplina de tipo membership (Aparatos). No se probó nada.';
  end if;
  select id into v_aparatos from disciplines where kind = 'membership';
  if not exists (select 1 from socios s join profiles p on p.dni = s.dni where p.id = v_user) then
    raise exception 'PRUEBA T7: la cuenta de test (DNI 44537978) no tiene ficha en socios. No se probó nada.';
  end if;

  -- Mismo nombre que pone el candado en el mensaje.
  select coalesce(nullif(trim(p.full_name), ''),
                  (select nullif(trim(coalesce(s.nombre, '') || ' ' || coalesce(s.apellido, '')), '')
                   from socios s where s.dni = p.dni order by s.id limit 1),
                  'sin nombre (DNI ' || p.dni || ')')
    into v_nombre
  from profiles p where p.id = v_user;

  v_plan  := ((v_hoy + 20)::timestamp + time '18:00') at time zone c_zona;
  v_otra  := ((v_hoy + 5)::timestamp + time '12:00') at time zone c_zona;
  v_otra2 := ((v_hoy + 7)::timestamp + time '12:00') at time zone c_zona;
  v_base  := v_hoy + 40;

  -- Mensaje esperado cuando el socio queda con la "otra fecha" y la del plan.
  v_esperado := format('El socio %s quedaría con dos fechas de vencimiento vigentes (%s y %s). No se guardó nada.',
                       v_nombre, to_char(v_hoy + 5, 'DD/MM'), to_char(v_hoy + 20, 'DD/MM'));

  -- Huella de todo lo real de la cuenta de test que la prueba puede tocar.
  select md5(coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at, created_at), ',' order by id)
                       from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', id, class_id, booking_date, credit_lote_id), ',' order by id)
                                 from bookings where user_id = v_user), '-')
             || '|' || (select count(*) from booking_cancellations where user_id = v_user)::text
             || '|' || coalesce((select string_agg(concat_ws(':', s.id, s.creditos, s.fecha_vencimiento), ',' order by s.id)
                                 from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
    into v_huella_antes;

  -- ── (0a) Los dos triggers: de restricción, DEFERRABLE INITIALLY DEFERRED, habilitados ──
  total := total + 1;
  if (select count(*) from pg_trigger t
      where t.tgrelid = 'public.user_credits'::regclass
        and t.tgname in ('candado_una_fecha_vigente_ins', 'candado_una_fecha_vigente_upd')
        and t.tgfoid = to_regprocedure('public.candado_una_fecha_vigente()')
        and t.tgconstraint <> 0 and t.tgdeferrable and t.tginitdeferred and t.tgenabled = 'O') = 2 then
    ok := ok + 1; informe := informe || E'\nOK     (0a) los 2 triggers del candado: de restricción, diferidos y habilitados';
  else informe := informe || E'\nFALLA  (0a) la migración T7 no está aplicada (o los triggers no son diferidos)'; end if;

  -- ── (0b) La función: SECURITY DEFINER y sin EXECUTE para public, anon ni authenticated ──
  total := total + 1;
  begin
    if (select prosecdef and proacl is not null from pg_proc where oid = 'public.candado_una_fecha_vigente()'::regprocedure)
       and not has_function_privilege('anon', 'public.candado_una_fecha_vigente()', 'execute')
       and not has_function_privilege('authenticated', 'public.candado_una_fecha_vigente()', 'execute')
       and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                       where p.oid = 'public.candado_una_fecha_vigente()'::regprocedure
                         and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      ok := ok + 1; informe := informe || E'\nOK     (0b) candado_una_fecha_vigente(): SECURITY DEFINER, nadie de afuera la ejecuta';
    else informe := informe || E'\nFALLA  (0b) permisos de candado_una_fecha_vigente()'; end if;
  exception when others then
    informe := informe || E'\nFALLA  (0b) ERROR: ' || sqlerrm;
  end;

  -- ── Casos: subtransacción que se deshace al final ─────────────────────────────────
  begin
    create function pg_temp.t7_como(p_user uuid) returns void language plpgsql as $f$
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', p_user::text, true);
    end;
    $f$;
    create function pg_temp.t7_limpiar(p_user uuid) returns void language sql as $f$
      update user_credits set expires_at = least(expires_at, now() - interval '2 days')
      where user_id = p_user and expires_at > now();
    $f$;
    create function pg_temp.t7_lote(p_user uuid, p_disc uuid, p_saldo int, p_vence timestamptz) returns uuid language sql as $f$
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
      values (p_user, p_disc, p_saldo, p_vence) returning id;
    $f$;
    create function pg_temp.t7_saldo(p_lote uuid) returns int language sql as $f$
      select remaining_credits from user_credits where id = p_lote;
    $f$;
    -- R1: cantidad de días distintos (Argentina) entre lo que el socio puede usar.
    create function pg_temp.t7_fechas(p_user uuid) returns int language sql as $f$
      select count(distinct public.ultimo_dia_plan(uc.expires_at))::int
      from user_credits uc join disciplines d on d.id = uc.discipline_id
      where uc.user_id = p_user and uc.expires_at > now()
        and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership');
    $f$;
    -- El día (Argentina) de lo que el socio puede usar; null si no hay exactamente uno.
    create function pg_temp.t7_dia(p_user uuid) returns date language sql as $f$
      select case when count(distinct public.ultimo_dia_plan(uc.expires_at)) = 1
                  then min(public.ultimo_dia_plan(uc.expires_at)) end
      from user_credits uc join disciplines d on d.id = uc.discipline_id
      where uc.user_id = p_user and uc.expires_at > now()
        and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership');
    $f$;
    -- Lo que hace el COMMIT: corre ya los chequeos pendientes del candado.
    create function pg_temp.t7_candado() returns void language plpgsql as $f$
    begin
      set constraints public.candado_una_fecha_vigente_ins, public.candado_una_fecha_vigente_upd immediate;
      set constraints public.candado_una_fecha_vigente_ins, public.candado_una_fecha_vigente_upd deferred;
    end;
    $f$;
    -- Socio YA ROTO sin chequeos pendientes: un lote de saldo null en p_disfraz (de créditos: no
    -- cuenta, el chequeo pasa) y después p_disfraz pasa a membership (ahora sí cuenta).
    create function pg_temp.t7_romper(p_user uuid, p_disfraz uuid, p_vence timestamptz) returns void language plpgsql as $f$
    begin
      perform pg_temp.t7_lote(p_user, p_disfraz, null, p_vence);
      perform pg_temp.t7_candado();
      update disciplines set kind = 'membership' where id = p_disfraz;
    end;
    $f$;

    -- Disciplinas, clase y pack de prueba (ocultos e inactivos).
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T7 A ' || gen_random_uuid(), 'credits', false, false) returning id into v_a;
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T7 B ' || gen_random_uuid(), 'credits', false, false) returning id into v_b;
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T7 DISFRAZ ' || gen_random_uuid(), 'credits', false, false) returning id into v_disfraz;
    insert into classes (title, discipline_id, capacity, days_of_week, start_time, end_time)
    values ('PRUEBA T7 A', v_a, 50, '{0,1,2,3,4,5,6}', '23:00', '23:30') returning id into v_clase_a;
    insert into packs (name, price, incluye_aparatos, dias_vigencia, creditos, is_active)
    values ('PRUEBA T7 ' || gen_random_uuid(), 1, false, null,
            jsonb_build_array(jsonb_build_object('discipline_id', v_a, 'credits', 5)), false)
    returning id into v_pack;

    -- Que todo lo creado arriba no deje chequeos pendientes para los casos.
    perform pg_temp.t7_candado();

    -- ════ El candado frena lo que agrega una 2ª fecha ════

    -- (1) INSERT directo de un lote con saldo de otra fecha: error con el nombre y las 2 fechas.
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t7_candado();
      perform pg_temp.t7_lote(v_user, v_b, 2, v_otra);
      v_err := 'SIN ERROR'; v_estado := null;
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm; v_estado := sqlstate;
      end;
      v_ok := v_err = v_esperado and v_estado = '23514';
      v_txt := coalesce(v_estado, '-') || ' ' || v_err;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (1) INSERT directo con otra fecha: "' || v_err || '"';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (1) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (1) ERROR: ' || sqlerrm; end if;
    end;

    -- (2) UPDATE que mueve un lote con saldo a otra fecha: error.
    total := total + 1;
    begin
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      l2 := pg_temp.t7_lote(v_user, v_b, 2, v_plan);
      perform pg_temp.t7_candado();
      update user_credits set expires_at = v_otra where id = l2;
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = v_esperado;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (2) UPDATE que mueve un lote con saldo a otra fecha: error del candado';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (2) ' || coalesce(v_err, '?');
      else informe := informe || E'\nFALLA  (2) ERROR: ' || sqlerrm; end if;
    end;

    -- (3) Un lote en 0 de otra fecha que pasa a 1: error.
    total := total + 1;
    begin
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      l2 := pg_temp.t7_lote(v_user, v_b, 0, v_otra);
      perform pg_temp.t7_candado();
      update user_credits set remaining_credits = 1 where id = l2;
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = v_esperado;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (3) lote en 0 de otra fecha que pasa a 1: error del candado';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (3) ' || coalesce(v_err, '?');
      else informe := informe || E'\nFALLA  (3) ERROR: ' || sqlerrm; end if;
    end;

    -- (4) Una fila de Aparatos de otra fecha: error.
    total := total + 1;
    begin
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t7_candado();
      perform pg_temp.t7_lote(v_user, v_aparatos, null, v_otra);
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = v_esperado;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (4) Aparatos de otra fecha: error del candado';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (4) ' || coalesce(v_err, '?');
      else informe := informe || E'\nFALLA  (4) ERROR: ' || sqlerrm; end if;
    end;

    -- (5) Diferido: en el medio de la transacción puede haber 2 fechas; al final, una. Pasa.
    total := total + 1;
    begin
      perform pg_temp.t7_limpiar(v_user);
      l1 := pg_temp.t7_lote(v_user, v_a, 2, v_otra);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      update user_credits set remaining_credits = 0, expires_at = now() - interval '1 day' where id = l1;
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and pg_temp.t7_fechas(v_user) = 1;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (5) diferido: 2 fechas a mitad de camino y 1 al final, pasa';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (5) ' || coalesce(v_err, '?');
      else informe := informe || E'\nFALLA  (5) ERROR: ' || sqlerrm; end if;
    end;

    -- ════ Los flujos de verdad siguen andando ════

    -- (6) Cobro manual (admin_acreditar_creditos_manual) con Aparatos, sobre un plan de otra fecha.
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_otra);
      perform pg_temp.t7_lote(v_user, v_b, 0, v_otra2);
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
      values (v_user, v_aparatos, null, v_otra, now() - interval '1 day');
      perform pg_temp.t7_candado();
      perform public.admin_acreditar_creditos_manual(
        v_user, jsonb_build_array(jsonb_build_object('discipline_id', v_a, 'credits', 3)), true, 30, v_hoy);
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and pg_temp.t7_dia(v_user) = v_hoy + 30;
      v_txt := v_err || ' / día ' || coalesce(pg_temp.t7_dia(v_user)::text, 'no hay uno solo');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (6) cobro manual con Aparatos: pasa, queda una sola fecha (hoy + 30)';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (6) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (6) ERROR: ' || sqlerrm; end if;
    end;

    -- (7) acreditar_pack sobre un plan de otra fecha.
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 2, v_otra);
      perform pg_temp.t7_lote(v_user, v_b, 4, v_otra);
      perform pg_temp.t7_candado();
      perform public.acreditar_pack(v_user, v_pack, 'manual', null);
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and pg_temp.t7_fechas(v_user) = 1
              and (select sum(remaining_credits) from user_credits
                   where user_id = v_user and discipline_id = v_a and expires_at > now()) = 5;
      v_txt := v_err || ' / fechas ' || pg_temp.t7_fechas(v_user);
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (7) acreditar_pack: pasa, queda una sola fecha y los 5 créditos del pack';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (7) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (7) ERROR: ' || sqlerrm; end if;
    end;

    -- (8) Editar fecha (mueve todo: saldo, Aparatos y un lote en 0 de otra fecha).
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t7_lote(v_user, v_b, 0, v_otra);
      perform pg_temp.t7_lote(v_user, v_aparatos, null, v_plan);
      perform pg_temp.t7_candado();
      perform public.admin_editar_fecha_vencimiento_socio(v_user, v_hoy + 10);
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and pg_temp.t7_dia(v_user) = v_hoy + 10;
      v_txt := v_err || ' / día ' || coalesce(pg_temp.t7_dia(v_user)::text, 'no hay uno solo');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (8) editar fecha: pasa, todo queda en el día nuevo (hoy + 10)';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (8) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (8) ERROR: ' || sqlerrm; end if;
    end;

    -- (9) Fijar créditos de otra disciplina (lote nuevo con la fecha del plan).
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t7_candado();
      perform public.admin_fijar_creditos_disciplina(v_user, v_b, 4);
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and pg_temp.t7_dia(v_user) = v_hoy + 20
              and (select sum(remaining_credits) from user_credits
                   where user_id = v_user and discipline_id = v_b and expires_at > now()) = 4;
      v_txt := v_err || ' / día ' || coalesce(pg_temp.t7_dia(v_user)::text, 'no hay uno solo');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (9) fijar: pasa, el lote nuevo queda en la fecha del plan';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (9) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (9) ERROR: ' || sqlerrm; end if;
    end;

    -- (10) Ajustar +1 (sobre un lote del plan en 0: pasa de 0 a 1, dispara y pasa) y −1.
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t7_lote(v_user, v_b, 0, v_plan);
      perform pg_temp.t7_candado();
      perform public.admin_ajustar_credito_disciplina(v_user, v_b, 1);
      perform public.admin_ajustar_credito_disciplina(v_user, v_a, -1);
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and pg_temp.t7_dia(v_user) = v_hoy + 20
              and (select sum(remaining_credits) from user_credits
                   where user_id = v_user and discipline_id = v_a and expires_at > now()) = 2
              and (select sum(remaining_credits) from user_credits
                   where user_id = v_user and discipline_id = v_b and expires_at > now()) = 1;
      v_txt := v_err || ' / día ' || coalesce(pg_temp.t7_dia(v_user)::text, 'no hay uno solo');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (10) ajustar +1 y −1: pasa, A = 2 y B = 1, una sola fecha';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (10) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (10) ERROR: ' || sqlerrm; end if;
    end;

    -- (11) Agregar Aparatos (con la fecha del plan).
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t7_candado();
      perform public.admin_agregar_aparatos_socio(v_user);
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and pg_temp.t7_dia(v_user) = v_hoy + 20
              and exists (select 1 from user_credits where user_id = v_user and discipline_id = v_aparatos and expires_at = v_plan);
      v_txt := v_err || ' / día ' || coalesce(pg_temp.t7_dia(v_user)::text, 'no hay uno solo');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (11) agregar Aparatos: pasa, con la fecha del plan';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (11) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (11) ERROR: ' || sqlerrm; end if;
    end;

    -- ════ Lo que NO dispara el candado (socio ya roto: si disparara, daría error) ════

    -- (12) Reservar (book_class): baja de saldo, no dispara.
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      l1 := pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t7_romper(v_user, v_disfraz, v_otra);
      v_txt := 'roto con ' || pg_temp.t7_fechas(v_user) || ' fechas';
      perform pg_temp.t7_como(v_user);
      perform public.book_class(v_clase_a, v_base + 1);
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and pg_temp.t7_saldo(l1) = 2 and pg_temp.t7_fechas(v_user) = 2;
      v_txt := v_txt || ' / ' || v_err || ' / saldo ' || coalesce(pg_temp.t7_saldo(l1)::text, 'null');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (12) reservar (book_class): no dispara el candado';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (12) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (12) ERROR: ' || sqlerrm; end if;
    end;

    -- (13) Cancelar el socio (cancel_booking_detalle) a un lote con saldo: no dispara.
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      l1 := pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t7_romper(v_user, v_disfraz, v_otra);
      perform pg_temp.t7_como(v_user);
      perform public.book_class(v_clase_a, v_base + 2);
      perform pg_temp.t7_candado();
      v_r := public.cancel_booking_detalle(v_clase_a, v_base + 2, 'prueba T7');
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and (v_r->>'reintegrado')::boolean and pg_temp.t7_saldo(l1) = 3
              and pg_temp.t7_fechas(v_user) = 2;
      v_txt := v_err || ' / ' || coalesce(v_r::text, 'null') || ' / saldo ' || coalesce(pg_temp.t7_saldo(l1)::text, 'null');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (13) cancelar el socio (cancel_booking_detalle): devuelve y no dispara el candado';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (13) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (13) ERROR: ' || sqlerrm; end if;
    end;

    -- (14) Cancelar el gimnasio (_cancelar_reserva_por_gimnasio) a un lote con saldo: no dispara.
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      l1 := pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t7_romper(v_user, v_disfraz, v_otra);
      perform pg_temp.t7_como(v_user);
      perform public.book_class(v_clase_a, v_base + 3);
      perform pg_temp.t7_candado();
      v_r := public._cancelar_reserva_por_gimnasio(v_user, v_clase_a, v_base + 3, 'prueba T7', 'quitar');
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and (v_r->>'reintegrado')::boolean and pg_temp.t7_saldo(l1) = 3
              and pg_temp.t7_fechas(v_user) = 2;
      v_txt := v_err || ' / ' || coalesce(v_r::text, 'null') || ' / saldo ' || coalesce(pg_temp.t7_saldo(l1)::text, 'null');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (14) cancelar el gimnasio: devuelve y no dispara el candado';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (14) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (14) ERROR: ' || sqlerrm; end if;
    end;

    -- (15) Un lote en 0 de otra fecha (insertado, y después movido de fecha): no dispara.
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t7_romper(v_user, v_disfraz, v_otra);
      l2 := pg_temp.t7_lote(v_user, v_b, 0, v_otra2);
      update user_credits set expires_at = v_otra2 + interval '1 day' where id = l2;
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and pg_temp.t7_fechas(v_user) = 2;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (15) lote en 0 de otra fecha (alta y cambio de fecha): no dispara el candado';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (15) ' || coalesce(v_err, '?');
      else informe := informe || E'\nFALLA  (15) ERROR: ' || sqlerrm; end if;
    end;

    -- ════ Cuando sí dispara, los lotes en 0 y los sin fecha no cuentan ════

    -- (16) Lote del plan en 0 que vuelve a 1 al cancelar (socio y gimnasio): dispara y pasa.
    total := total + 1;
    v_txt := null;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      l1 := pg_temp.t7_lote(v_user, v_a, 1, v_plan);
      perform pg_temp.t7_lote(v_user, v_b, 0, v_otra);
      perform pg_temp.t7_como(v_user);
      perform public.book_class(v_clase_a, v_base + 4);
      perform pg_temp.t7_candado();
      v_txt := 'tras reservar ' || coalesce(pg_temp.t7_saldo(l1)::text, 'null');
      v_r := public.cancel_booking_detalle(v_clase_a, v_base + 4, null);
      perform pg_temp.t7_candado();
      v_txt := v_txt || ' / socio: ' || coalesce(v_r->>'motivo', '?') || ' ' || coalesce(pg_temp.t7_saldo(l1)::text, 'null');
      v_ok := (v_r->>'reintegrado')::boolean and pg_temp.t7_saldo(l1) = 1;
      perform public.book_class(v_clase_a, v_base + 5);
      perform pg_temp.t7_candado();
      v_r := public._cancelar_reserva_por_gimnasio(v_user, v_clase_a, v_base + 5, null, 'quitar');
      perform pg_temp.t7_candado();
      v_txt := v_txt || ' / gimnasio: ' || coalesce(v_r->>'motivo', '?') || ' ' || coalesce(pg_temp.t7_saldo(l1)::text, 'null');
      v_ok := v_ok and (v_r->>'reintegrado')::boolean and pg_temp.t7_saldo(l1) = 1 and pg_temp.t7_fechas(v_user) = 1;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (16) lote del plan de 0 a 1 al cancelar (socio y gimnasio): dispara y pasa';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (16) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (16) ERROR: ' || sqlerrm || ' (' || coalesce(v_txt, '-') || ')'; end if;
    end;

    -- (17) Un lote en 0 de otra fecha y un lote sin fecha (expires_at null) no cuentan: con ellos
    --      presentes, una escritura que sí dispara (Aparatos en la fecha del plan) pasa.
    total := total + 1;
    begin
      perform pg_temp.t7_como(v_admin);
      perform pg_temp.t7_limpiar(v_user);
      perform pg_temp.t7_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t7_lote(v_user, v_b, 0, v_otra);
      perform pg_temp.t7_lote(v_user, v_b, 5, null);
      perform pg_temp.t7_lote(v_user, v_aparatos, null, v_plan);
      v_err := 'SIN ERROR';
      begin
        perform pg_temp.t7_candado();
      exception when others then v_err := sqlerrm;
      end;
      v_ok := v_err = 'SIN ERROR' and pg_temp.t7_fechas(v_user) = 1;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (17) lotes en 0 y sin fecha no cuentan: Aparatos en la fecha del plan pasa';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (17) ' || coalesce(v_err, '?');
      else informe := informe || E'\nFALLA  (17) ERROR: ' || sqlerrm; end if;
    end;

    raise exception '%', c_fin_casos;
  exception when others then
    if sqlerrm <> c_fin_casos then
      total := total + 1;
      informe := informe || E'\nFALLA  ERROR inesperado en los casos: ' || sqlerrm;
    end if;
  end;

  -- ── (l) Ya deshecha la subtransacción: lo real de la cuenta de test quedó igual ────
  select md5(coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at, created_at), ',' order by id)
                       from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', id, class_id, booking_date, credit_lote_id), ',' order by id)
                                 from bookings where user_id = v_user), '-')
             || '|' || (select count(*) from booking_cancellations where user_id = v_user)::text
             || '|' || coalesce((select string_agg(concat_ws(':', s.id, s.creditos, s.fecha_vencimiento), ',' order by s.id)
                                 from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
    into v_huella_despues;
  total := total + 1;
  if v_huella_despues = v_huella_antes then
    ok := ok + 1; informe := informe || E'\nOK     (l) créditos, reservas, cancelaciones y ficha reales de la cuenta de test intactos';
  else informe := informe || E'\nFALLA  (l) cambió algo real de la cuenta de test'; end if;

  -- ── Fin: SIEMPRE con error, para deshacer todo. ─────────────────────────────────────
  raise exception 'PRUEBA T7 TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
