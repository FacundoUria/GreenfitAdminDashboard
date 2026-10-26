-- =====================================================================================
-- PRUEBA de T3 -- supabase_migration_t3_fecha_plan_editor_creditos.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA T3 TERMINADA -- se deshizo todo"). El mensaje de ese error ES el informe:
-- "N de M OK" y una línea por chequeo.
--
-- Cómo corre:
--   * Se corre DESPUÉS de la migración (antes, el caso (0) y casi todo lo demás fallan).
--   * Los casos van dentro de una subtransacción que se deshace al final. Cada caso arranca
--     vencido (solo dentro de la subtransacción) todo lo vigente de la cuenta de test, para que
--     los resultados dependan solo de sus filas de prueba. El caso (l) se mide DESPUÉS de deshacer
--     esa subtransacción y confirma que no quedó ningún rastro.
--   * Cada caso va en su propio bloque: si uno revienta, se informa como FALLA y siguen los demás.
--   * Disciplinas de prueba propias (ocultas e inactivas). La sesión simulada es la del primer
--     admin de profiles (request.jwt.claims, local a esta transacción). Las funciones auxiliares
--     son temporales (pg_temp) y se deshacen con todo lo demás.
--   * Fechas siempre relativas a HOY en Argentina: se puede correr cualquier día. Evitar correrla
--     justo alrededor de las 00:00 de Argentina.
--   * La cuenta de test necesita ficha en socios: con D-T3c, sin ficha todas las llamadas dan
--     error. Si no la tiene, la prueba se frena al principio sin probar nada.
-- =====================================================================================

