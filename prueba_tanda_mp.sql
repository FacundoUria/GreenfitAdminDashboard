-- =====================================================================================
-- PRUEBA de Tanda MP -- supabase_migration_tanda_mp_on_conflict.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA TANDA MP TERMINADA -- se deshizo todo"). El mensaje de ese error ES el informe:
-- "N de M OK" y una línea por chequeo.
--
-- Cómo corre:
--   * DESPUÉS de la migración. Antes, (0) falla y (2) a (6) fallan con "there is no unique
--     or exclusion constraint matching the ON CONFLICT specification".
--   * Llama a mp_process_payment como lo hace el webhook, con ids de pago inventados
--     ('prueba-tanda-mp-...') y paquete 'PRUEBA TANDA MP'. No habla con Mercado Pago.
--   * (4) y (5) usan un pack activo real: acreditan de verdad a la cuenta de test, dentro de
--     la subtransacción, y se deshace.
--   * Los casos van dentro de una subtransacción que se deshace al final; cada caso en su
--     propio bloque (si uno revienta, se informa como FALLA y siguen los demás). El caso (l)
--     se mide DESPUÉS de deshacer y confirma que no quedó ningún rastro.
-- =====================================================================================

do $prueba$
declare
  c_fin_casos constant text := 'FIN_CASOS_TANDA_MP';
  c_deshacer constant text := 'DESHACER_CASO_TANDA_MP';
  c_dni constant text := '44537978';
  c_paquete constant text := 'PRUEBA TANDA MP';
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_user uuid;
  v_aparatos uuid;
  v_pack record;
  v_b record;
  v_p record;
  v_pago record;
  v_otorgado boolean;
  v_otorgado2 boolean;
  v_mp_id text;
  v_n int;
  v_ok boolean;
  v_ok2 boolean;
  v_txt text;
  v_txt2 text;
  v_def text;
  v_cred_antes text;
  v_cred_medio text;
  v_cred_despues text;
  v_huella_antes text;
  v_huella_despues text;
  ok int := 0;
  total int := 0;
  informe text := '';
