-- =====================================================================================
-- PRUEBA de supabase_migration_pendientes_desde_ultimo_pago.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA PENDIENTES-UP TERMINADA -- se deshizo todo"). El mensaje de ese error ES el
-- informe: "N de M OK" y una línea por chequeo.
--
-- Cómo corre:
--   * Se corre DESPUÉS de la migración. Antes, (0), (a), (U2), (U3), (U4a), (U5) y (U7) fallan:
--     (U2) es justo el caso de los 4 socios del 15/11.
--   * Los casos van dentro de una subtransacción que se deshace al final. Lo que se toca de la
--     cuenta de test (envejecer y vencer sus lotes, su ficha, lotes y una disciplina de prueba)
--     se hace SOLO adentro. El caso (l) se mide DESPUÉS de deshacerla.
--   * "Envejecer" = created_at a hace 90 días y expires_at al pasado, para que ningún lote real
--     de la cuenta de test cuente como "cargado desde el pago". created_at no lo mira el
--     candado (T7) y vencer filas no lo dispara.
--   * Sesión simulada (request.jwt.claims, local a la transacción): el primer admin de profiles
--     para la lista; la cuenta de test para el caso (U9).
--   * Fechas relativas a HOY en Argentina. Evitar correrla justo alrededor de las 00:00.
-- =====================================================================================

do $prueba$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  c_fin_casos constant text := 'FIN_CASOS_PU';
  c_dni constant text := '44537978';
  v_user uuid;
  v_admin uuid;
  v_socio_id bigint;
  v_disc uuid;
  v_aparatos uuid;
  v_hoy date := (now() at time zone c_zona)::date;
  v_n int;
  v_txt text;
  v_err text;
  v_viejo text;
  v_huella_antes text;
  v_huella_despues text;
  v_acl text;
  ok int := 0;
  total int := 0;
  informe text := '';
