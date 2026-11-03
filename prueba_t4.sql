-- =====================================================================================
-- PRUEBA de T4 -- supabase_migration_t4_cancel_booking_detalle.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA T4 TERMINADA -- se deshizo todo"). El mensaje de ese error ES el informe:
-- "N de M OK" y una línea por chequeo.
--
-- Cómo corre:
--   * Se corre DESPUÉS de la migración. Antes, (0), (a3) y casi todos los casos fallan: la
--     función nueva no existe y la versión vieja devuelve true / suma donde no corresponde.
--   * Los casos van dentro de una subtransacción que se deshace al final. Cada caso arranca
--     vencido (solo dentro de la subtransacción) todo lo vigente de la cuenta de test, y crea
--     sus propios lotes, clases, disciplinas (ocultas e inactivas) y reservas. El caso (l) se
--     mide DESPUÉS de deshacer la subtransacción y confirma que no quedó ningún rastro.
--   * Cada caso va en su propio bloque: si uno revienta, se informa como FALLA y siguen los demás.
--   * La sesión simulada (request.jwt.claims, local a esta transacción) es la de la cuenta de
--     test. _cancelar_reserva_por_gimnasio (interna) se llama directo.
--   * Fecha del plan de cada caso: hoy + 20 a las 18:00 de Argentina. Reservas: desde hoy + 40
--     (lejos del límite de minutos). Evitar correrla justo alrededor de las 00:00 de Argentina.
-- =====================================================================================

do $prueba$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  c_fin_casos constant text := 'FIN_CASOS_T4';
  c_deshacer constant text := 'DESHACER_CASO_T4';
  c_dni constant text := '44537978';
  v_user uuid;
  v_hoy date := (now() at time zone c_zona)::date;
  v_base date;
  v_plan timestamptz;
  v_otra timestamptz;
  v_vencido timestamptz := now() - interval '1 day';
  v_a uuid;
  v_b uuid;
  v_ap uuid;
  v_nombre_a text;
  v_clase_a uuid;
  v_clase_ap uuid;
  v_clase_ya uuid;
  l1 uuid;
  l2 uuid;
  v_r jsonb;
  v_bool boolean;
  v_err text;
  v_txt text;
  v_limite int;
  v_inicio_ya timestamptz;
  v_huella_antes text;
  v_huella_despues text;
  ok int := 0;
  total int := 0;
  informe text := '';
