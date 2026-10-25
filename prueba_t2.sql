-- =====================================================================================
-- PRUEBA de T2 -- supabase_migration_t2_fecha_plan_editar_fecha.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA T2 TERMINADA -- se deshizo todo"). El mensaje de ese error ES el informe:
-- "N de M OK" y una línea por chequeo.
--
-- Cómo corre:
--   * Se corre DESPUÉS de la migración (antes, el caso (0) y casi todo lo demás fallan: las
--     funciones nuevas no existen).
--   * Los casos (b)-(k) van dentro de una subtransacción que se deshace al final de los casos.
--     Al empezar, se vencen (solo dentro de la subtransacción) las filas vigentes REALES de la
--     cuenta de test, para que los resultados dependan solo de las filas de prueba. El caso (l)
--     se mide DESPUÉS de deshacer esa subtransacción y confirma que no quedó ningún rastro.
--   * Disciplinas de prueba propias (ocultas e inactivas). La sesión simulada es la del primer
--     admin de profiles (request.jwt.claims, local a esta transacción).
--   * Fechas siempre relativas a HOY en Argentina: se puede correr cualquier día. Evitar
--     correrla justo alrededor de las 00:00 de Argentina (el "hoy" de la prueba y el de la
--     función tienen que ser el mismo día).
-- =====================================================================================

do $prueba$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  c_fin_casos constant text := 'FIN_CASOS_T2';
  c_deshacer constant text := 'DESHACER_CASO_T2';
  v_user uuid;
  v_admin uuid;
  v_aparatos uuid;
  v_disc uuid;
  v_disc2 uuid;
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_tope date := ((now() at time zone 'America/Argentina/Mendoza')::date + interval '1 year')::date;
  v_tiene_ficha boolean;
  v_plan_pago timestamptz;
  v_corte timestamptz;
  v_corte_hoy timestamptz;
  l_saldo uuid;
  l_cero_plan uuid;
  l_saldo_otra uuid;
  l_cero_otra uuid;
  l_aparatos uuid;
  l_vencido uuid;
  l_z1 uuid;
  l_z2 uuid;
  l_z3 uuid;
  v_lote uuid;
  v_n int;
  v_ok_borde boolean;
  v_err text;
  v_dni_falso text;
  r record;
  v_h1 text;
  v_h2 text;
  v_huella_antes text;
  v_huella_despues text;
  v_txt text;
  ok int := 0;
  total int := 0;
  informe text := '';
