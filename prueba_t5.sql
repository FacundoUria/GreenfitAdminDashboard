-- =====================================================================================
-- PRUEBA de T5 -- supabase_migration_t5_copiador_sin_filas.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA T5 TERMINADA -- se deshizo todo"). El mensaje de ese error ES el informe:
-- "N de M OK" y una línea por chequeo.
--
-- Cómo corre:
--   * Se corre DESPUÉS de la migración. Antes de la migración (0), (a2), (S1) y todos los (P)
--     fallan: (S1) es justo el caso en que la versión vieja crea filas.
--   * Los casos van dentro de una subtransacción que se deshace al final. Lo que se toca de la
--     cuenta de test (vencer lo vigente, cambiar su ficha o su DNI, una disciplina de prueba) se
--     hace SOLO adentro de esa subtransacción. El caso (l) se mide DESPUÉS de deshacerla y
--     confirma que no quedó ningún rastro.
--   * Cada caso va en su propio bloque: si uno revienta, se informa como FALLA y siguen los demás.
--   * La sesión simulada (request.jwt.claims, local a esta transacción) es la de la cuenta de
--     test para sync_my_membership y la del primer admin de profiles para la lista.
--   * Fechas siempre relativas a HOY en Argentina. Evitar correrla justo alrededor de las 00:00.
-- =====================================================================================