begin
  -- ── Preparación (fuera de la subtransacción) ──────────────────────────────────────
  select id into v_user from profiles where dni = c_dni;
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  v_plan := ((v_hoy + 20)::timestamp + time '18:00') at time zone c_zona;
  v_otra := ((v_hoy + 5)::timestamp + time '12:00') at time zone c_zona;
  v_base := v_hoy + 40;

  select md5(coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at, created_at), ',' order by id)
                       from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', id, class_id, booking_date, credit_lote_id), ',' order by id)
                                 from bookings where user_id = v_user), '-')
             || '|' || (select count(*) from booking_cancellations where user_id = v_user)::text)
    into v_huella_antes;

  -- ── (0) La migración está aplicada (huellas T4 sin espacios) ────────────────────────
  total := total + 1;
  begin
    select string_agg(x.funcion, ', ') into v_txt
    from (values
      ('public._lote_de_pago_anulado(uuid, uuid)', '927ed872bffbd4adedb853870948c69e'),
      ('public._lote_del_plan(uuid, uuid)', '3bc31ce02fde1172c747f12a9185ef7c'),
      ('public.cancel_booking_detalle(uuid, date, text)', '10de28ae892d8f6cf0745bf997357ef6'),
      ('public.cancel_booking(uuid, date, text)', '3556a21005291ce2a12693f4c0d2d72a'),
      ('public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)', 'aeb58ac99ab1806c6709eba0abf75abb')
    ) as x(funcion, esperada)
    where to_regprocedure(x.funcion) is null
       or md5(regexp_replace(pg_get_functiondef(to_regprocedure(x.funcion)), '\s+', '', 'g')) <> x.esperada;
    if v_txt is null then
      ok := ok + 1; informe := informe || E'\nOK     (0) migración T4 aplicada (las 5 funciones con su huella T4)';
    else informe := informe || E'\nFALLA  (0) no están en su versión T4: ' || v_txt; end if;
  exception when others then
    informe := informe || E'\nFALLA  (0) ERROR: ' || sqlerrm;
  end;

  -- ── (a) Permisos ──────────────────────────────────────────────────────────────────
  total := total + 1;
  if (select proacl::text from pg_proc where oid = 'public.cancel_booking(uuid, date, text)'::regprocedure)
       = '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' then
    ok := ok + 1; informe := informe || E'\nOK     (a1) cancel_booking: mismos permisos que producción (anon incluido)';
  else informe := informe || E'\nFALLA  (a1) permisos de cancel_booking cambiaron'; end if;

  total := total + 1;
  if (select proacl::text from pg_proc where oid = 'public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)'::regprocedure)
       = '{postgres=X/postgres,service_role=X/postgres}' then
    ok := ok + 1; informe := informe || E'\nOK     (a2) _cancelar_reserva_por_gimnasio: mismos permisos que producción';
  else informe := informe || E'\nFALLA  (a2) permisos de _cancelar_reserva_por_gimnasio cambiaron'; end if;

  total := total + 1;
  begin
    if has_function_privilege('authenticated', 'public.cancel_booking_detalle(uuid, date, text)', 'execute')
       and not has_function_privilege('anon', 'public.cancel_booking_detalle(uuid, date, text)', 'execute')
       and not has_function_privilege('authenticated', 'public._lote_del_plan(uuid, uuid)', 'execute')
       and not has_function_privilege('anon', 'public._lote_del_plan(uuid, uuid)', 'execute')
       and not has_function_privilege('authenticated', 'public._lote_de_pago_anulado(uuid, uuid)', 'execute')
       and not has_function_privilege('anon', 'public._lote_de_pago_anulado(uuid, uuid)', 'execute') then
      ok := ok + 1; informe := informe || E'\nOK     (a3) cancel_booking_detalle solo authenticated; las internas, nadie';
    else informe := informe || E'\nFALLA  (a3) permisos de las funciones nuevas'; end if;
  exception when others then
    informe := informe || E'\nFALLA  (a3) ERROR: ' || sqlerrm;
  end;

  -- ── Casos: subtransacción que se deshace al final ─────────────────────────────────
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_user::text, true);

    create function pg_temp.t4_limpiar(p_user uuid) returns void language sql as $f$
      update user_credits set expires_at = least(expires_at, now() - interval '2 days')
      where user_id = p_user and expires_at > now();
    $f$;
    create function pg_temp.t4_lote(p_user uuid, p_disc uuid, p_saldo int, p_vence timestamptz) returns uuid language sql as $f$
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
      values (p_user, p_disc, p_saldo, p_vence) returning id;
    $f$;
    create function pg_temp.t4_reserva(p_user uuid, p_clase uuid, p_fecha date, p_lote uuid) returns void language sql as $f$
      insert into bookings (user_id, class_id, booking_date, credit_lote_id) values (p_user, p_clase, p_fecha, p_lote);
    $f$;
    create function pg_temp.t4_saldo(p_lote uuid) returns int language sql as $f$
      select remaining_credits from user_credits where id = p_lote;
    $f$;

    -- Disciplinas y clases de prueba (ocultas e inactivas). A y B de créditos; AP de Aparatos.
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T4 A ' || gen_random_uuid(), 'credits', false, false) returning id, name into v_a, v_nombre_a;
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T4 B ' || gen_random_uuid(), 'credits', false, false) returning id into v_b;
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T4 AP ' || gen_random_uuid(), 'membership', false, false) returning id into v_ap;
    insert into classes (title, discipline_id, capacity, days_of_week, start_time, end_time)
    values ('PRUEBA T4 A', v_a, 50, '{0,1,2,3,4,5,6}', '23:00', '23:30') returning id into v_clase_a;
    insert into classes (title, discipline_id, capacity, days_of_week, start_time, end_time)
    values ('PRUEBA T4 AP', v_ap, 50, '{0,1,2,3,4,5,6}', '23:00', '23:30') returning id into v_clase_ap;

    -- ════ Cancela el SOCIO (cancel_booking_detalle) ════

    -- (C1) Lote de la reserva = lote del plan: +1 a ese lote, mensaje con su fecha.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 3, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 1, l1);
      v_r := public.cancel_booking_detalle(v_clase_a, v_base + 1, 'prueba');
      if (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'reintegrado'
         and pg_temp.t4_saldo(l1) = 4 and (v_r->>'lote_id')::uuid = l1
         and (v_r->>'vence')::date = v_hoy + 20
         and v_r->>'mensaje' = format('Te devolvimos el crédito (vence el %s).', to_char(v_hoy + 20, 'DD/MM/YYYY'))
         and not exists (select 1 from bookings where user_id = v_user and class_id = v_clase_a and booking_date = v_base + 1) then
        ok := ok + 1; informe := informe || E'\nOK     (C1) lote del plan: +1 a ese lote, "Te devolvimos el crédito (vence el …)"';
      else informe := informe || E'\nFALLA  (C1) ' || v_r::text || ' saldo ' || coalesce(pg_temp.t4_saldo(l1)::text, 'null'); end if;
    exception when others then
      informe := informe || E'\nFALLA  (C1) ERROR: ' || sqlerrm;
    end;

    -- (C2) Lote de la reserva vencido (o vencido por un pago): no se devuelve, en ningún lote.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 1, v_vencido);
      l2 := pg_temp.t4_lote(v_user, v_a, 2, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 2, l1);
      v_r := public.cancel_booking_detalle(v_clase_a, v_base + 2, null);
      if not (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'lote_vencido'
         and pg_temp.t4_saldo(l1) = 1 and pg_temp.t4_saldo(l2) = 2
         and v_r->>'mensaje' = 'El crédito no se devolvió porque era de un plan que ya venció o que reemplazó un pago nuevo.' then
        ok := ok + 1; informe := informe || E'\nOK     (C2) lote vencido: no se devuelve (tampoco al lote del plan) y lo dice';
      else informe := informe || E'\nFALLA  (C2) ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (C2) ERROR: ' || sqlerrm;
    end;

    -- (C3) Lote vigente pero de OTRA fecha que el plan (D-T4a): no se devuelve.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 1, v_otra);
      l2 := pg_temp.t4_lote(v_user, v_a, 2, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 3, l1);
      v_r := public.cancel_booking_detalle(v_clase_a, v_base + 3, null);
      if not (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'lote_de_otro_plan'
         and pg_temp.t4_saldo(l1) = 1 and pg_temp.t4_saldo(l2) = 2
         and v_r->>'mensaje' = 'El crédito no se devolvió porque era de un plan anterior, no del que tenés vigente.' then
        ok := ok + 1; informe := informe || E'\nOK     (C3) lote de otra fecha que el plan: no se devuelve y lo dice';
      else informe := informe || E'\nFALLA  (C3) ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (C3) ERROR: ' || sqlerrm;
    end;

    -- (C4) Lote del plan pero de un pago ANULADO (reversión anterior a la regla F): no se devuelve.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 2, v_plan);
      insert into pagos_socio (user_id, paquete, estado, origen, detalle_acreditacion)
      values (v_user, 'PRUEBA T4 anulado', 'anulado', 'manual', jsonb_build_object(
        'creditos', jsonb_build_array(jsonb_build_object('discipline_id', v_a, 'credits_otorgados', 2, 'lote_id', l1))));
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 4, l1);
      v_r := public.cancel_booking_detalle(v_clase_a, v_base + 4, null);
      if not (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'pago_anulado' and pg_temp.t4_saldo(l1) = 2
         and v_r->>'mensaje' = 'El crédito no se devolvió porque era de un pago anulado. Consultá con el gimnasio.' then
        ok := ok + 1; informe := informe || E'\nOK     (C4) lote de un pago anulado: no se devuelve y lo dice';
      else informe := informe || E'\nFALLA  (C4) ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (C4) ERROR: ' || sqlerrm;
    end;

    -- (C5) Reserva vieja sin lote, el plan tiene la disciplina (su lote del plan en 0): +1 ahí.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 0, v_plan);
      l2 := pg_temp.t4_lote(v_user, v_b, 3, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 5, null);
      v_r := public.cancel_booking_detalle(v_clase_a, v_base + 5, null);
      if (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'reintegrado_plan'
         and pg_temp.t4_saldo(l1) = 1 and pg_temp.t4_saldo(l2) = 3 and (v_r->>'vence')::date = v_hoy + 20 then
        ok := ok + 1; informe := informe || E'\nOK     (C5) sin lote, el plan tiene la disciplina: +1 a su lote del plan (aunque estaba en 0)';
      else informe := informe || E'\nFALLA  (C5) ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (C5) ERROR: ' || sqlerrm;
    end;

    -- (C6) Reserva vieja sin lote y el plan NO tiene la disciplina (solo un lote de otra fecha):
    --      no se devuelve. La versión vieja le sumaba a ese lote de otra fecha.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 2, v_otra);
      l2 := pg_temp.t4_lote(v_user, v_b, 3, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 6, null);
      v_r := public.cancel_booking_detalle(v_clase_a, v_base + 6, null);
      if not (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'sin_plan_disciplina'
         and pg_temp.t4_saldo(l1) = 2 and pg_temp.t4_saldo(l2) = 3
         and v_r->>'mensaje' = format('El crédito no se devolvió porque tu plan actual no incluye %s. Consultá con el gimnasio.', v_nombre_a) then
        ok := ok + 1; informe := informe || E'\nOK     (C6) sin lote y el plan no tiene la disciplina: no se devuelve y lo dice';
      else informe := informe || E'\nFALLA  (C6) ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (C6) ERROR: ' || sqlerrm;
    end;

    -- (C7) Aparatos: no usa créditos, no se toca nada.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_ap, null, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_ap, v_base + 7, l1);
      v_r := public.cancel_booking_detalle(v_clase_ap, v_base + 7, null);
      if not (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'aparatos_sin_creditos' and pg_temp.t4_saldo(l1) is null then
        ok := ok + 1; informe := informe || E'\nOK     (C7) Aparatos: nada que devolver y lo dice';
      else informe := informe || E'\nFALLA  (C7) ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (C7) ERROR: ' || sqlerrm;
    end;

    -- (C8) cancel_booking (PWA vieja): true solo si devolvió; false si no (antes: true siempre).
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 1, v_plan);
      l2 := pg_temp.t4_lote(v_user, v_a, 1, v_vencido);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 8, l1);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 9, l2);
      v_bool := public.cancel_booking(v_clase_a, v_base + 8, null);
      v_txt := coalesce(v_bool::text, 'null');
      v_bool := public.cancel_booking(v_clase_a, v_base + 9, null);
      v_txt := v_txt || '/' || coalesce(v_bool::text, 'null');
      if v_txt = 'true/false' and pg_temp.t4_saldo(l1) = 2 and pg_temp.t4_saldo(l2) = 1 then
        ok := ok + 1; informe := informe || E'\nOK     (C8) cancel_booking: true si devolvió, false si no (ya no miente)';
      else informe := informe || E'\nFALLA  (C8) devolvió ' || v_txt; end if;
    exception when others then
      informe := informe || E'\nFALLA  (C8) ERROR: ' || sqlerrm;
    end;

    -- (C9) Errores iguales que hoy: doble cancelación y sin sesión. Nada cambia.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 1, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 10, l1);
      perform public.cancel_booking_detalle(v_clase_a, v_base + 10, null);
      v_err := null;
      begin
        perform public.cancel_booking_detalle(v_clase_a, v_base + 10, null);
        v_err := 'SIN ERROR';
      exception when others then v_err := sqlerrm;
      end;
      v_txt := v_err;
      perform set_config('request.jwt.claims', '', true);
      perform set_config('request.jwt.claim.sub', '', true);
      v_err := null;
      begin
        perform public.cancel_booking_detalle(v_clase_a, v_base + 10, null);
        v_err := 'SIN ERROR';
      exception when others then v_err := sqlerrm;
      end;
      perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', v_user::text, true);
      if v_txt = 'No tenías una reserva en esta clase' and v_err = 'No autenticado' and pg_temp.t4_saldo(l1) = 2 then
        ok := ok + 1; informe := informe || E'\nOK     (C9) doble cancelación y sin sesión: mismos errores que hoy, sin doble +1';
      else informe := informe || E'\nFALLA  (C9) ' || coalesce(v_txt, '?') || ' / ' || coalesce(v_err, '?') || ' / saldo ' || coalesce(pg_temp.t4_saldo(l1)::text, 'null'); end if;
    exception when others then
      informe := informe || E'\nFALLA  (C9) ERROR: ' || sqlerrm;
    end;

    -- (C10) Dentro del límite de minutos: bloquea con el MISMO error y no toca nada. Se arma una
    --       clase que empieza dentro de 1 minuto (hoy, en Argentina). Si no se puede (límite < 2
    --       o muy cerca de la medianoche), queda NO PROBADO.
    select coalesce(limite_cancelacion_minutos, 120) into v_limite from configuracion where id = 1;
    v_inicio_ya := now() + interval '1 minute';
    if coalesce(v_limite, 120) < 2 or (v_inicio_ya at time zone c_zona)::date <> v_hoy then
      informe := informe || E'\nAVISO  (C10) NO PROBADO: límite menor a 2 minutos o muy cerca de la medianoche';
    else
      total := total + 1;
      begin
        perform pg_temp.t4_limpiar(v_user);
        l1 := pg_temp.t4_lote(v_user, v_a, 1, v_plan);
        insert into classes (title, discipline_id, capacity, days_of_week, start_time, end_time)
        values ('PRUEBA T4 YA', v_a, 50, '{0,1,2,3,4,5,6}',
                (v_inicio_ya at time zone c_zona)::time, ((v_inicio_ya + interval '30 minutes') at time zone c_zona)::time)
        returning id into v_clase_ya;
        perform pg_temp.t4_reserva(v_user, v_clase_ya, v_hoy, l1);
        v_err := null;
        begin
          perform public.cancel_booking_detalle(v_clase_ya, v_hoy, null);
          v_err := 'SIN ERROR';
        exception when others then v_err := sqlerrm;
        end;
        if v_err = format('No podés cancelar esta reserva -- faltan menos de %s minutos para que empiece la clase.', coalesce(v_limite, 120))
           and exists (select 1 from bookings where user_id = v_user and class_id = v_clase_ya and booking_date = v_hoy)
           and pg_temp.t4_saldo(l1) = 1 then
          ok := ok + 1; informe := informe || E'\nOK     (C10) dentro del límite: mismo error de hoy, la reserva y el crédito quedan igual';
        else informe := informe || E'\nFALLA  (C10) ' || coalesce(v_err, '?'); end if;
      exception when others then
        informe := informe || E'\nFALLA  (C10) ERROR: ' || sqlerrm;
      end;
    end if;

    -- ════ Cancela el GIMNASIO (_cancelar_reserva_por_gimnasio, O1) ════

    -- (G1) Lote de la reserva = lote del plan: +1 a ese lote.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 1, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 11, l1);
      v_r := public._cancelar_reserva_por_gimnasio(v_user, v_clase_a, v_base + 11, 'prueba', 'quitar');
      if (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'reintegrado' and pg_temp.t4_saldo(l1) = 2 then
        ok := ok + 1; informe := informe || E'\nOK     (G1) gimnasio, lote del plan: +1 a ese lote';
      else informe := informe || E'\nFALLA  (G1) ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (G1) ERROR: ' || sqlerrm;
    end;

    -- (G2) Lote de la reserva vigente pero de OTRA fecha: +1 al lote del plan de esa disciplina
    --      (aunque esté en 0), NO al de la reserva (antes: al de la reserva).
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 1, v_otra);
      l2 := pg_temp.t4_lote(v_user, v_a, 0, v_plan);
      perform pg_temp.t4_lote(v_user, v_b, 3, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 12, l1);
      v_r := public._cancelar_reserva_por_gimnasio(v_user, v_clase_a, v_base + 12, null, 'quitar');
      if (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'reintegrado_otro_lote'
         and pg_temp.t4_saldo(l1) = 1 and pg_temp.t4_saldo(l2) = 1 and (v_r->>'lote_id')::uuid = l2 then
        ok := ok + 1; informe := informe || E'\nOK     (G2) gimnasio, lote de otra fecha: +1 al lote del plan (estaba en 0)';
      else informe := informe || E'\nFALLA  (G2) ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (G2) ERROR: ' || sqlerrm;
    end;

    -- (G3) Lote de la reserva vencido: +1 al lote del plan de esa disciplina.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 0, v_vencido);
      l2 := pg_temp.t4_lote(v_user, v_a, 2, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 13, l1);
      v_r := public._cancelar_reserva_por_gimnasio(v_user, v_clase_a, v_base + 13, null, 'clase_cancelada');
      if (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'reintegrado_otro_lote'
         and pg_temp.t4_saldo(l1) = 0 and pg_temp.t4_saldo(l2) = 3 then
        ok := ok + 1; informe := informe || E'\nOK     (G3) gimnasio, lote vencido: +1 al lote del plan';
      else informe := informe || E'\nFALLA  (G3) ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (G3) ERROR: ' || sqlerrm;
    end;

    -- (G4) Reserva sin lote: +1 al lote del plan (aunque haya otro de esa disciplina que vence antes).
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 2, v_otra);
      l2 := pg_temp.t4_lote(v_user, v_a, 1, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 14, null);
      v_r := public._cancelar_reserva_por_gimnasio(v_user, v_clase_a, v_base + 14, null, 'quitar');
      if (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'reintegrado_fifo'
         and pg_temp.t4_saldo(l1) = 2 and pg_temp.t4_saldo(l2) = 2 then
        ok := ok + 1; informe := informe || E'\nOK     (G4) gimnasio, sin lote: +1 al lote del plan (no al que vence antes)';
      else informe := informe || E'\nFALLA  (G4) ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (G4) ERROR: ' || sqlerrm;
    end;

    -- (G5) El plan no tiene esa disciplina (solo un lote de otra fecha): no se devuelve y el aviso lo dice.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 2, v_otra);
      perform pg_temp.t4_lote(v_user, v_b, 3, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 15, l1);
      v_r := public._cancelar_reserva_por_gimnasio(v_user, v_clase_a, v_base + 15, null, 'quitar');
      if not (v_r->>'reintegrado')::boolean and v_r->>'motivo' = 'sin_lote_vigente'
         and pg_temp.t4_saldo(l1) = 2 and v_r->>'lote_id' is null
         and v_r->>'mensaje_socio' like '%Ese crédito no se reintegró porque tu plan actual no incluye créditos de %'
         and v_r->>'mensaje_admin' like '%NO se devolvió el crédito, su plan actual no incluye créditos de %' then
        ok := ok + 1; informe := informe || E'\nOK     (G5) gimnasio, el plan no tiene la disciplina: no se devuelve y los avisos lo dicen';
      else informe := informe || E'\nFALLA  (G5) ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (G5) ERROR: ' || sqlerrm;
    end;

    -- (G6) Pago anulado y Aparatos: igual que la tanda 2.
    total := total + 1;
    begin
      perform pg_temp.t4_limpiar(v_user);
      l1 := pg_temp.t4_lote(v_user, v_a, 2, v_plan);
      insert into pagos_socio (user_id, paquete, estado, origen, detalle_acreditacion)
      values (v_user, 'PRUEBA T4 anulado G', 'anulado', 'manual', jsonb_build_object(
        'creditos', jsonb_build_array(jsonb_build_object('discipline_id', v_a, 'credits_otorgados', 2, 'lote_id', l1))));
      perform pg_temp.t4_reserva(v_user, v_clase_a, v_base + 16, l1);
      v_r := public._cancelar_reserva_por_gimnasio(v_user, v_clase_a, v_base + 16, null, 'quitar');
      v_txt := v_r->>'motivo';
      l2 := pg_temp.t4_lote(v_user, v_ap, null, v_plan);
      perform pg_temp.t4_reserva(v_user, v_clase_ap, v_base + 17, l2);
      v_r := public._cancelar_reserva_por_gimnasio(v_user, v_clase_ap, v_base + 17, null, 'quitar');
      if v_txt = 'pago_anulado' and pg_temp.t4_saldo(l1) = 2
         and v_r->>'motivo' = 'aparatos_sin_creditos' and pg_temp.t4_saldo(l2) is null then
        ok := ok + 1; informe := informe || E'\nOK     (G6) gimnasio: pago anulado no se devuelve; Aparatos no se toca';
      else informe := informe || E'\nFALLA  (G6) ' || coalesce(v_txt, '?') || ' / ' || v_r::text; end if;
    exception when others then
      informe := informe || E'\nFALLA  (G6) ERROR: ' || sqlerrm;
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
             || '|' || (select count(*) from booking_cancellations where user_id = v_user)::text)
    into v_huella_despues;
  total := total + 1;
  if v_huella_despues = v_huella_antes then
    ok := ok + 1; informe := informe || E'\nOK     (l) créditos, reservas y cancelaciones reales de la cuenta de test intactos';
  else informe := informe || E'\nFALLA  (l) cambió algo real de la cuenta de test'; end if;

  -- ── Fin: SIEMPRE con error, para deshacer todo. ─────────────────────────────────────
  raise exception 'PRUEBA T4 TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