begin
  -- ── Preparación (fuera de la subtransacción) ──────────────────────────────────────
  select id into v_user from profiles where dni = '44537978';
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  select id into v_admin from profiles where role = 'admin' order by created_at limit 1;
  if v_admin is null then
    raise exception 'No hay ningún perfil admin.';
  end if;
  select id into v_aparatos from disciplines where kind = 'membership' limit 1;
  if v_aparatos is null then
    raise exception 'No hay ninguna disciplina de tipo membership (Aparatos).';
  end if;
  select exists(select 1 from socios s join profiles p on p.dni = s.dni where p.id = v_user) into v_tiene_ficha;

  -- Huella de TODO lo real de la cuenta de test que estas funciones pueden tocar:
  -- sus filas de user_credits y su ficha en socios.
  select md5(coalesce((
           select string_agg(concat_ws(':', id, remaining_credits, expires_at, created_at), ',' order by id)
           from user_credits where user_id = v_user), '-')
         || '|' || coalesce((
           select string_agg(concat_ws(':', s.id, s.creditos, s.fecha_vencimiento), ',' order by s.id)
           from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
    into v_huella_antes;

  -- ── (0) La migración está aplicada ──────────────────────────────────────────────────
  total := total + 1;
  if to_regprocedure('public.fecha_plan_socio(uuid)') is not null
     and to_regprocedure('public.ultimo_dia_plan(timestamp with time zone)') is not null
     and pg_get_functiondef('public.resolver_fecha_plan_actual(uuid)'::regprocedure) like '%fecha_plan_socio%'
     and pg_get_functiondef('public.admin_editar_fecha_vencimiento_socio(uuid, date)'::regprocedure) like '%interval ''1 microsecond''%'
     and pg_get_functiondef('public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure) like '%p_fecha_inicio + p_dias_vigencia + 1%' then
    ok := ok + 1; informe := informe || E'\nOK     (0) migración T2 aplicada (2 funciones nuevas y las 3 reemplazadas)';
  else informe := informe || E'\nFALLA  (0) la migración T2 no está aplicada'; end if;

  if not v_tiene_ficha then
    informe := informe || E'\nAVISO  la cuenta de test no tiene ficha en socios: editar la fecha va a dar el error de "sin ficha" (decisión C)';
  end if;

  -- ── Casos (b)-(k): subtransacción que se deshace al final ─────────────────────────
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);

    -- Lo real de la cuenta de test, fuera del medio (solo dentro de esta subtransacción).
    update user_credits set expires_at = least(expires_at, now() - interval '2 days')
    where user_id = v_user and expires_at > now();

    -- Disciplinas de prueba (mismas columnas que manda DisciplinaModal.jsx).
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T2 A ' || gen_random_uuid(), 'credits', false, false)
    returning id into v_disc;
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T2 B ' || gen_random_uuid(), 'credits', false, false)
    returning id into v_disc2;

    -- Plan "pagado" a las 18:00 de hoy + 20 (como un pago real, con hora).
    v_plan_pago := ((v_hoy + 20)::timestamp + time '18:00') at time zone c_zona;

    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
    values (v_user, v_disc, 4, v_plan_pago, now() - interval '3 days') returning id into l_saldo;          -- saldo, fecha del plan
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
    values (v_user, v_disc2, 0, ((v_hoy + 20)::timestamp + time '03:00') at time zone c_zona, now() - interval '3 days')
    returning id into l_cero_plan;                                                                         -- (f) en 0, MISMO día del plan (otra hora)
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
    values (v_user, v_disc2, 2, ((v_hoy + 5)::timestamp + time '12:00') at time zone c_zona, now() - interval '3 days')
    returning id into l_saldo_otra;                                                                        -- (e) saldo de OTRA fecha (D1 = a)
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
    values (v_user, v_disc, 0, ((v_hoy + 8)::timestamp + time '12:00') at time zone c_zona, now() - interval '3 days')
    returning id into l_cero_otra;                                                                         -- (g) en 0, OTRA fecha
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
    values (v_user, v_aparatos, null, v_plan_pago, now() - interval '1 day') returning id into l_aparatos;  -- Aparatos vigente
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
    values (v_user, v_disc, 3, now() - interval '10 days', now() - interval '40 days') returning id into l_vencido; -- ya vencido

    -- ── (c) Fecha pasada (ayer): error claro y no cambia nada
    select md5(coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                         from user_credits where user_id = v_user), '-')
               || '|' || coalesce((select string_agg(concat_ws(':', s.id, s.fecha_vencimiento), ',' order by s.id)
                                   from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
      into v_h1;
    v_err := 'SIN ERROR';
    begin
      perform admin_editar_fecha_vencimiento_socio(v_user, v_hoy - 1);
    exception when others then
      v_err := sqlerrm;
    end;
    select md5(coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                         from user_credits where user_id = v_user), '-')
               || '|' || coalesce((select string_agg(concat_ws(':', s.id, s.fecha_vencimiento), ',' order by s.id)
                                   from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
      into v_h2;
    total := total + 1;
    if v_err = format('No se puede poner un vencimiento anterior a hoy (%s).', to_char(v_hoy, 'DD/MM/YYYY')) and v_h1 = v_h2 then
      ok := ok + 1; informe := informe || E'\nOK     (c) fecha pasada: error claro y no cambió nada';
    else informe := informe || E'\nFALLA  (c) fecha pasada -- ' || v_err || case when v_h1 <> v_h2 then ' (y cambió algo)' else '' end; end if;

    -- ── (d) Más de 1 año: error claro y no cambia nada. El borde (hoy + 1 año) sí pasa.
    v_err := 'SIN ERROR';
    begin
      perform admin_editar_fecha_vencimiento_socio(v_user, v_tope + 1);
    exception when others then
      v_err := sqlerrm;
    end;
    select md5(coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                         from user_credits where user_id = v_user), '-')
               || '|' || coalesce((select string_agg(concat_ws(':', s.id, s.fecha_vencimiento), ',' order by s.id)
                                   from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
      into v_h2;
    total := total + 1;
    if v_err = format('El vencimiento no puede pasar de un año desde hoy (%s). Revisá la fecha.', to_char(v_tope, 'DD/MM/YYYY')) and v_h1 = v_h2 then
      ok := ok + 1; informe := informe || E'\nOK     (d) más de 1 año: error claro y no cambió nada';
    else informe := informe || E'\nFALLA  (d) más de 1 año -- ' || v_err || case when v_h1 <> v_h2 then ' (y cambió algo)' else '' end; end if;

    v_ok_borde := false;
    v_err := null;
    begin
      perform admin_editar_fecha_vencimiento_socio(v_user, v_tope);
      v_ok_borde := (select expires_at = ((v_tope + 1)::timestamp at time zone c_zona) - interval '1 microsecond'
                     from user_credits where id = l_saldo);
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm <> c_deshacer then v_err := sqlerrm; end if;
    end;
    total := total + 1;
    if v_ok_borde and v_err is null then
      ok := ok + 1; informe := informe || E'\nOK     (d) borde: hoy + 1 año exacto se acepta';
    else informe := informe || E'\nFALLA  (d) borde hoy + 1 año -- ' || coalesce(v_err, 'no movió al fin de ese día'); end if;

    -- ── (e) Fecha normal (hoy + 10): Aparatos y los lotes con saldo (también el de OTRA fecha)
    --        al FIN de ese día; cantidades intactas; espejo en socios; devuelve las filas movidas.
    v_n := admin_editar_fecha_vencimiento_socio(v_user, v_hoy + 10);
    v_corte := ((v_hoy + 11)::timestamp at time zone c_zona) - interval '1 microsecond';
    total := total + 1;
    if v_n = 4
       and (select remaining_credits = 4 and expires_at = v_corte from user_credits where id = l_saldo)
       and (select remaining_credits = 2 and expires_at = v_corte from user_credits where id = l_saldo_otra)
       and (select remaining_credits is null and expires_at = v_corte from user_credits where id = l_aparatos)
       and (select remaining_credits = 3 and expires_at = now() - interval '10 days' from user_credits where id = l_vencido)
       and ultimo_dia_plan(v_corte) = v_hoy + 10
       and (not v_tiene_ficha
            or (select s.fecha_vencimiento = v_hoy + 10 from socios s join profiles p on p.dni = s.dni where p.id = v_user)) then
      ok := ok + 1; informe := informe || E'\nOK     (e) hoy + 10: Aparatos y saldos (también el de otra fecha) al fin de ese día, cantidades y vencido intactos, espejo = elegido';
    else
      select format('devolvió %s; saldo vence %s; saldo otra vence %s; aparatos vence %s', v_n,
               (select expires_at from user_credits where id = l_saldo),
               (select expires_at from user_credits where id = l_saldo_otra),
               (select expires_at from user_credits where id = l_aparatos)) into v_txt;
      informe := informe || E'\nFALLA  (e) hoy + 10 -- ' || coalesce(v_txt, '?');
    end if;

    -- ── (f) Lote del plan en 0 (mismo día del plan, otra hora): se MUEVE, sigue en 0
    total := total + 1;
    if (select remaining_credits = 0 and expires_at = v_corte from user_credits where id = l_cero_plan) then
      ok := ok + 1; informe := informe || E'\nOK     (f) lote del plan en 0: movido a la fecha nueva, sigue en 0';
    else
      select format('saldo %s, vence %s', remaining_credits, expires_at) into v_txt from user_credits where id = l_cero_plan;
      informe := informe || E'\nFALLA  (f) lote del plan en 0 -- ' || coalesce(v_txt, '?');
    end if;

    -- ── (g) Lote en 0 de OTRA fecha: se VENCE (least(expires_at, now() - 1 día)), sigue en 0
    total := total + 1;
    if (select remaining_credits = 0 and expires_at = now() - interval '1 day' from user_credits where id = l_cero_otra) then
      ok := ok + 1; informe := informe || E'\nOK     (g) lote en 0 de otra fecha: vencido a now() - 1 día';
    else
      select format('saldo %s, vence %s', remaining_credits, expires_at) into v_txt from user_credits where id = l_cero_otra;
      informe := informe || E'\nFALLA  (g) lote en 0 de otra fecha -- ' || coalesce(v_txt, '?');
    end if;

    -- ── (b) Elegir HOY: se usa todo el día -- corte = último microsegundo de hoy en Argentina
    v_n := admin_editar_fecha_vencimiento_socio(v_user, v_hoy);
    v_corte_hoy := ((v_hoy + 1)::timestamp at time zone c_zona) - interval '1 microsecond';
    total := total + 1;
    if v_n = 4
       and (select count(*) from user_credits
            where id in (l_saldo, l_cero_plan, l_saldo_otra, l_aparatos) and expires_at = v_corte_hoy) = 4
       and v_corte_hoy > now()
       and (v_corte_hoy at time zone c_zona)::date = v_hoy
       and v_corte_hoy + interval '1 microsecond' = ((v_hoy + 1)::timestamp at time zone c_zona)
       and esta_habilitado_para_disciplina(v_user, v_disc) then
      ok := ok + 1; informe := informe || E'\nOK     (b) hoy: vigente hasta las 23:59:59.999999 de hoy (Argentina), habilitado para reservar';
    else
      select format('devolvió %s; saldo vence %s; corte esperado %s', v_n,
               (select expires_at from user_credits where id = l_saldo), v_corte_hoy) into v_txt;
      informe := informe || E'\nFALLA  (b) hoy -- ' || coalesce(v_txt, '?');
    end if;

    -- ── (h) resolver_fecha_plan_actual con TODO en 0 y el plan corriendo: la fila vigente con el
    --        created_at más reciente (empate: la más lejana), no now() + 30 días.
    update user_credits set expires_at = now() - interval '1 day'
    where user_id = v_user and expires_at > now();
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
    values (v_user, v_disc, 0, ((v_hoy + 40)::timestamp + time '12:00') at time zone c_zona, now() - interval '2 days')
    returning id into l_z1;                                                                                -- más lejana pero más vieja
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
    values (v_user, v_disc2, 0, ((v_hoy + 15)::timestamp + time '12:00') at time zone c_zona, now() - interval '1 day')
    returning id into l_z2;                                                                                -- más reciente (empata con z3)
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
    values (v_user, v_disc, 0, ((v_hoy + 25)::timestamp + time '12:00') at time zone c_zona, now() - interval '1 day')
    returning id into l_z3;                                                                                -- más reciente y más lejana del empate
    total := total + 1;
    if resolver_fecha_plan_actual(v_user) = (select expires_at from user_credits where id = l_z3)
       and fecha_plan_socio(v_user) = (select expires_at from user_credits where id = l_z3) then
      ok := ok + 1; informe := informe || E'\nOK     (h) todo en 0: resolver devuelve la fecha de la fila en 0 más reciente (empate: la más lejana)';
    else informe := informe || E'\nFALLA  (h) todo en 0 -- resolver devolvió ' || coalesce(resolver_fecha_plan_actual(v_user)::text, 'null'); end if;

    -- ── (i) Sin saldo ni Aparatos: editar sigue rechazando como hoy (decisión B)
    v_err := 'SIN ERROR';
    begin
      perform admin_editar_fecha_vencimiento_socio(v_user, v_hoy + 3);
    exception when others then
      v_err := sqlerrm;
    end;
    total := total + 1;
    if v_err like 'Este socio no tiene ningún plan activo%' then
      ok := ok + 1; informe := informe || E'\nOK     (i) todo en 0: editar rechaza igual que hoy ("usá Cobrar")';
    else informe := informe || E'\nFALLA  (i) todo en 0 -- ' || v_err; end if;

    -- ── (h) Sin nada vigente: fecha_plan_socio null y resolver = now() + 30 días (igual que hoy)
    update user_credits set expires_at = now() - interval '1 day'
    where user_id = v_user and expires_at > now();
    total := total + 1;
    if fecha_plan_socio(v_user) is null and resolver_fecha_plan_actual(v_user) = now() + interval '30 days' then
      ok := ok + 1; informe := informe || E'\nOK     (h) sin nada vigente: fecha_plan_socio null, resolver = now() + 30 días';
    else informe := informe || E'\nFALLA  (h) sin nada vigente'; end if;

    -- ── (k) Cobro con fecha (inicio hoy, 30 días): corte al FIN de hoy + 30; espejo y valor
    --        devuelto = hoy + 30 (el día elegido, igual que antes).
    select * into r from admin_acreditar_creditos_manual(
      v_user, jsonb_build_array(jsonb_build_object('discipline_id', v_disc, 'credits', 3)), true, 30, v_hoy);
    v_lote := (r.creditos_lotes->0->>'lote_id')::uuid;
    v_corte := ((v_hoy + 31)::timestamp at time zone c_zona) - interval '1 microsecond';
    total := total + 1;
    if (select remaining_credits = 3 and expires_at = v_corte from user_credits where id = v_lote)
       and r.aparatos_extendido
       and r.nueva_fecha_vencimiento_aparatos = v_hoy + 30
       and (select count(*) from user_credits
            where user_id = v_user and discipline_id = v_aparatos and expires_at > now() and expires_at = v_corte) = 1
       and (not v_tiene_ficha
            or (select s.fecha_vencimiento = v_hoy + 30 from socios s join profiles p on p.dni = s.dni where p.id = v_user)) then
      ok := ok + 1; informe := informe || E'\nOK     (k) cobro con fecha: corte al fin del día elegido; espejo y valor devuelto = día elegido';
    else
      select format('lote vence %s (esperado %s); devuelto %s', expires_at, v_corte, r.nueva_fecha_vencimiento_aparatos)
        into v_txt from user_credits where id = v_lote;
      informe := informe || E'\nFALLA  (k) cobro con fecha -- ' || coalesce(v_txt, '?');
    end if;

    -- ── (k) Cobro SIN fecha de inicio: igual que antes (now() + días)
    select * into r from admin_acreditar_creditos_manual(
      v_user, jsonb_build_array(jsonb_build_object('discipline_id', v_disc, 'credits', 2)), false, 30, null);
    v_lote := (r.creditos_lotes->0->>'lote_id')::uuid;
    total := total + 1;
    if (select remaining_credits = 2 and expires_at = now() + interval '30 days' from user_credits where id = v_lote) then
      ok := ok + 1; informe := informe || E'\nOK     (k) cobro sin fecha de inicio: now() + 30 días, igual que antes';
    else informe := informe || E'\nFALLA  (k) cobro sin fecha de inicio'; end if;

    -- ── (j) DNI sin ficha en socios (decisión C): error y no cambia nada. Se prueba cambiando el
    --        DNI del perfil dentro de un bloque que se deshace. Si ese cambio no se puede hacer
    --        (restricción o trigger), el caso queda NO PROBADO, no FALLA.
    select d into v_dni_falso
    from (values ('9999999901'), ('9999999902'), ('9999999903')) as t(d)
    where not exists (select 1 from socios where dni = t.d)
      and not exists (select 1 from profiles where dni = t.d)
    limit 1;
    v_err := null;
    v_txt := null;
    begin
      update profiles set dni = v_dni_falso where id = v_user;
      begin
        perform admin_editar_fecha_vencimiento_socio(v_user, v_hoy + 3);
        v_err := 'SIN ERROR';
      exception when others then
        v_err := sqlerrm;
      end;
      v_txt := case when (select expires_at = now() + interval '30 days' from user_credits where id = v_lote)
                    then 'intacto' else 'cambió' end;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm <> c_deshacer then v_txt := 'NO PROBADO: ' || sqlerrm; end if;
    end;
    if v_txt like 'NO PROBADO%' or v_dni_falso is null then
      informe := informe || E'\nAVISO  (j) DNI sin ficha -- ' || coalesce(v_txt, 'NO PROBADO: no hay DNI libre');
    else
      total := total + 1;
      if v_err = format('El socio tiene DNI %s pero no hay ninguna ficha en Socios con ese DNI -- no se cambió nada.', v_dni_falso)
         and v_txt = 'intacto' then
        ok := ok + 1; informe := informe || E'\nOK     (j) DNI sin ficha en socios: error claro y no cambió nada';
      else informe := informe || E'\nFALLA  (j) DNI sin ficha -- ' || coalesce(v_err, '?') || ' / lote ' || v_txt; end if;
    end if;

    raise exception '%', c_fin_casos;
  exception when others then
    if sqlerrm <> c_fin_casos then
      total := total + 1;
      informe := informe || E'\nFALLA  ERROR inesperado en los casos: ' || sqlerrm;
    end if;
  end;

  -- ── (l) Ya deshecha la subtransacción: lo real de la cuenta de test quedó igual ────
  select md5(coalesce((
           select string_agg(concat_ws(':', id, remaining_credits, expires_at, created_at), ',' order by id)
           from user_credits where user_id = v_user), '-')
         || '|' || coalesce((
           select string_agg(concat_ws(':', s.id, s.creditos, s.fecha_vencimiento), ',' order by s.id)
           from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
    into v_huella_despues;
  total := total + 1;
  if v_huella_despues = v_huella_antes then
    ok := ok + 1; informe := informe || E'\nOK     (l) créditos y ficha reales de la cuenta de test intactos';
  else informe := informe || E'\nFALLA  (l) cambió algo real de la cuenta de test'; end if;

  -- ── (a) Permisos: las 2 funciones nuevas sin EXECUTE para public, anon ni authenticated ──
  total := total + 1;
  if to_regprocedure('public.fecha_plan_socio(uuid)') is not null
     and to_regprocedure('public.ultimo_dia_plan(timestamp with time zone)') is not null
     and not has_function_privilege('anon', 'public.fecha_plan_socio(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.fecha_plan_socio(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.ultimo_dia_plan(timestamp with time zone)', 'execute')
     and not has_function_privilege('authenticated', 'public.ultimo_dia_plan(timestamp with time zone)', 'execute')
     and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                     where p.oid in ('public.fecha_plan_socio(uuid)'::regprocedure,
                                     'public.ultimo_dia_plan(timestamp with time zone)'::regprocedure)
                       and a.grantee = 0 and a.privilege_type = 'EXECUTE')
     and (select bool_and(proacl is not null) from pg_proc
          where oid in ('public.fecha_plan_socio(uuid)'::regprocedure,
                        'public.ultimo_dia_plan(timestamp with time zone)'::regprocedure)) then
    ok := ok + 1; informe := informe || E'\nOK     (a) fecha_plan_socio y ultimo_dia_plan: sin EXECUTE para public, anon ni authenticated';
  else
    select string_agg(p.proname || ' = ' || coalesce(p.proacl::text, '(por defecto)'), ' | ') into v_txt
    from pg_proc p
    where p.proname in ('fecha_plan_socio', 'ultimo_dia_plan') and p.pronamespace = 'public'::regnamespace;
    informe := informe || E'\nFALLA  (a) permisos de las funciones nuevas: ' || coalesce(v_txt, 'no existen');
  end if;

  -- ── Fin: SIEMPRE con error, para deshacer todo. ─────────────────────────────────────
  raise exception 'PRUEBA T2 TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