do $prueba$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  c_fin_casos constant text := 'FIN_CASOS_T5';
  c_deshacer constant text := 'DESHACER_CASO_T5';
  c_permisos constant text := '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
  c_dni constant text := '44537978';
  v_user uuid;
  v_admin uuid;
  v_socio_id bigint;
  v_disc uuid;
  v_nombre_disc text;
  v_hoy date := (now() at time zone c_zona)::date;
  v_r record;
  v_n int;
  v_txt text;
  v_err text;
  v_dni_falso text;
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
    raise exception 'PRUEBA T5: la cuenta de test tiene que tener exactamente 1 ficha en socios (tiene %). No se probó nada.', v_n;
  end if;

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
  if md5(regexp_replace(pg_get_functiondef('public.sync_my_membership()'::regprocedure), '\s+', '', 'g')) = 'c0f419ee224ba56ca38f1ac3895a43f5'
     and (select provolatile = 's' and prosecdef from pg_proc where oid = 'public.sync_my_membership()'::regprocedure)
     and to_regprocedure('public.admin_socios_pendientes_de_cargar()') is not null
     and md5(regexp_replace(pg_get_functiondef('public.admin_socios_pendientes_de_cargar()'::regprocedure), '\s+', '', 'g')) = '9d21d616161c42cb27e711fbe75b2a20' then
    ok := ok + 1; informe := informe || E'\nOK     (0) migración T5 aplicada (sync_my_membership STABLE con huella T5 y la función nueva)';
  else informe := informe || E'\nFALLA  (0) la migración T5 no está aplicada'; end if;

  -- ── (a) Permisos ──────────────────────────────────────────────────────────────────
  total := total + 1;
  select coalesce(proacl::text, '(por defecto)') into v_txt from pg_proc where oid = 'public.sync_my_membership()'::regprocedure;
  if v_txt = c_permisos then
    ok := ok + 1; informe := informe || E'\nOK     (a1) permisos de sync_my_membership iguales a producción (anon incluido)';
  else informe := informe || E'\nFALLA  (a1) permisos de sync_my_membership: ' || coalesce(v_txt, 'null'); end if;

  total := total + 1;
  begin
    if not has_function_privilege('anon', 'public.admin_socios_pendientes_de_cargar()', 'execute')
       and has_function_privilege('authenticated', 'public.admin_socios_pendientes_de_cargar()', 'execute')
       and not exists (
         select 1 from pg_proc
         where oid = 'public.admin_socios_pendientes_de_cargar()'::regprocedure
           and coalesce(proacl::text, '') ~ '(^|[{,])=') then
      ok := ok + 1; informe := informe || E'\nOK     (a2) admin_socios_pendientes_de_cargar: anon y public NO, authenticated SÍ';
    else
      select coalesce(proacl::text, '(por defecto)') into v_acl from pg_proc where oid = 'public.admin_socios_pendientes_de_cargar()'::regprocedure;
      informe := informe || E'\nFALLA  (a2) permisos de la función nueva: ' || coalesce(v_acl, 'null');
    end if;
  exception when others then
    informe := informe || E'\nFALLA  (a2) ERROR: ' || sqlerrm;
  end;

  -- ── Casos: subtransacción que se deshace al final ─────────────────────────────────
  begin
    -- Auxiliares temporales (se deshacen con la subtransacción).
    create function pg_temp.t5_como(p_user uuid) returns void language plpgsql as $f$
    begin
      perform set_config('request.jwt.claims',
                         case when p_user is null then '' else json_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
      perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
    end;
    $f$;
    create function pg_temp.t5_limpiar(p_user uuid) returns void language sql as $f$
      update user_credits set expires_at = least(expires_at, now() - interval '2 days')
      where user_id = p_user and expires_at > now();
    $f$;
    create function pg_temp.t5_filas(p_user uuid) returns text language sql as $f$
      select md5(coalesce(string_agg(concat_ws(':', id, discipline_id, remaining_credits, expires_at), ',' order by id), '-'))
      from user_credits where user_id = p_user;
    $f$;
    create function pg_temp.t5_en_lista(p_socio bigint) returns boolean language sql as $f$
      select exists (select 1 from public.admin_socios_pendientes_de_cargar() l where l.socio_id = p_socio);
    $f$;

    -- Disciplina de prueba ACTIVA (la versión vieja solo matchea disciplinas activas por nombre),
    -- oculta de la agenda. Existe solo dentro de esta subtransacción.
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA T5 ' || gen_random_uuid(), 'credits', true, false)
    returning id, name into v_disc, v_nombre_disc;

    -- ── (S1) El caso en que la versión VIEJA creaba filas: ficha activa con créditos y una
    --         disciplina del plan sin ninguna fila en user_credits. Ahora: (true, 0) y nada cambia.
    total := total + 1;
    begin
      perform pg_temp.t5_limpiar(v_user);
      update socios
      set plan = coalesce(plan, array[]::text[]) || v_nombre_disc,
          creditos = 7, estado = 'Activo', activo = true,
          fecha_vencimiento = v_hoy + 10
      where dni = c_dni;
      v_txt := pg_temp.t5_filas(v_user);
      perform pg_temp.t5_como(v_user);
      select * into v_r from public.sync_my_membership();
      if v_r.vinculado is true and v_r.sincronizados = 0
         and pg_temp.t5_filas(v_user) = v_txt
         and not exists (select 1 from user_credits where user_id = v_user and discipline_id = v_disc) then
        ok := ok + 1; informe := informe || E'\nOK     (S1) ficha con créditos y disciplina sin filas: (true, 0) y user_credits intacto';
      else
        informe := informe || E'\nFALLA  (S1) devolvió (' || coalesce(v_r.vinculado::text, 'null') || ', ' || coalesce(v_r.sincronizados::text, 'null')
                 || ') / filas ' || case when pg_temp.t5_filas(v_user) = v_txt then 'intactas' else 'CAMBIARON' end;
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (S1) ERROR: ' || sqlerrm;
    end;

    -- ── (S2) Ficha dada de baja (activo = false): (true, 0), igual que antes.
    total := total + 1;
    begin
      update socios set activo = false where dni = c_dni;
      v_txt := pg_temp.t5_filas(v_user);
      perform pg_temp.t5_como(v_user);
      select * into v_r from public.sync_my_membership();
      if v_r.vinculado is true and v_r.sincronizados = 0 and pg_temp.t5_filas(v_user) = v_txt then
        ok := ok + 1; informe := informe || E'\nOK     (S2) ficha dada de baja: (true, 0)';
      else
        informe := informe || E'\nFALLA  (S2) devolvió (' || coalesce(v_r.vinculado::text, 'null') || ', ' || coalesce(v_r.sincronizados::text, 'null') || ')';
      end if;
      update socios set activo = true where dni = c_dni;
    exception when others then
      informe := informe || E'\nFALLA  (S2) ERROR: ' || sqlerrm;
    end;

    -- ── (S3) Sin sesión (auth.uid() null): (false, 0).
    total := total + 1;
    begin
      perform pg_temp.t5_como(null);
      select * into v_r from public.sync_my_membership();
      if v_r.vinculado is false and v_r.sincronizados = 0 then
        ok := ok + 1; informe := informe || E'\nOK     (S3) sin sesión: (false, 0)';
      else
        informe := informe || E'\nFALLA  (S3) devolvió (' || coalesce(v_r.vinculado::text, 'null') || ', ' || coalesce(v_r.sincronizados::text, 'null') || ')';
      end if;
    exception when others then
      informe := informe || E'\nFALLA  (S3) ERROR: ' || sqlerrm;
    end;

    -- ── (S4) Perfil con un DNI que no tiene ficha: (false, 0). Se cambia el DNI del perfil
    --         dentro de un bloque que se deshace. Si no se puede (restricción o trigger), queda
    --         NO PROBADO, no FALLA.
    select d into v_dni_falso
    from (values ('9999999901'), ('9999999902'), ('9999999903')) as t(d)
    where not exists (select 1 from socios where dni = t.d)
      and not exists (select 1 from profiles where dni = t.d)
    limit 1;
    v_txt := null;
    begin
      update profiles set dni = v_dni_falso where id = v_user;
      perform pg_temp.t5_como(v_user);
      select * into v_r from public.sync_my_membership();
      v_txt := '(' || coalesce(v_r.vinculado::text, 'null') || ', ' || coalesce(v_r.sincronizados::text, 'null') || ')';
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm <> c_deshacer then v_txt := 'NO PROBADO: ' || sqlerrm; end if;
    end;
    if v_dni_falso is null or v_txt like 'NO PROBADO%' then
      informe := informe || E'\nAVISO  (S4) DNI sin ficha -- ' || coalesce(v_txt, 'NO PROBADO: no hay DNI libre');
    else
      total := total + 1;
      if v_txt = '(false, 0)' then
        ok := ok + 1; informe := informe || E'\nOK     (S4) perfil con DNI sin ficha: (false, 0)';
      else informe := informe || E'\nFALLA  (S4) perfil con DNI sin ficha devolvió ' || v_txt; end if;
    end if;

    -- ── (P) Lista "Pendientes de cargar" (sesión de admin) ───────────────────────────
    -- Base de cada caso: nada vigente en user_credits, ficha activa con fecha hoy + 10 y
    -- último pago hoy. Cada caso cambia UNA cosa.
    total := total + 1;
    begin
      perform pg_temp.t5_limpiar(v_user);
      update socios set activo = true, fecha_vencimiento = v_hoy + 10, ultimo_pago = v_hoy where dni = c_dni;
      perform pg_temp.t5_como(v_admin);
      if pg_temp.t5_en_lista(v_socio_id) then
        select count(*) into v_n from public.admin_socios_pendientes_de_cargar() l
        where l.socio_id = v_socio_id and l.dni = c_dni and l.fecha_vencimiento_ficha = v_hoy + 10 and l.ultimo_pago = v_hoy;
        if v_n = 1 then
          ok := ok + 1; informe := informe || E'\nOK     (P1) pagó hace poco, ficha vigente, nada en la app: aparece (con su fecha y su último pago)';
        else informe := informe || E'\nFALLA  (P1) aparece, pero con datos distintos'; end if;
      else informe := informe || E'\nFALLA  (P1) no aparece en la lista'; end if;
    exception when others then
      informe := informe || E'\nFALLA  (P1) ERROR: ' || sqlerrm;
    end;

    total := total + 1;
    begin
      perform pg_temp.t5_limpiar(v_user);
      update socios set activo = true, fecha_vencimiento = v_hoy + 10, ultimo_pago = v_hoy where dni = c_dni;
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
      values (v_user, v_disc, 0, now() + interval '5 days');
      perform pg_temp.t5_como(v_admin);
      if not pg_temp.t5_en_lista(v_socio_id) then
        ok := ok + 1; informe := informe || E'\nOK     (P2) con un lote vigente en 0 (ya tiene plan): NO aparece';
      else informe := informe || E'\nFALLA  (P2) aparece aunque tiene un lote vigente en 0'; end if;
    exception when others then
      informe := informe || E'\nFALLA  (P2) ERROR: ' || sqlerrm;
    end;

    total := total + 1;
    begin
      perform pg_temp.t5_limpiar(v_user);
      perform pg_temp.t5_como(v_admin);
      update socios set activo = true, fecha_vencimiento = v_hoy + 10, ultimo_pago = v_hoy - 35 where dni = c_dni;
      v_txt := case when pg_temp.t5_en_lista(v_socio_id) then 'sí' else 'no' end;
      update socios set ultimo_pago = v_hoy - 36 where dni = c_dni;
      v_txt := v_txt || '/' || case when pg_temp.t5_en_lista(v_socio_id) then 'sí' else 'no' end;
      update socios set ultimo_pago = null where dni = c_dni;
      v_txt := v_txt || '/' || case when pg_temp.t5_en_lista(v_socio_id) then 'sí' else 'no' end;
      if v_txt = 'sí/no/no' then
        ok := ok + 1; informe := informe || E'\nOK     (P3) último pago: hoy-35 aparece, hoy-36 y sin pago NO (D-T5e)';
      else informe := informe || E'\nFALLA  (P3) hoy-35 / hoy-36 / sin pago: ' || v_txt; end if;
    exception when others then
      informe := informe || E'\nFALLA  (P3) ERROR: ' || sqlerrm;
    end;

    total := total + 1;
    begin
      perform pg_temp.t5_limpiar(v_user);
      perform pg_temp.t5_como(v_admin);
      update socios set activo = true, ultimo_pago = v_hoy, fecha_vencimiento = v_hoy where dni = c_dni;
      v_txt := case when pg_temp.t5_en_lista(v_socio_id) then 'sí' else 'no' end;
      update socios set fecha_vencimiento = v_hoy - 1 where dni = c_dni;
      v_txt := v_txt || '/' || case when pg_temp.t5_en_lista(v_socio_id) then 'sí' else 'no' end;
      update socios set fecha_vencimiento = null where dni = c_dni;
      v_txt := v_txt || '/' || case when pg_temp.t5_en_lista(v_socio_id) then 'sí' else 'no' end;
      if v_txt = 'sí/no/no' then
        ok := ok + 1; informe := informe || E'\nOK     (P4) fecha de la ficha: hoy aparece, ayer y sin fecha NO';
      else informe := informe || E'\nFALLA  (P4) hoy / ayer / sin fecha: ' || v_txt; end if;
    exception when others then
      informe := informe || E'\nFALLA  (P4) ERROR: ' || sqlerrm;
    end;

    total := total + 1;
    begin
      perform pg_temp.t5_limpiar(v_user);
      perform pg_temp.t5_como(v_admin);
      update socios set activo = false, fecha_vencimiento = v_hoy + 10, ultimo_pago = v_hoy where dni = c_dni;
      if not pg_temp.t5_en_lista(v_socio_id) then
        ok := ok + 1; informe := informe || E'\nOK     (P5) ficha dada de baja: NO aparece';
      else informe := informe || E'\nFALLA  (P5) aparece aunque está dada de baja'; end if;
      update socios set activo = true where dni = c_dni;
    exception when others then
      informe := informe || E'\nFALLA  (P5) ERROR: ' || sqlerrm;
    end;

    -- (P6) Ficha sin cuenta (el DNI del perfil cambia a uno sin ficha, dentro de un bloque que se
    --      deshace): aunque cumple todo lo demás, NO aparece -- para esos está el aviso del cobro.
    v_txt := null;
    begin
      perform pg_temp.t5_limpiar(v_user);
      update socios set activo = true, fecha_vencimiento = v_hoy + 10, ultimo_pago = v_hoy where dni = c_dni;
      update profiles set dni = v_dni_falso where id = v_user;
      perform pg_temp.t5_como(v_admin);
      v_txt := case when pg_temp.t5_en_lista(v_socio_id) then 'aparece' else 'no aparece' end;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm <> c_deshacer then v_txt := 'NO PROBADO: ' || sqlerrm; end if;
    end;
    if v_dni_falso is null or v_txt like 'NO PROBADO%' then
      informe := informe || E'\nAVISO  (P6) sin cuenta -- ' || coalesce(v_txt, 'NO PROBADO: no hay DNI libre');
    else
      total := total + 1;
      if v_txt = 'no aparece' then
        ok := ok + 1; informe := informe || E'\nOK     (P6) ficha sin cuenta en la app: NO aparece (para esos está el aviso del cobro)';
      else informe := informe || E'\nFALLA  (P6) ficha sin cuenta: ' || v_txt; end if;
    end if;

    -- (P7) Un socio (no admin) no puede ver la lista: error 42501.
    total := total + 1;
    v_err := null;
    begin
      perform pg_temp.t5_como(v_user);
      perform public.admin_socios_pendientes_de_cargar();
      v_err := 'SIN ERROR';
    exception when others then
      v_err := sqlstate || ' ' || sqlerrm;
    end;
    if v_err like '42501 %' then
      ok := ok + 1; informe := informe || E'\nOK     (P7) un socio no puede ver la lista (42501)';
    else informe := informe || E'\nFALLA  (P7) socio llamando a la lista: ' || coalesce(v_err, '?'); end if;

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
  raise exception 'PRUEBA T5 TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