do $prueba$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  c_fin_casos constant text := 'FIN_CASOS_T3';
  c_deshacer constant text := 'DESHACER_CASO_T3';
  c_permisos constant text := '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
  v_user uuid;
  v_admin uuid;
  v_aparatos uuid;
  v_a uuid;
  v_b uuid;
  v_nombre_a text;
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_plan timestamptz;
  v_30 timestamptz := now() + interval '30 days';
  v_ayer timestamptz := now() - interval '1 day';
  v_ficha_fecha_antes date;
  l1 uuid;
  l2 uuid;
  l3 uuid;
  l4 uuid;
  v_n int;
  v_n2 int;
  v_err text;
  v_err2 text;
  v_err3 text;
  v_dni_falso text;
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
  if (select count(*) from disciplines where kind = 'membership') <> 1 then
    raise exception 'PRUEBA T3: tiene que haber exactamente 1 disciplina de tipo membership (Aparatos). No se probó nada.';
  end if;
  select id into v_aparatos from disciplines where kind = 'membership';
  if not exists (select 1 from socios s join profiles p on p.dni = s.dni where p.id = v_user) then
    raise exception 'PRUEBA T3: la cuenta de test (DNI 44537978) no tiene ficha en socios; con D-T3c todas las llamadas darían error. No se probó nada.';
  end if;

  v_plan := ((v_hoy + 20)::timestamp + time '18:00') at time zone c_zona;

  -- Huella de TODO lo real de la cuenta de test que estas funciones pueden tocar.
  select md5(coalesce((
           select string_agg(concat_ws(':', id, remaining_credits, expires_at, created_at), ',' order by id)
           from user_credits where user_id = v_user), '-')
         || '|' || coalesce((
           select string_agg(concat_ws(':', s.id, s.creditos, s.fecha_vencimiento), ',' order by s.id)
           from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
    into v_huella_antes;

  -- ── (0) La migración está aplicada (huella sin espacios de la versión T3) ──────────
  total := total + 1;
  if md5(regexp_replace(pg_get_functiondef('public.admin_fijar_creditos_disciplina(uuid, uuid, integer)'::regprocedure), '\s+', '', 'g')) = '32fa31b3ba16f674faf42f68f14fc3e2'
     and md5(regexp_replace(pg_get_functiondef('public.admin_ajustar_credito_disciplina(uuid, uuid, integer)'::regprocedure), '\s+', '', 'g')) = 'a34f0d9b63aed24d3a67747ed89f88cb'
     and md5(regexp_replace(pg_get_functiondef('public.admin_agregar_aparatos_socio(uuid)'::regprocedure), '\s+', '', 'g')) = 'c93d54418f8ca3e3ac82f7925278b3c6' then
    ok := ok + 1; informe := informe || E'\nOK     (0) migración T3 aplicada (las 3 funciones con su huella T3)';
  else informe := informe || E'\nFALLA  (0) la migración T3 no está aplicada'; end if;

  -- ── Casos: subtransacción que se deshace al final ─────────────────────────────────
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);

    -- Auxiliares temporales (se deshacen con la subtransacción).
    create function pg_temp.t3_limpiar(p_user uuid) returns void language sql as $f$
      update user_credits set expires_at = least(expires_at, now() - interval '2 days')
      where user_id = p_user and expires_at > now();
    $f$;
    create function pg_temp.t3_lote(p_user uuid, p_disc uuid, p_saldo int, p_vence timestamptz, p_creado timestamptz)
    returns uuid language sql as $f$
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
      values (p_user, p_disc, p_saldo, p_vence, p_creado)
      returning id;
    $f$;
    create function pg_temp.t3_huella(p_user uuid) returns text language sql as $f$
      select md5(coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                           from user_credits where user_id = p_user), '-')
                 || '|' || coalesce((select string_agg(concat_ws(':', s.id, s.creditos, s.fecha_vencimiento), ',' order by s.id)
                                     from socios s join profiles p on p.dni = s.dni where p.id = p_user), '-'));
    $f$;
    -- R1: cantidad de días distintos entre lo que el socio puede usar (saldo vigente o Aparatos).
    create function pg_temp.t3_fechas_usables(p_user uuid) returns int language sql as $f$
      select count(distinct public.ultimo_dia_plan(uc.expires_at))::int
      from user_credits uc join disciplines d on d.id = uc.discipline_id
      where uc.user_id = p_user and uc.expires_at > now()
        and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership');
    $f$;
    create function pg_temp.t3_ficha_fecha(p_user uuid) returns date language sql as $f$
      select s.fecha_vencimiento from socios s join profiles p on p.dni = s.dni where p.id = p_user order by s.id limit 1;
    $f$;
    create function pg_temp.t3_ficha_creditos(p_user uuid) returns int language sql as $f$
      select s.creditos from socios s join profiles p on p.dni = s.dni where p.id = p_user order by s.id limit 1;
    $f$;

    -- Disciplinas de prueba (mismas columnas que manda DisciplinaModal.jsx).
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T3 A ' || gen_random_uuid(), 'credits', false, false)
    returning id, name into v_a, v_nombre_a;
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T3 B ' || gen_random_uuid(), 'credits', false, false)
    returning id into v_b;

    -- ── (F1) Fijar con un residuo en 0 MÁS NUEVO de otra disciplina: el lote nuevo usa la fecha
    --         del plan (antes: la del residuo). La otra disciplina no se toca.
    -- ── (F2) D-T3a: en esa disciplina, los lotes de OTRO día (con saldo o en 0) quedan en 0 y
    --         vencidos (now() - 1 día): un reintegro (exige expires_at > now()) ya no los revive.
    total := total + 2;
    begin
      perform pg_temp.t3_limpiar(v_user);
      l1 := pg_temp.t3_lote(v_user, v_a, 5, v_plan, now() - interval '3 days');
      l2 := pg_temp.t3_lote(v_user, v_a, 2, ((v_hoy + 5)::timestamp + time '12:00') at time zone c_zona, now() - interval '3 days');
      l3 := pg_temp.t3_lote(v_user, v_a, 0, ((v_hoy + 8)::timestamp + time '12:00') at time zone c_zona, now() - interval '3 days');
      l4 := pg_temp.t3_lote(v_user, v_b, 0, ((v_hoy + 25)::timestamp + time '12:00') at time zone c_zona, now() - interval '1 day');
      v_ficha_fecha_antes := pg_temp.t3_ficha_fecha(v_user);

      perform admin_fijar_creditos_disciplina(v_user, v_a, 8);

      if (select count(*) from user_credits where user_id = v_user and discipline_id = v_a
          and remaining_credits = 8 and expires_at = v_plan) = 1
         and (select remaining_credits = 0 and expires_at = v_plan from user_credits where id = l1)
         and (select remaining_credits = 0 and expires_at = (((v_hoy + 25)::timestamp + time '12:00') at time zone c_zona)
              from user_credits where id = l4)
         and fecha_plan_socio(v_user) = v_plan
         and pg_temp.t3_fechas_usables(v_user) = 1
         and pg_temp.t3_ficha_creditos(v_user) = 8
         and pg_temp.t3_ficha_fecha(v_user) is not distinct from v_ficha_fecha_antes then
        ok := ok + 1; informe := informe || E'\nOK     (F1) fijar: lote nuevo con la fecha del plan aunque haya un residuo más nuevo; otra disciplina intacta; ficha = 8 créditos, misma fecha';
      else
        select format('nuevo con fecha del plan: %s; plan ahora %s; ficha %s / %s',
                 (select count(*) from user_credits where user_id = v_user and discipline_id = v_a and remaining_credits = 8 and expires_at = v_plan),
                 fecha_plan_socio(v_user), pg_temp.t3_ficha_creditos(v_user), pg_temp.t3_ficha_fecha(v_user)) into v_txt;
        informe := informe || E'\nFALLA  (F1) fijar con residuo -- ' || coalesce(v_txt, '?');
      end if;

      if (select remaining_credits = 0 and expires_at = v_ayer from user_credits where id = l2)
         and (select remaining_credits = 0 and expires_at = v_ayer from user_credits where id = l3) then
        ok := ok + 1; informe := informe || E'\nOK     (F2) fijar: lotes de esa disciplina de OTRO día en 0 y vencidos (un reintegro ya no los revive)';
      else
        select format('saldo otra: %s / %s; cero otra: %s / %s',
                 (select remaining_credits from user_credits where id = l2), (select expires_at from user_credits where id = l2),
                 (select remaining_credits from user_credits where id = l3), (select expires_at from user_credits where id = l3)) into v_txt;
        informe := informe || E'\nFALLA  (F2) D-T3a -- ' || coalesce(v_txt, '?');
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (F1/F2) ERROR: ' || sqlerrm;
    end;

    -- ── (F3) Fijar a un socio sin nada: now() + 30 días y la ficha refleja ese día (D-T3c).
    total := total + 1;
    begin
      perform pg_temp.t3_limpiar(v_user);
      perform admin_fijar_creditos_disciplina(v_user, v_a, 6);
      if (select count(*) from user_credits where user_id = v_user and discipline_id = v_a
          and remaining_credits = 6 and expires_at = v_30) = 1
         and pg_temp.t3_ficha_fecha(v_user) = ultimo_dia_plan(v_30)
         and pg_temp.t3_ficha_creditos(v_user) = 6
         and pg_temp.t3_fechas_usables(v_user) = 1 then
        ok := ok + 1; informe := informe || E'\nOK     (F3) fijar sin nada: now() + 30 días; ficha = ese día y 6 créditos';
      else
        informe := informe || E'\nFALLA  (F3) fijar sin nada -- ficha ' || coalesce(pg_temp.t3_ficha_fecha(v_user)::text, 'null')
                 || ' / ' || coalesce(pg_temp.t3_ficha_creditos(v_user)::text, 'null');
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (F3) ERROR: ' || sqlerrm;
    end;

    -- ── (F4) D-T3b: fijar en 0 a un socio sin nada no crea ningún lote (ni un plan fantasma).
    total := total + 1;
    begin
      perform pg_temp.t3_limpiar(v_user);
      select count(*) into v_n from user_credits where user_id = v_user;
      perform admin_fijar_creditos_disciplina(v_user, v_a, 0);
      select count(*) into v_n2 from user_credits where user_id = v_user;
      if v_n2 = v_n and fecha_plan_socio(v_user) is null and pg_temp.t3_ficha_creditos(v_user) = 0 then
        ok := ok + 1; informe := informe || E'\nOK     (F4) fijar en 0 sin nada: no se creó ningún lote, sigue sin fecha de plan';
      else
        informe := informe || format(E'\nFALLA  (F4) fijar en 0 sin nada -- filas %s -> %s, plan %s', v_n, v_n2, fecha_plan_socio(v_user));
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (F4) ERROR: ' || sqlerrm;
    end;

    -- ── (F5) Fijar en 0 con plan: no crea un lote; el lote queda en 0 con la fecha del plan.
    total := total + 1;
    begin
      perform pg_temp.t3_limpiar(v_user);
      l1 := pg_temp.t3_lote(v_user, v_a, 5, v_plan, now() - interval '3 days');
      l2 := pg_temp.t3_lote(v_user, v_b, 3, v_plan, now() - interval '3 days');
      select count(*) into v_n from user_credits where user_id = v_user and discipline_id = v_a;
      perform admin_fijar_creditos_disciplina(v_user, v_a, 0);
      select count(*) into v_n2 from user_credits where user_id = v_user and discipline_id = v_a;
      if v_n2 = v_n
         and (select remaining_credits = 0 and expires_at = v_plan from user_credits where id = l1)
         and fecha_plan_socio(v_user) = v_plan
         and pg_temp.t3_ficha_creditos(v_user) = 3 then
        ok := ok + 1; informe := informe || E'\nOK     (F5) fijar en 0 con plan: sin lote nuevo, el lote queda en 0 con la fecha del plan';
      else
        informe := informe || format(E'\nFALLA  (F5) fijar en 0 con plan -- filas %s -> %s, plan %s', v_n, v_n2, fecha_plan_socio(v_user));
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (F5) ERROR: ' || sqlerrm;
    end;

    -- ── (A1) +1 va al lote del plan de esa disciplina aunque esté en 0 (mismo día, otra hora),
    --         no al lote con saldo de otra fecha (antes) ni a uno nuevo.
    total := total + 1;
    begin
      perform pg_temp.t3_limpiar(v_user);
      l1 := pg_temp.t3_lote(v_user, v_b, 3, v_plan, now() - interval '3 days');
      l2 := pg_temp.t3_lote(v_user, v_a, 0, ((v_hoy + 20)::timestamp + time '03:00') at time zone c_zona, now() - interval '3 days');
      l3 := pg_temp.t3_lote(v_user, v_a, 4, ((v_hoy + 5)::timestamp + time '12:00') at time zone c_zona, now() - interval '3 days');
      select count(*) into v_n from user_credits where user_id = v_user and discipline_id = v_a;
      perform admin_ajustar_credito_disciplina(v_user, v_a, 1);
      select count(*) into v_n2 from user_credits where user_id = v_user and discipline_id = v_a;
      if v_n2 = v_n
         and (select remaining_credits = 1 and expires_at = (((v_hoy + 20)::timestamp + time '03:00') at time zone c_zona)
              from user_credits where id = l2)
         and (select remaining_credits = 4 from user_credits where id = l3)
         and fecha_plan_socio(v_user) = v_plan then
        ok := ok + 1; informe := informe || E'\nOK     (A1) +1: al lote del plan de esa disciplina que estaba en 0, sin lote nuevo';
      else
        select format('filas %s -> %s; lote del plan %s; lote otra fecha %s', v_n, v_n2,
                 (select remaining_credits from user_credits where id = l2), (select remaining_credits from user_credits where id = l3)) into v_txt;
        informe := informe || E'\nFALLA  (A1) +1 al lote del plan -- ' || coalesce(v_txt, '?');
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (A1) ERROR: ' || sqlerrm;
    end;

    -- ── (A2) +2 sin ningún lote de esa disciplina: lote nuevo con la fecha del plan; ficha con
    --         la misma fecha de antes.
    total := total + 1;
    begin
      perform pg_temp.t3_limpiar(v_user);
      l1 := pg_temp.t3_lote(v_user, v_b, 3, v_plan, now() - interval '3 days');
      v_ficha_fecha_antes := pg_temp.t3_ficha_fecha(v_user);
      perform admin_ajustar_credito_disciplina(v_user, v_a, 2);
      if (select count(*) from user_credits where user_id = v_user and discipline_id = v_a and expires_at > now()) = 1
         and (select count(*) from user_credits where user_id = v_user and discipline_id = v_a
              and remaining_credits = 2 and expires_at = v_plan) = 1
         and pg_temp.t3_fechas_usables(v_user) = 1
         and pg_temp.t3_ficha_creditos(v_user) = 5
         and pg_temp.t3_ficha_fecha(v_user) is not distinct from v_ficha_fecha_antes then
        ok := ok + 1; informe := informe || E'\nOK     (A2) +2 sin lote de esa disciplina: lote nuevo con la fecha del plan; ficha = 5 créditos, misma fecha';
      else
        informe := informe || E'\nFALLA  (A2) +2 sin lote -- ficha ' || coalesce(pg_temp.t3_ficha_creditos(v_user)::text, 'null');
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (A2) ERROR: ' || sqlerrm;
    end;

    -- ── (A3) +1 a un socio sin nada: now() + 30 días y la ficha refleja ese día.
    total := total + 1;
    begin
      perform pg_temp.t3_limpiar(v_user);
      perform admin_ajustar_credito_disciplina(v_user, v_a, 1);
      if (select count(*) from user_credits where user_id = v_user and discipline_id = v_a
          and remaining_credits = 1 and expires_at = v_30) = 1
         and pg_temp.t3_ficha_fecha(v_user) = ultimo_dia_plan(v_30)
         and pg_temp.t3_ficha_creditos(v_user) = 1 then
        ok := ok + 1; informe := informe || E'\nOK     (A3) +1 sin nada: now() + 30 días; ficha = ese día y 1 crédito';
      else
        informe := informe || E'\nFALLA  (A3) +1 sin nada -- ficha ' || coalesce(pg_temp.t3_ficha_fecha(v_user)::text, 'null');
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (A3) ERROR: ' || sqlerrm;
    end;

    -- ── (A4) D-T3d: -1 con 0 créditos: error claro y no cambia nada.
    total := total + 1;
    begin
      perform pg_temp.t3_limpiar(v_user);
      l1 := pg_temp.t3_lote(v_user, v_b, 3, v_plan, now() - interval '3 days');
      l2 := pg_temp.t3_lote(v_user, v_a, 0, v_plan, now() - interval '3 days');
      v_h1 := pg_temp.t3_huella(v_user);
      v_err := 'SIN ERROR';
      begin
        perform admin_ajustar_credito_disciplina(v_user, v_a, -1);
      exception when others then
        v_err := sqlerrm;
      end;
      v_h2 := pg_temp.t3_huella(v_user);
      if v_err = format('El socio no tiene %s crédito(s) vigentes de %s para descontar -- no se cambió nada.', 1, v_nombre_a)
         and v_h1 = v_h2 then
        ok := ok + 1; informe := informe || E'\nOK     (A4) -1 con 0: error claro y no cambió nada';
      else informe := informe || E'\nFALLA  (A4) -1 con 0 -- ' || v_err || case when v_h1 <> v_h2 then ' (y cambió algo)' else '' end; end if;
    exception when others then
      informe := informe || E'\nFALLA  (A4) ERROR: ' || sqlerrm;
    end;

    -- ── (A5) D-T3d: -3 con 2 créditos: error y NO descuenta los 2 que había.
    total := total + 1;
    begin
      perform pg_temp.t3_limpiar(v_user);
      l1 := pg_temp.t3_lote(v_user, v_a, 2, v_plan, now() - interval '3 days');
      v_h1 := pg_temp.t3_huella(v_user);
      v_err := 'SIN ERROR';
      begin
        perform admin_ajustar_credito_disciplina(v_user, v_a, -3);
      exception when others then
        v_err := sqlerrm;
      end;
      v_h2 := pg_temp.t3_huella(v_user);
      if v_err = format('El socio no tiene %s crédito(s) vigentes de %s para descontar -- no se cambió nada.', 3, v_nombre_a)
         and v_h1 = v_h2
         and (select remaining_credits = 2 from user_credits where id = l1) then
        ok := ok + 1; informe := informe || E'\nOK     (A5) -3 con 2: error claro y el lote sigue con 2';
      else informe := informe || E'\nFALLA  (A5) -3 con 2 -- ' || v_err || case when v_h1 <> v_h2 then ' (y cambió algo)' else '' end; end if;
    exception when others then
      informe := informe || E'\nFALLA  (A5) ERROR: ' || sqlerrm;
    end;

    -- ── (A6) -3 con 2 + 3 en dos lotes: el FIFO de siempre (primero el que vence antes).
    total := total + 1;
    begin
      perform pg_temp.t3_limpiar(v_user);
      l1 := pg_temp.t3_lote(v_user, v_a, 2, ((v_hoy + 5)::timestamp + time '12:00') at time zone c_zona, now() - interval '3 days');
      l2 := pg_temp.t3_lote(v_user, v_a, 3, v_plan, now() - interval '3 days');
      perform admin_ajustar_credito_disciplina(v_user, v_a, -3);
      if (select remaining_credits = 0 from user_credits where id = l1)
         and (select remaining_credits = 2 from user_credits where id = l2)
         and pg_temp.t3_ficha_creditos(v_user) = 2 then
        ok := ok + 1; informe := informe || E'\nOK     (A6) -3: FIFO igual que antes (2 del que vence antes, 1 del siguiente)';
      else
        select format('lote 1 = %s, lote 2 = %s', (select remaining_credits from user_credits where id = l1),
                 (select remaining_credits from user_credits where id = l2)) into v_txt;
        informe := informe || E'\nFALLA  (A6) FIFO -- ' || coalesce(v_txt, '?');
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (A6) ERROR: ' || sqlerrm;
    end;

    -- ── (P1) Aparatos con un plan de créditos: la fecha del plan; ficha = el día del plan.
    total := total + 1;
    begin
      perform pg_temp.t3_limpiar(v_user);
      l1 := pg_temp.t3_lote(v_user, v_a, 3, v_plan, now() - interval '3 days');
      perform admin_agregar_aparatos_socio(v_user);
      if (select count(*) from user_credits where user_id = v_user and discipline_id = v_aparatos
          and expires_at > now()) = 1
         and (select count(*) from user_credits where user_id = v_user and discipline_id = v_aparatos
              and remaining_credits is null and expires_at = v_plan) = 1
         and pg_temp.t3_ficha_fecha(v_user) = v_hoy + 20
         and pg_temp.t3_fechas_usables(v_user) = 1 then
        ok := ok + 1; informe := informe || E'\nOK     (P1) Aparatos con plan: la fecha del plan; ficha = ese día';
      else
        informe := informe || E'\nFALLA  (P1) Aparatos con plan -- ficha ' || coalesce(pg_temp.t3_ficha_fecha(v_user)::text, 'null');
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (P1) ERROR: ' || sqlerrm;
    end;

    -- ── (P2) Aparatos a un socio sin nada: now() + 30 días; ficha = ese día.
    total := total + 1;
    begin
      perform pg_temp.t3_limpiar(v_user);
      perform admin_agregar_aparatos_socio(v_user);
      if (select count(*) from user_credits where user_id = v_user and discipline_id = v_aparatos
          and expires_at = v_30) = 1
         and pg_temp.t3_ficha_fecha(v_user) = ultimo_dia_plan(v_30) then
        ok := ok + 1; informe := informe || E'\nOK     (P2) Aparatos sin nada: now() + 30 días; ficha = ese día';
      else
        informe := informe || E'\nFALLA  (P2) Aparatos sin nada -- ficha ' || coalesce(pg_temp.t3_ficha_fecha(v_user)::text, 'null');
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (P2) ERROR: ' || sqlerrm;
    end;

    -- ── (P3) Aparatos con todo en 0 pero el plan corriendo: la fecha de ese lote (T2).
    -- ── (P4) Con Aparatos ya vigente: error de siempre y no cambia nada.
    total := total + 2;
    begin
      perform pg_temp.t3_limpiar(v_user);
      l1 := pg_temp.t3_lote(v_user, v_a, 0, v_plan, now() - interval '1 hour');
      perform admin_agregar_aparatos_socio(v_user);
      if (select count(*) from user_credits where user_id = v_user and discipline_id = v_aparatos
          and expires_at = v_plan) = 1 then
        ok := ok + 1; informe := informe || E'\nOK     (P3) Aparatos con todo en 0 y el plan corriendo: la fecha de ese plan';
      else informe := informe || E'\nFALLA  (P3) Aparatos con todo en 0 -- no quedó con la fecha del plan'; end if;

      v_h1 := pg_temp.t3_huella(v_user);
      v_err := 'SIN ERROR';
      begin
        perform admin_agregar_aparatos_socio(v_user);
      exception when others then
        v_err := sqlerrm;
      end;
      v_h2 := pg_temp.t3_huella(v_user);
      if v_err = 'El socio ya tiene Aparatos vigente -- no hay nada que agregar.' and v_h1 = v_h2 then
        ok := ok + 1; informe := informe || E'\nOK     (P4) Aparatos ya vigente: error de siempre y no cambió nada';
      else informe := informe || E'\nFALLA  (P4) Aparatos ya vigente -- ' || v_err; end if;
    exception when others then
      informe := informe || E'\nFALLA  (P3/P4) ERROR: ' || sqlerrm;
    end;

    -- ── (P5) D-T3e: con 2 disciplinas de membresía, error claro y no cambia nada. La 2ª se crea
    --         en un bloque que se deshace. Si no se puede crear (restricción), queda NO PROBADO.
    v_err := null;
    v_txt := null;
    begin
      perform pg_temp.t3_limpiar(v_user);
      insert into disciplines (name, kind, is_active, show_in_agenda)
      values ('PRUEBA T3 MEMBRESIA ' || gen_random_uuid(), 'membership', false, false);
      v_h1 := pg_temp.t3_huella(v_user);
      begin
        perform admin_agregar_aparatos_socio(v_user);
        v_err := 'SIN ERROR';
      exception when others then
        v_err := sqlerrm;
      end;
      v_txt := case when pg_temp.t3_huella(v_user) = v_h1 then 'intacto' else 'cambió' end;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm <> c_deshacer then v_txt := 'NO PROBADO: ' || sqlerrm; end if;
    end;
    if v_txt like 'NO PROBADO%' then
      informe := informe || E'\nAVISO  (P5) 2 membresías -- ' || v_txt;
    else
      total := total + 1;
      if v_err = format('Hay %s disciplinas de tipo membresía en el catálogo y tiene que haber una sola (Aparatos) -- revisalo en Configuración. No se cambió nada.', 2)
         and v_txt = 'intacto' then
        ok := ok + 1; informe := informe || E'\nOK     (P5) 2 membresías: error claro y no cambió nada';
      else informe := informe || E'\nFALLA  (P5) 2 membresías -- ' || coalesce(v_err, '?') || ' / ' || v_txt; end if;
    end if;

    -- ── (j) D-T3c: DNI sin ficha en socios: las 3 dan error y no cambian nada. Se prueba cambiando
    --        el DNI del perfil dentro de un bloque que se deshace. Si ese cambio no se puede hacer
    --        (restricción o trigger), el caso queda NO PROBADO, no FALLA.
    select d into v_dni_falso
    from (values ('9999999901'), ('9999999902'), ('9999999903')) as t(d)
    where not exists (select 1 from socios where dni = t.d)
      and not exists (select 1 from profiles where dni = t.d)
    limit 1;
    v_err := null;
    v_err2 := null;
    v_err3 := null;
    v_txt := null;
    begin
      perform pg_temp.t3_limpiar(v_user);
      l1 := pg_temp.t3_lote(v_user, v_b, 3, v_plan, now() - interval '3 days');
      update profiles set dni = v_dni_falso where id = v_user;
      v_h1 := pg_temp.t3_huella(v_user);
      begin
        perform admin_fijar_creditos_disciplina(v_user, v_a, 4);
        v_err := 'SIN ERROR';
      exception when others then
        v_err := sqlerrm;
      end;
      begin
        perform admin_ajustar_credito_disciplina(v_user, v_a, 1);
        v_err2 := 'SIN ERROR';
      exception when others then
        v_err2 := sqlerrm;
      end;
      begin
        perform admin_agregar_aparatos_socio(v_user);
        v_err3 := 'SIN ERROR';
      exception when others then
        v_err3 := sqlerrm;
      end;
      v_txt := case when pg_temp.t3_huella(v_user) = v_h1 then 'intacto' else 'cambió' end;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm <> c_deshacer then v_txt := 'NO PROBADO: ' || sqlerrm; end if;
    end;
    if v_txt like 'NO PROBADO%' or v_dni_falso is null then
      informe := informe || E'\nAVISO  (j) DNI sin ficha -- ' || coalesce(v_txt, 'NO PROBADO: no hay DNI libre');
    else
      total := total + 1;
      v_txt := v_txt || ' / fijar: ' || coalesce(v_err, '?') || ' / ajustar: ' || coalesce(v_err2, '?') || ' / aparatos: ' || coalesce(v_err3, '?');
      if v_err = format('El socio tiene DNI %s pero no hay ninguna ficha en Socios con ese DNI -- no se cambió nada.', v_dni_falso)
         and v_err2 = v_err
         and v_err3 = v_err
         and v_txt like 'intacto%' then
        ok := ok + 1; informe := informe || E'\nOK     (j) DNI sin ficha en socios: fijar, ajustar y Aparatos dan error claro y no cambió nada';
      else informe := informe || E'\nFALLA  (j) DNI sin ficha -- ' || v_txt; end if;
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

  -- ── (a) Permisos: las 3 funciones con los mismos permisos de producción (anon incluido) ──
  total := total + 1;
  select string_agg(p.oid::regprocedure::text || ' = ' || coalesce(p.proacl::text, '(por defecto)'), ' | ') into v_txt
  from pg_proc p
  where p.oid in ('public.admin_fijar_creditos_disciplina(uuid, uuid, integer)'::regprocedure,
                  'public.admin_ajustar_credito_disciplina(uuid, uuid, integer)'::regprocedure,
                  'public.admin_agregar_aparatos_socio(uuid)'::regprocedure)
    and coalesce(p.proacl::text, '(por defecto)') <> c_permisos;
  if v_txt is null then
    ok := ok + 1; informe := informe || E'\nOK     (a) permisos de las 3 funciones iguales a producción (anon incluido)';
  else informe := informe || E'\nFALLA  (a) permisos distintos: ' || v_txt; end if;

  -- ── Fin: SIEMPRE con error, para deshacer todo. ─────────────────────────────────────
  raise exception 'PRUEBA T3 TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
