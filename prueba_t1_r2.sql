-- =====================================================================================
-- PRUEBA de T1 (R2) -- supabase_migration_t1_r2_lotes_en_cero.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA T1 TERMINADA -- se deshizo todo"). El mensaje de ese error ES el informe:
-- "N de M OK" y una línea por chequeo.
--
-- Cómo corre:
--   * Los casos (a)-(e) van dentro de una subtransacción que se deshace al final de los casos.
--     Las dos funciones resetean TODOS los créditos del socio (también los reales de la cuenta
--     de test): por eso el caso (f) se mide DESPUÉS de deshacer esa subtransacción, y confirma
--     que no quedó ningún rastro.
--   * Disciplina y pack de prueba propios (ocultos e inactivos). La sesión simulada es la del
--     primer admin de profiles (request.jwt.claims, local a esta transacción).
--   * Se puede correr ANTES de la migración: los casos (a) y (b) tienen que FALLAR (hoy el lote
--     en 0 queda con fecha futura) y el resto pasar. DESPUÉS de la migración: todo OK.
-- =====================================================================================

do $prueba$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  c_fin_casos constant text := 'FIN_CASOS_T1';
  v_user uuid;
  v_admin uuid;
  v_aparatos uuid;
  v_disc uuid;
  v_pack uuid;
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  l_cero_a uuid;
  l_cero_b uuid;
  l_saldo uuid;
  l_venc_saldo uuid;
  l_venc_cero uuid;
  l_aparatos uuid;
  v_nuevo_a uuid;
  v_nuevo_b uuid;
  r record;
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
  -- La MISMA consulta que usan las dos funciones para encontrar Aparatos.
  select id into v_aparatos from disciplines where kind = 'membership' limit 1;
  if v_aparatos is null then
    raise exception 'No hay ninguna disciplina de tipo membership (Aparatos).';
  end if;

  -- Huella de TODO lo real de la cuenta de test que estas funciones pueden tocar:
  -- sus filas de user_credits y su ficha en socios.
  select md5(coalesce((
           select string_agg(concat_ws(':', id, remaining_credits, expires_at, created_at), ',' order by id)
           from user_credits where user_id = v_user), '-')
         || '|' || coalesce((
           select string_agg(concat_ws(':', s.id, s.creditos, s.fecha_vencimiento), ',' order by s.id)
           from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
    into v_huella_antes;

  -- ── Casos (a)-(e): subtransacción que se deshace al final ─────────────────────────
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);

    -- Disciplina y pack de prueba (mismas columnas que mandan DisciplinaModal.jsx y PackModal.jsx).
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T1 ' || gen_random_uuid(), 'credits', false, false)
    returning id into v_disc;
    insert into packs (name, price, incluye_aparatos, dias_vigencia, creditos, is_active)
    values ('PRUEBA T1 ' || gen_random_uuid(), 1, false, null,
            jsonb_build_array(jsonb_build_object('discipline_id', v_disc, 'credits', 5)), false)
    returning id into v_pack;

    -- Lotes de prueba de la cuenta de test (en la disciplina de prueba, salvo Aparatos):
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (v_user, v_disc, 0, now() + interval '20 days') returning id into l_cero_a;      -- (a) en 0, fecha futura
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (v_user, v_disc, 4, now() + interval '20 days') returning id into l_saldo;       -- (c) con saldo
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (v_user, v_disc, 2, now() - interval '10 days') returning id into l_venc_saldo;  -- (d) vencido con saldo
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (v_user, v_disc, 0, now() - interval '15 days') returning id into l_venc_cero;   -- (d) vencido en 0
    -- created_at de ayer: las dos funciones leen "la fila de Aparatos más reciente por created_at",
    -- y una fila creada en esta misma transacción empataría con la nueva (en producción nunca pasa).
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
    values (v_user, v_aparatos, null, now() + interval '12 days', now() - interval '1 day')
    returning id into l_aparatos;                                                          -- (e) Aparatos vigente

    -- ── (a) Cobro manual: el lote en 0 con fecha futura queda vencido; el nuevo con la fecha nueva
    select * into r from admin_acreditar_creditos_manual(
      v_user, jsonb_build_array(jsonb_build_object('discipline_id', v_disc, 'credits', 3)), false, 30, v_hoy);
    v_nuevo_a := (r.creditos_lotes->0->>'lote_id')::uuid;
    total := total + 1;
    if (select remaining_credits = 0 and expires_at = now() - interval '1 day' from user_credits where id = l_cero_a)
       and (select remaining_credits = 3 and expires_at = (v_hoy::timestamp at time zone c_zona) + interval '30 days'
            from user_credits where id = v_nuevo_a)
       and (select count(*) from user_credits where user_id = v_user and discipline_id = v_disc and expires_at > now()) = 1 then
      ok := ok + 1; informe := informe || E'\nOK     (a) cobro manual: el lote en 0 quedó vencido y el nuevo tiene la fecha nueva';
    else
      select format('lote en 0: saldo %s, vence %s', remaining_credits, expires_at) into v_txt from user_credits where id = l_cero_a;
      informe := informe || E'\nFALLA  (a) cobro manual -- ' || coalesce(v_txt, '?');
    end if;

    -- ── (c) Lote con saldo: igual que hoy (0 y vencido a now() - 1 día)
    total := total + 1;
    if (select remaining_credits = 0 and expires_at = now() - interval '1 day' from user_credits where id = l_saldo) then
      ok := ok + 1; informe := informe || E'\nOK     (c) lote con saldo: en 0 y vencido, igual que hoy';
    else informe := informe || E'\nFALLA  (c) lote con saldo'; end if;

    -- ── (d) Lotes ya vencidos: conservan su fecha real (el de saldo queda en 0, igual que hoy)
    total := total + 1;
    if (select remaining_credits = 0 and expires_at = now() - interval '10 days' from user_credits where id = l_venc_saldo)
       and (select remaining_credits = 0 and expires_at = now() - interval '15 days' from user_credits where id = l_venc_cero) then
      ok := ok + 1; informe := informe || E'\nOK     (d) lotes ya vencidos: conservan su fecha real';
    else informe := informe || E'\nFALLA  (d) lotes ya vencidos'; end if;

    -- ── (e) Aparatos: igual que hoy. Un pago sin Aparatos lo vence a now() - 1 día.
    total := total + 1;
    if (select remaining_credits is null and expires_at = now() - interval '1 day' from user_credits where id = l_aparatos)
       and r.aparatos_extendido = false then
      ok := ok + 1; informe := informe || E'\nOK     (e) Aparatos sin incluir: vencido a now() - 1 día, igual que hoy';
    else informe := informe || E'\nFALLA  (e) Aparatos sin incluir'; end if;

    -- ── (b) acreditar_pack: lo mismo que (a) por la otra función
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (v_user, v_disc, 0, now() + interval '25 days') returning id into l_cero_b;
    select * into r from acreditar_pack(v_user, v_pack, 'manual', null);
    v_nuevo_b := (r.creditos_lotes->0->>'lote_id')::uuid;
    total := total + 1;
    if (select remaining_credits = 0 and expires_at = now() - interval '1 day' from user_credits where id = l_cero_b)
       and (select remaining_credits = 5 and expires_at = now() + interval '30 days' from user_credits where id = v_nuevo_b)
       and (select remaining_credits = 0 and expires_at = now() - interval '1 day' from user_credits where id = v_nuevo_a)
       and (select count(*) from user_credits where user_id = v_user and discipline_id = v_disc and expires_at > now()) = 1 then
      ok := ok + 1; informe := informe || E'\nOK     (b) acreditar_pack: el lote en 0 quedó vencido y el nuevo tiene la fecha nueva';
    else
      select format('lote en 0: saldo %s, vence %s', remaining_credits, expires_at) into v_txt from user_credits where id = l_cero_b;
      informe := informe || E'\nFALLA  (b) acreditar_pack -- ' || coalesce(v_txt, '?');
    end if;

    -- ── (e) Aparatos incluido en el cobro: misma fecha que los créditos nuevos, igual que hoy
    select * into r from admin_acreditar_creditos_manual(
      v_user, jsonb_build_array(jsonb_build_object('discipline_id', v_disc, 'credits', 2)), true, 15, v_hoy);
    total := total + 1;
    if r.aparatos_extendido
       and r.nueva_fecha_vencimiento_aparatos = (((v_hoy::timestamp at time zone c_zona) + interval '15 days') at time zone c_zona)::date
       and (select count(*) from user_credits
            where user_id = v_user and discipline_id = v_aparatos and expires_at > now()
              and expires_at = (v_hoy::timestamp at time zone c_zona) + interval '15 days') = 1
       and (select count(*) from user_credits where user_id = v_user and discipline_id = v_aparatos and expires_at > now()) = 1 then
      ok := ok + 1; informe := informe || E'\nOK     (e) Aparatos incluido: una sola fila vigente, con la misma fecha que los créditos';
    else informe := informe || E'\nFALLA  (e) Aparatos incluido'; end if;

    raise exception '%', c_fin_casos;
  exception when others then
    if sqlerrm <> c_fin_casos then
      total := total + 1;
      informe := informe || E'\nFALLA  ERROR inesperado en los casos: ' || sqlerrm;
    end if;
  end;

  -- ── (f) Ya deshecha la subtransacción: lo real de la cuenta de test quedó igual ────
  select md5(coalesce((
           select string_agg(concat_ws(':', id, remaining_credits, expires_at, created_at), ',' order by id)
           from user_credits where user_id = v_user), '-')
         || '|' || coalesce((
           select string_agg(concat_ws(':', s.id, s.creditos, s.fecha_vencimiento), ',' order by s.id)
           from socios s join profiles p on p.dni = s.dni where p.id = v_user), '-'))
    into v_huella_despues;
  total := total + 1;
  if v_huella_despues = v_huella_antes then
    ok := ok + 1; informe := informe || E'\nOK     (f) créditos y ficha reales de la cuenta de test intactos';
  else informe := informe || E'\nFALLA  (f) cambió algo real de la cuenta de test'; end if;

  -- ── (g) cancel_booking no se tocó ───────────────────────────────────────────────────
  select md5(pg_get_functiondef(oid)) into v_txt
  from pg_proc where proname = 'cancel_booking' and pronamespace = 'public'::regnamespace;
  total := total + 1;
  if v_txt = 'afcc5c25de7f16c3f5a657254c9937ba' then
    ok := ok + 1; informe := informe || E'\nOK     (g) cancel_booking con la misma huella (afcc5c25...)';
  else informe := informe || E'\nFALLA  (g) cancel_booking cambió: ' || coalesce(v_txt, 'no existe'); end if;

  -- ── (h) Permisos: los mismos de antes (los de la migración de revoke del 01/10) ─────
  --   acreditar_pack: nadie de afuera (ni public, ni anon, ni authenticated).
  --   admin_acreditar_creditos_manual: authenticated sí; anon y public no.
  total := total + 1;
  if not has_function_privilege('anon', 'public.acreditar_pack(uuid, uuid, text, text)', 'execute')
     and not has_function_privilege('authenticated', 'public.acreditar_pack(uuid, uuid, text, text)', 'execute')
     and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                     where p.oid = 'public.acreditar_pack(uuid, uuid, text, text)'::regprocedure
                       and a.grantee = 0 and a.privilege_type = 'EXECUTE')
     and (select proacl is not null from pg_proc where oid = 'public.acreditar_pack(uuid, uuid, text, text)'::regprocedure)
     and has_function_privilege('authenticated', 'public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)', 'execute')
     and not has_function_privilege('anon', 'public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)', 'execute')
     and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                     where p.oid = 'public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure
                       and a.grantee = 0 and a.privilege_type = 'EXECUTE')
     and (select proacl is not null from pg_proc where oid = 'public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure) then
    ok := ok + 1; informe := informe || E'\nOK     (h) permisos iguales: acreditar_pack sin nadie de afuera; admin_acreditar_creditos_manual solo authenticated';
  else
    select string_agg(p.proname || ' = ' || coalesce(p.proacl::text, '(por defecto)'), ' | ') into v_txt
    from pg_proc p
    where p.oid in ('public.acreditar_pack(uuid, uuid, text, text)'::regprocedure,
                    'public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure);
    informe := informe || E'\nFALLA  (h) permisos: ' || coalesce(v_txt, '?');
  end if;

  -- ── Fin: SIEMPRE con error, para deshacer todo. ─────────────────────────────────────
  raise exception 'PRUEBA T1 TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