begin
  -- ── Preparación (fuera de los casos) ─────────────────────────────────────────────────
  select id into v_user from profiles where dni = c_dni;
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  select id into v_aparatos from disciplines where kind = 'membership' order by id limit 1;
  select id, name, price, creditos, incluye_aparatos, dias_vigencia into v_pack
  from packs where is_active is distinct from false order by id limit 1;

  select md5(coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                       from user_credits where user_id = v_user), '-')
             || '|' || (select count(*) from pagos_socio where paquete = c_paquete or mercado_pago_payment_id like 'prueba-tanda-mp-%')::text)
    into v_huella_antes;

  begin
    -- ── (0) Migración aplicada ──────────────────────────────────────────────────────────
    total := total + 1;
    begin
      if to_regclass('respaldo.tanda_mp_funciones') is null then
        informe := informe || E'\nFALLA  (0) no existe respaldo.tanda_mp_funciones: la migración Tanda MP no está aplicada';
      else
        select * into v_b from respaldo.tanda_mp_funciones;
        v_def := pg_get_functiondef(to_regprocedure(v_b.funcion));
        if md5(regexp_replace(v_def, '\s+', '', 'g')) = v_b.huella_nueva_sin_espacios
           and (select count(*) from regexp_matches(v_def, 'on\s+conflict\s*\(\s*mercado_pago_payment_id\s*\)\s*do\s+nothing', 'gi')) = 0
           and (select count(*) from regexp_matches(v_def, 'on\s+conflict\s*\(\s*mercado_pago_payment_id\s*\)\s*where\s+mercado_pago_payment_id\s+is\s+not\s+null\s+do\s+nothing', 'gi')) = 1
           and v_def !~* '\mcurrent_date\M' then
          ok := ok + 1; informe := informe || E'\nOK     (0) migración aplicada: on conflict con el where del índice parcial, sin current_date';
        else
          informe := informe || E'\nFALLA  (0) mp_process_payment no es la versión de Tanda MP';
        end if;
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (0) ERROR: ' || sqlerrm;
    end;

    -- ── (1) Permisos y atributos iguales a antes ────────────────────────────────────────
    total := total + 1;
    begin
      select * into v_b from respaldo.tanda_mp_funciones;
      select * into v_p from pg_proc where oid = to_regprocedure(v_b.funcion);
      if coalesce(v_p.proacl::text, '(por defecto)') = v_b.permisos
         and v_p.prosecdef = v_b.security_definer
         and v_p.provolatile = v_b.volatilidad
         and coalesce(array_to_string(v_p.proconfig, ','), '') = v_b.config then
        ok := ok + 1; informe := informe || E'\nOK     (1) permisos (' || v_b.permisos || '), security definer, volatilidad y config: iguales a antes';
      else
        informe := informe || E'\nFALLA  (1) antes ' || v_b.permisos || ' / ahora ' || coalesce(v_p.proacl::text, '(por defecto)');
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (1) ERROR: ' || sqlerrm;
    end;

    -- ── (2) y (3) Pago pendiente, y la misma notificación repetida ──────────────────────
    total := total + 2;
    begin
      v_ok := false; v_ok2 := false; v_txt := null; v_txt2 := null;
      v_mp_id := 'prueba-tanda-mp-' || gen_random_uuid()::text;
      select md5(coalesce(string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id), '-'))
        into v_cred_antes from user_credits where user_id = v_user;

      select credito_otorgado into v_otorgado
      from public.mp_process_payment(v_user, null, '[]'::jsonb, true, 30, v_aparatos, 1, c_paquete, v_mp_id, 'pending');
      select fecha, periodo_desde, periodo_hasta, estado into v_pago
      from pagos_socio where mercado_pago_payment_id = v_mp_id;
      select count(*) into v_n from pagos_socio where mercado_pago_payment_id = v_mp_id;
      v_txt := v_n || ' fila, estado ' || coalesce(v_pago.estado, 'null') || ', fecha ' || coalesce(v_pago.fecha::text, 'null')
               || ', desde ' || coalesce(v_pago.periodo_desde::text, 'null') || ', hasta ' || coalesce(v_pago.periodo_hasta::text, 'null')
               || ', otorgado ' || coalesce(v_otorgado::text, 'null');
      v_ok := v_n = 1 and v_pago.estado = 'pendiente' and v_otorgado = false
              and v_pago.fecha = v_hoy and v_pago.periodo_desde = v_hoy and v_pago.periodo_hasta = v_hoy + 30;

      select credito_otorgado into v_otorgado2
      from public.mp_process_payment(v_user, null, '[]'::jsonb, true, 30, v_aparatos, 1, c_paquete, v_mp_id, 'pending');
      select count(*) into v_n from pagos_socio where mercado_pago_payment_id = v_mp_id;
      select md5(coalesce(string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id), '-'))
        into v_cred_despues from user_credits where user_id = v_user;
      v_txt2 := v_n || ' fila, otorgado ' || coalesce(v_otorgado2::text, 'null')
                || case when v_cred_despues = v_cred_antes then ', créditos sin cambios' else ', CAMBIARON los créditos' end;
      v_ok2 := v_n = 1 and v_otorgado2 = false and v_cred_despues = v_cred_antes;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer then
        if v_ok then ok := ok + 1; informe := informe || E'\nOK     (2) pago pending: ' || v_txt;
        else informe := informe || E'\nFALLA  (2) ' || coalesce(v_txt, '?') || ' (hoy en Argentina: ' || v_hoy || ')'; end if;
        if v_ok2 then ok := ok + 1; informe := informe || E'\nOK     (3) la misma notificación otra vez: ' || v_txt2;
        else informe := informe || E'\nFALLA  (3) ' || coalesce(v_txt2, '?'); end if;
      else
        informe := informe || E'\nFALLA  (2) ERROR: ' || sqlerrm || E'\nFALLA  (3) no se llegó (error en (2))';
      end if;
    end;

    -- ── (4) y (5) pending -> approved acredita UNA vez; approved repetido no duplica ────
    total := total + 2;
    begin
      v_ok := false; v_ok2 := false; v_txt := null; v_txt2 := null;
      if v_pack.id is null then
        raise exception 'no hay ningún pack activo para probar la acreditación';
      end if;
      v_mp_id := 'prueba-tanda-mp-' || gen_random_uuid()::text;
      select md5(coalesce(string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id), '-'))
        into v_cred_antes from user_credits where user_id = v_user;

      perform public.mp_process_payment(v_user, v_pack.id, coalesce(v_pack.creditos::jsonb, '[]'::jsonb), coalesce(v_pack.incluye_aparatos, false),
                                        v_pack.dias_vigencia, case when v_pack.incluye_aparatos then v_aparatos end,
                                        v_pack.price, c_paquete, v_mp_id, 'pending');
      select credito_otorgado into v_otorgado
      from public.mp_process_payment(v_user, v_pack.id, coalesce(v_pack.creditos::jsonb, '[]'::jsonb), coalesce(v_pack.incluye_aparatos, false),
                                     v_pack.dias_vigencia, case when v_pack.incluye_aparatos then v_aparatos end,
                                     v_pack.price, c_paquete, v_mp_id, 'approved');
      select estado, detalle_acreditacion into v_pago from pagos_socio where mercado_pago_payment_id = v_mp_id;
      select count(*) into v_n from pagos_socio where mercado_pago_payment_id = v_mp_id;
      select md5(coalesce(string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id), '-'))
        into v_cred_medio from user_credits where user_id = v_user;
      v_txt := 'pack "' || v_pack.name || '": ' || v_n || ' fila, estado ' || coalesce(v_pago.estado, 'null')
               || ', otorgado ' || coalesce(v_otorgado::text, 'null')
               || case when v_pago.detalle_acreditacion ? 'creditos' then ', con detalle_acreditacion' else ', SIN detalle_acreditacion' end
               || case when v_cred_medio <> v_cred_antes then ', créditos acreditados' else ', NO se acreditó nada' end;
      v_ok := v_n = 1 and v_pago.estado = 'pagado' and v_otorgado = true
              and v_pago.detalle_acreditacion ? 'creditos' and v_cred_medio <> v_cred_antes;

      select credito_otorgado into v_otorgado2
      from public.mp_process_payment(v_user, v_pack.id, coalesce(v_pack.creditos::jsonb, '[]'::jsonb), coalesce(v_pack.incluye_aparatos, false),
                                     v_pack.dias_vigencia, case when v_pack.incluye_aparatos then v_aparatos end,
                                     v_pack.price, c_paquete, v_mp_id, 'approved');
      select count(*) into v_n from pagos_socio where mercado_pago_payment_id = v_mp_id;
      select md5(coalesce(string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id), '-'))
        into v_cred_despues from user_credits where user_id = v_user;
      v_txt2 := v_n || ' fila, otorgado ' || coalesce(v_otorgado2::text, 'null')
                || case when v_cred_despues = v_cred_medio then ', créditos iguales a después de (4)' else ', SE VOLVIÓ A ACREDITAR' end;
      v_ok2 := v_n = 1 and v_otorgado2 = false and v_cred_despues = v_cred_medio;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer then
        if v_ok then ok := ok + 1; informe := informe || E'\nOK     (4) pending -> approved acredita una vez: ' || v_txt;
        else informe := informe || E'\nFALLA  (4) ' || coalesce(v_txt, '?'); end if;
        if v_ok2 then ok := ok + 1; informe := informe || E'\nOK     (5) approved repetido no duplica: ' || v_txt2;
        else informe := informe || E'\nFALLA  (5) ' || coalesce(v_txt2, '?'); end if;
      else
        informe := informe || E'\nFALLA  (4) ERROR: ' || sqlerrm || E'\nFALLA  (5) no se llegó (error en (4))';
      end if;
    end;

    -- ── (6) Pago rechazado: anulado y sin acreditar ─────────────────────────────────────
    total := total + 1;
    begin
      v_ok := false; v_txt := null;
      v_mp_id := 'prueba-tanda-mp-' || gen_random_uuid()::text;
      select md5(coalesce(string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id), '-'))
        into v_cred_antes from user_credits where user_id = v_user;
      select credito_otorgado into v_otorgado
      from public.mp_process_payment(v_user, coalesce(v_pack.id, gen_random_uuid()), '[]'::jsonb, false, null, null, 1, c_paquete, v_mp_id, 'rejected');
      select estado into v_pago from pagos_socio where mercado_pago_payment_id = v_mp_id;
      select count(*) into v_n from pagos_socio where mercado_pago_payment_id = v_mp_id;
      select md5(coalesce(string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id), '-'))
        into v_cred_despues from user_credits where user_id = v_user;
      v_txt := v_n || ' fila, estado ' || coalesce(v_pago.estado, 'null') || ', otorgado ' || coalesce(v_otorgado::text, 'null')
               || case when v_cred_despues = v_cred_antes then ', créditos sin cambios' else ', CAMBIARON los créditos' end;
      v_ok := v_n = 1 and v_pago.estado = 'anulado' and v_otorgado = false and v_cred_despues = v_cred_antes;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (6) pago rejected: ' || v_txt;
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (6) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (6) ERROR: ' || sqlerrm; end if;
    end;

    raise exception '%', c_fin_casos;
  exception when others then
    if sqlerrm <> c_fin_casos then
      total := total + 1;
      informe := informe || E'\nFALLA  ERROR inesperado en los casos: ' || sqlerrm;
    end if;
  end;

  -- ── (l) Ya deshecha la subtransacción: no quedó ningún rastro ───────────────────────
  select md5(coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                       from user_credits where user_id = v_user), '-')
             || '|' || (select count(*) from pagos_socio where paquete = c_paquete or mercado_pago_payment_id like 'prueba-tanda-mp-%')::text)
    into v_huella_despues;
  total := total + 1;
  if v_huella_despues = v_huella_antes then
    ok := ok + 1; informe := informe || E'\nOK     (l) créditos de la cuenta de test intactos y ningún pago de prueba guardado';
  else informe := informe || E'\nFALLA  (l) cambió algo real'; end if;

  -- ── Fin: SIEMPRE con error, para deshacer todo. ─────────────────────────────────────
  raise exception 'PRUEBA TANDA MP TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