begin
  -- ── Preparación (fuera de la subtransacción) ──────────────────────────────────────
  select id into v_user from profiles where dni = c_dni;
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  select id into v_admin from profiles where role = 'admin' order by created_at limit 1;
  if v_admin is null then
    raise exception 'No hay ningún perfil admin.';
  end if;
  select count(*), min(id::bigint) into v_n, v_socio_id from socios where dni = c_dni;
  if v_n <> 1 then
    raise exception 'PRUEBA PENDIENTES-UP: la cuenta de test tiene que tener exactamente 1 ficha en socios (tiene %). No se probó nada.', v_n;
  end if;
  if (select count(*) from disciplines where kind = 'membership') <> 1 then
    raise exception 'PRUEBA PENDIENTES-UP: tiene que haber exactamente 1 disciplina membership (Aparatos). No se probó nada.';
  end if;
  select id into v_aparatos from disciplines where kind = 'membership';

  -- Huella de TODO lo real de la cuenta de test.
  select md5(coalesce((
           select string_agg(concat_ws(':', id, discipline_id, remaining_credits, expires_at, created_at), ',' order by id)
           from user_credits where user_id = v_user), '-')
         || '|' || coalesce((
           select string_agg(concat_ws(':', s.id, s.plan, s.creditos, s.fecha_vencimiento, s.ultimo_pago, s.estado, s.activo), ',' order by s.id)
           from socios s where s.dni = c_dni), '-')
         || '|' || coalesce((select dni from profiles where id = v_user), '-'))
    into v_huella_antes;

  -- ── (0) La migración está aplicada ────────────────────────────────────────────────
  total := total + 1;
  begin
    if to_regclass('respaldo.pendientes_up_funciones') is not null
       and md5(regexp_replace(pg_get_functiondef('public.admin_socios_pendientes_de_cargar()'::regprocedure), '\s+', '', 'g'))
           = (select huella_nueva_sin_espacios from respaldo.pendientes_up_funciones)
       and (select prosrc ~ 'uc\.created_at\s*>=' and prosrc !~* 'uc\.expires_at\s*>\s*now\(\)'
            from pg_proc where oid = 'public.admin_socios_pendientes_de_cargar()'::regprocedure) then
      ok := ok + 1; informe := informe || E'\nOK     (0) migración aplicada (huella del respaldo, criterio created_at)';
    else informe := informe || E'\nFALLA  (0) la migración no está aplicada'; end if;
  exception when others then
    informe := informe || E'\nFALLA  (0) la migración no está aplicada (' || sqlerrm || ')';
  end;

  -- ── (a) Permisos: iguales a los de antes; anon y public NO, authenticated SÍ ──────
  total := total + 1;
  begin
    select coalesce(proacl::text, '(por defecto)') into v_acl
    from pg_proc where oid = 'public.admin_socios_pendientes_de_cargar()'::regprocedure;
    if v_acl = (select permisos from respaldo.pendientes_up_funciones)
       and not has_function_privilege('anon', 'public.admin_socios_pendientes_de_cargar()', 'execute')
       and has_function_privilege('authenticated', 'public.admin_socios_pendientes_de_cargar()', 'execute')
       and v_acl !~ '(^|[{,])=' then
      ok := ok + 1; informe := informe || E'\nOK     (a) permisos iguales a antes (' || v_acl || ')';
    else informe := informe || E'\nFALLA  (a) permisos: ' || coalesce(v_acl, 'null'); end if;
  exception when others then
    informe := informe || E'\nFALLA  (a) ERROR: ' || sqlerrm;
  end;

  -- ── Casos: subtransacción que se deshace al final ─────────────────────────────────
  begin
    create function pg_temp.pu_como(p_user uuid) returns void language plpgsql as $f$
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', p_user::text, true);
    end;
    $f$;
    -- Base de cada caso: lotes reales envejecidos y vencidos; ficha activa, vence hoy + 10.
    create function pg_temp.pu_base(p_user uuid, p_dni text, p_ultimo_pago date, p_hoy date) returns void language plpgsql as $f$
    begin
      update user_credits
      set created_at = least(created_at, now() - interval '90 days'),
          expires_at = least(expires_at, now() - interval '2 days')
      where user_id = p_user;
      update socios set activo = true, fecha_vencimiento = p_hoy + 10, ultimo_pago = p_ultimo_pago where dni = p_dni;
    end;
    $f$;
    create function pg_temp.pu_lote(p_user uuid, p_disc uuid, p_saldo int, p_vence timestamptz, p_creado timestamptz) returns void language sql as $f$
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
      values (p_user, p_disc, p_saldo, p_vence, p_creado);
    $f$;
    create function pg_temp.pu_en_lista(p_socio bigint) returns text language sql as $f$
      select case when exists (select 1 from public.admin_socios_pendientes_de_cargar() l where l.socio_id = p_socio)
                  then 'aparece' else 'no aparece' end;
    $f$;
    -- El criterio VIEJO (T5), para mostrar que el caso reproduce el bug.
    create function pg_temp.pu_viejo(p_dni text) returns text language sql as $f$
      select case when not exists (select 1 from profiles p join user_credits uc on uc.user_id = p.id
                                   where p.dni = p_dni and uc.expires_at > now())
                  then 'aparecía' else 'no aparecía' end;
    $f$;

    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA PU ' || gen_random_uuid(), 'credits', false, false)
    returning id into v_disc;

    perform pg_temp.pu_como(v_admin);

    -- ── (U1) Pagó sin cuenta y se registró después: nada creado desde el pago -> APARECE.
    total := total + 1;
    begin
      perform pg_temp.pu_base(v_user, c_dni, v_hoy - 10, v_hoy);
      v_txt := pg_temp.pu_en_lista(v_socio_id);
      select count(*) into v_n from public.admin_socios_pendientes_de_cargar() l
      where l.socio_id = v_socio_id and l.dni = c_dni and l.fecha_vencimiento_ficha = v_hoy + 10 and l.ultimo_pago = v_hoy - 10;
      if v_txt = 'aparece' and v_n = 1 then
        ok := ok + 1; informe := informe || E'\nOK     (U1) pagó sin cuenta y se registró después (nada cargado): aparece, con su fecha y su último pago';
      else informe := informe || E'\nFALLA  (U1) ' || v_txt || ' / filas con los datos esperados: ' || v_n; end if;
    exception when others then
      informe := informe || E'\nFALLA  (U1) ERROR: ' || sqlerrm;
    end;

    -- ── (U2) EL BUG DEL 15/11: lote cargado el día del pago, venció HOY a las 00:00 AR, ficha
    --         "hasta hoy" -> NO aparece. Con el criterio viejo aparecía.
    total := total + 1;
    begin
      perform pg_temp.pu_base(v_user, c_dni, v_hoy - 31, v_hoy);
      update socios set fecha_vencimiento = v_hoy where dni = c_dni;
      perform pg_temp.pu_lote(v_user, v_disc, 8,
                              (v_hoy::timestamp at time zone c_zona),
                              ((v_hoy - 31)::timestamp + time '10:00') at time zone c_zona);
      v_viejo := pg_temp.pu_viejo(c_dni);
      v_txt := pg_temp.pu_en_lista(v_socio_id);
      if v_txt = 'no aparece' and v_viejo = 'aparecía' then
        ok := ok + 1; informe := informe || E'\nOK     (U2) lote cargado y vencido hoy 00:00 (ficha hasta hoy): NO aparece (con el criterio viejo aparecía)';
      else informe := informe || E'\nFALLA  (U2) ' || v_txt || ' (criterio viejo: ' || v_viejo || ')'; end if;
    exception when others then
      informe := informe || E'\nFALLA  (U2) ERROR: ' || sqlerrm;
    end;

    -- ── (U3) Lote en 0 creado desde el pago (ya usado o reseteado), vencido -> NO aparece.
    total := total + 1;
    begin
      perform pg_temp.pu_base(v_user, c_dni, v_hoy - 5, v_hoy);
      perform pg_temp.pu_lote(v_user, v_disc, 0, now() - interval '1 hour', ((v_hoy - 5)::timestamp + time '12:00') at time zone c_zona);
      v_txt := pg_temp.pu_en_lista(v_socio_id);
      if v_txt = 'no aparece' then
        ok := ok + 1; informe := informe || E'\nOK     (U3) lote en 0 y vencido, creado desde el pago: NO aparece';
      else informe := informe || E'\nFALLA  (U3) ' || v_txt; end if;
    exception when others then
      informe := informe || E'\nFALLA  (U3) ERROR: ' || sqlerrm;
    end;

    -- ── (U4) Bordes del día del pago (Argentina): creado a las 00:00:00 del día del pago -> NO
    --         aparece; creado a las 23:59:59 del día ANTERIOR -> aparece.
    total := total + 1;
    begin
      perform pg_temp.pu_base(v_user, c_dni, v_hoy - 5, v_hoy);
      perform pg_temp.pu_lote(v_user, v_disc, 0, now() - interval '1 hour', ((v_hoy - 5)::timestamp at time zone c_zona));
      v_txt := pg_temp.pu_en_lista(v_socio_id);
      if v_txt = 'no aparece' then
        ok := ok + 1; informe := informe || E'\nOK     (U4a) creado a las 00:00:00 AR del día del pago: NO aparece';
      else informe := informe || E'\nFALLA  (U4a) ' || v_txt; end if;
    exception when others then
      informe := informe || E'\nFALLA  (U4a) ERROR: ' || sqlerrm;
    end;
    total := total + 1;
    begin
      perform pg_temp.pu_base(v_user, c_dni, v_hoy - 5, v_hoy);
      perform pg_temp.pu_lote(v_user, v_disc, 0, now() - interval '1 hour', ((v_hoy - 6)::timestamp + time '23:59:59') at time zone c_zona);
      v_txt := pg_temp.pu_en_lista(v_socio_id);
      if v_txt = 'aparece' then
        ok := ok + 1; informe := informe || E'\nOK     (U4b) creado a las 23:59:59 AR del día anterior al pago: aparece';
      else informe := informe || E'\nFALLA  (U4b) ' || v_txt; end if;
    exception when others then
      informe := informe || E'\nFALLA  (U4b) ERROR: ' || sqlerrm;
    end;

    -- ── (U5) Solo Aparatos (saldo null) creado desde el pago, vencido -> NO aparece.
    total := total + 1;
    begin
      perform pg_temp.pu_base(v_user, c_dni, v_hoy - 5, v_hoy);
      perform pg_temp.pu_lote(v_user, v_aparatos, null, now() - interval '1 hour', ((v_hoy - 4)::timestamp + time '09:00') at time zone c_zona);
      v_txt := pg_temp.pu_en_lista(v_socio_id);
      if v_txt = 'no aparece' then
        ok := ok + 1; informe := informe || E'\nOK     (U5) Aparatos creado desde el pago (ya vencido): NO aparece';
      else informe := informe || E'\nFALLA  (U5) ' || v_txt; end if;
    exception when others then
      informe := informe || E'\nFALLA  (U5) ERROR: ' || sqlerrm;
    end;

    -- ── (U6) Lote vigente creado desde el pago -> NO aparece (lo de siempre).
    total := total + 1;
    begin
      perform pg_temp.pu_base(v_user, c_dni, v_hoy - 5, v_hoy);
      perform pg_temp.pu_lote(v_user, v_disc, 4, now() + interval '10 days', ((v_hoy - 5)::timestamp + time '18:00') at time zone c_zona);
      v_txt := pg_temp.pu_en_lista(v_socio_id);
      if v_txt = 'no aparece' then
        ok := ok + 1; informe := informe || E'\nOK     (U6) lote vigente creado desde el pago: NO aparece';
      else informe := informe || E'\nFALLA  (U6) ' || v_txt; end if;
    exception when others then
      informe := informe || E'\nFALLA  (U6) ERROR: ' || sqlerrm;
    end;

    -- ── (U7) Comportamiento NUEVO a propósito: lote vigente de un pago ANTERIOR y ninguno creado
    --         desde el último pago -> APARECE (con el criterio viejo no aparecía).
    total := total + 1;
    begin
      perform pg_temp.pu_base(v_user, c_dni, v_hoy - 2, v_hoy);
      perform pg_temp.pu_lote(v_user, v_disc, 4, now() + interval '5 days', ((v_hoy - 40)::timestamp + time '18:00') at time zone c_zona);
      v_viejo := pg_temp.pu_viejo(c_dni);
      v_txt := pg_temp.pu_en_lista(v_socio_id);
      if v_txt = 'aparece' and v_viejo = 'no aparecía' then
        ok := ok + 1; informe := informe || E'\nOK     (U7) plan vigente de un pago anterior, nada cargado del último: aparece (antes quedaba escondido)';
      else informe := informe || E'\nFALLA  (U7) ' || v_txt || ' (criterio viejo: ' || v_viejo || ')'; end if;
    exception when others then
      informe := informe || E'\nFALLA  (U7) ERROR: ' || sqlerrm;
    end;

    -- ── (U8) Los filtros de T5 siguen: baja / ficha vencida ayer / pago hoy-36 -> NO; pago hoy-35 -> SÍ.
    total := total + 1;
    begin
      perform pg_temp.pu_base(v_user, c_dni, v_hoy - 35, v_hoy);
      v_txt := pg_temp.pu_en_lista(v_socio_id);
      update socios set ultimo_pago = v_hoy - 36 where dni = c_dni;
      v_txt := v_txt || '/' || pg_temp.pu_en_lista(v_socio_id);
      update socios set ultimo_pago = v_hoy - 5, fecha_vencimiento = v_hoy - 1 where dni = c_dni;
      v_txt := v_txt || '/' || pg_temp.pu_en_lista(v_socio_id);
      update socios set fecha_vencimiento = v_hoy + 10, activo = false where dni = c_dni;
      v_txt := v_txt || '/' || pg_temp.pu_en_lista(v_socio_id);
      if v_txt = 'aparece/no aparece/no aparece/no aparece' then
        ok := ok + 1; informe := informe || E'\nOK     (U8) filtros de T5: pago hoy-35 sí; hoy-36, ficha vencida y baja NO';
      else informe := informe || E'\nFALLA  (U8) hoy-35 / hoy-36 / vencida / baja: ' || v_txt; end if;
    exception when others then
      informe := informe || E'\nFALLA  (U8) ERROR: ' || sqlerrm;
    end;

    -- ── (U9) Un socio (no admin) no puede ver la lista: 42501.
    total := total + 1;
    v_err := null;
    begin
      perform pg_temp.pu_como(v_user);
      perform public.admin_socios_pendientes_de_cargar();
      v_err := 'SIN ERROR';
    exception when others then
      v_err := sqlstate || ' ' || sqlerrm;
    end;
    perform pg_temp.pu_como(v_admin);
    if v_err like '42501 %' then
      ok := ok + 1; informe := informe || E'\nOK     (U9) un socio no puede ver la lista (42501)';
    else informe := informe || E'\nFALLA  (U9) socio llamando a la lista: ' || coalesce(v_err, '?'); end if;

    raise exception '%', c_fin_casos;
  exception when others then
    if sqlerrm <> c_fin_casos then
      total := total + 1;
      informe := informe || E'\nFALLA  ERROR inesperado en los casos: ' || sqlerrm;
    end if;
  end;

  -- ── (l) Ya deshecha la subtransacción: lo real de la cuenta de test quedó igual ────
  select md5(coalesce((
           select string_agg(concat_ws(':', id, discipline_id, remaining_credits, expires_at, created_at), ',' order by id)
           from user_credits where user_id = v_user), '-')
         || '|' || coalesce((
           select string_agg(concat_ws(':', s.id, s.plan, s.creditos, s.fecha_vencimiento, s.ultimo_pago, s.estado, s.activo), ',' order by s.id)
           from socios s where s.dni = c_dni), '-')
         || '|' || coalesce((select dni from profiles where id = v_user), '-'))
    into v_huella_despues;
  total := total + 1;
  if v_huella_despues = v_huella_antes then
    ok := ok + 1; informe := informe || E'\nOK     (l) créditos, ficha y perfil reales de la cuenta de test intactos';
  else informe := informe || E'\nFALLA  (l) cambió algo real de la cuenta de test'; end if;

  -- ── Fin: SIEMPRE con error, para deshacer todo. ─────────────────────────────────────
  raise exception 'PRUEBA PENDIENTES-UP TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
