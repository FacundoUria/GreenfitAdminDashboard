-- =====================================================================================
-- PRUEBA de supabase_migration_revoke_funciones_acreditacion.sql.
-- Las 5 funciones que acreditan créditos:
--   acreditar_pack, mp_process_payment            -> internas / solo webhook
--   admin_acreditar_creditos_manual, admin_aprobar_comprobante -> solo Admin (is_admin adentro)
--   crear_pago_pendiente_transferencia            -> solo socio activo (is_active_socio adentro)
-- Y las 2 que devuelven listas de user_id de socios (privacidad):
--   active_socio_ids                              -> nadie de afuera
--   debtor_user_ids                               -> se cierra anon; authenticated se mantiene
--                                                    (la usa la policy de notifications) y service_role (push)
-- Cuenta de prueba (socio): Facundo Uria, DNI 44537978. Admin: el primer profile con role='admin'.
--
-- SE CORRE DOS VECES, el MISMO archivo:
--   * ANTES del revoke: reproduce los agujeros.
--   * DESPUÉS del revoke: confirma que quedaron cerrados y que NADA de lo legítimo se rompió
--     (comprobante del socio, webhook de Mercado Pago, "Registrar Pago" del Admin).
-- El script detecta solo en cuál de los dos estados está la base (línea ESTADO). Cada chequeo dice
-- qué pasó, y es OK/FALLA según lo que corresponde a los permisos que la base tiene en ese momento.
--
-- QUÉ SIGNIFICA CADA RESULTADO
--   FUNCIONÓ   la llamada corrió y acreditó (créditos creados y deshechos)
--   EJECUTÓ    la función corrió (pasó los permisos), aunque terminó con un error de datos propio
--   RECHAZADO  la función corrió pero SU PROPIO chequeo interno (is_admin / socio activo) la frenó
--   DENEGADO   Postgres no dejó ni entrar a la función (permission denied) -- el revoke
--
-- CÓMO CORRERLO: pegar TODO en el SQL Editor y ejecutar UNA vez. El resultado es la ÚLTIMA grilla.
--
-- NO DEJA NADA EN LA BASE: cada llamada corre con el rol real (authenticated + auth.uid() del socio
-- o del admin, anon, o service_role) dentro de una subtransacción que se DESHACE SIEMPRE. El chequeo
-- FINAL confirma que user_credits, pagos_socio y la ficha de la cuenta de prueba quedaron idénticos.
-- =====================================================================================
begin;

drop table if exists pg_temp._log;
drop table if exists pg_temp._ctx;
drop table if exists pg_temp._antes;
create temp table _log (n bigserial primary key, caso text, linea text);

create temp table _ctx as
select
  (select id from profiles where dni = '44537978') as u,
  (select id from profiles where role = 'admin' order by created_at limit 1) as admin,
  '44537978'::text as dni,
  (select id from packs where is_active = true and jsonb_array_length(creditos) > 0 order by created_at limit 1) as pack,
  (select id from disciplines where kind = 'credits' order by name limit 1) as disciplina,
  'public.acreditar_pack(uuid, uuid, text, text)'::regprocedure as f_acreditar,
  'public.mp_process_payment(uuid, uuid, jsonb, boolean, int, uuid, numeric, text, text, text)'::regprocedure as f_mp,
  'public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, int, date)'::regprocedure as f_manual,
  'public.admin_aprobar_comprobante(uuid)'::regprocedure as f_aprobar,
  'public.crear_pago_pendiente_transferencia(uuid, text, numeric)'::regprocedure as f_comprobante,
  'public.active_socio_ids()'::regprocedure as f_activos,
  'public.debtor_user_ids()'::regprocedure as f_deudores;

do $$
declare c record;
begin
  select * into c from pg_temp._ctx;
  if c.u is null then raise exception 'No existe el perfil con DNI 44537978'; end if;
  if c.admin is null then raise exception 'No hay ningún profile con role = admin'; end if;
  if c.admin = c.u then raise exception 'La cuenta de prueba es admin: hace falta un socio común para probar'; end if;
  if c.pack is null then raise exception 'No hay ningún pack activo con créditos para probar'; end if;
  if c.disciplina is null then raise exception 'No hay ninguna disciplina de créditos'; end if;
end $$;

create temp table _antes as
select
  (select coalesce(md5(string_agg(md5(uc::text), '' order by uc.id::text)), '') from user_credits uc where uc.user_id = (select u from _ctx)) as creditos,
  (select coalesce(md5(string_agg(md5(ps::text), '' order by ps.id::text)), '') from pagos_socio ps where ps.user_id = (select u from _ctx)) as pagos,
  (select md5(s::text) from socios s where s.dni = (select dni from _ctx)) as socio;

insert into _log(caso, linea)
select 'ESTADO', case
  when has_function_privilege('authenticated', f_acreditar, 'execute') or has_function_privilege('anon', f_acreditar, 'execute')
    then 'ANTES del revoke: acreditar_pack se puede llamar desde afuera (agujero ABIERTO)'
  else 'DESPUÉS del revoke: acreditar_pack ya no se puede llamar desde afuera' end
from _ctx;

-- ── Permisos declarados ──
insert into _log(caso, linea)
select 'PERMISOS', format('NOTA      %s -> anon: %s | authenticated: %s | service_role: %s | dueño: %s | security definer: %s',
  rpad(p.proname, 34),
  case when has_function_privilege('anon', p.oid, 'execute') then 'SÍ' else 'no' end,
  case when has_function_privilege('authenticated', p.oid, 'execute') then 'SÍ' else 'no' end,
  case when has_function_privilege('service_role', p.oid, 'execute') then 'SÍ' else 'no' end,
  pg_get_userbyid(p.proowner),
  case when p.prosecdef then 'sí' else 'NO' end)
from pg_proc p, _ctx c
where p.oid in (c.f_acreditar, c.f_mp, c.f_manual, c.f_aprobar, c.f_comprobante, c.f_activos, c.f_deudores)
order by p.proname;

-- Corre p_sql con el rol indicado dentro de una subtransacción que SIEMPRE se deshace.
--   p_rol: 'authenticated' (con auth.uid() = p_uid), 'anon' o 'service_role'.
-- Devuelve: 'paso:<n>' (n = filas de user_credits creadas para la cuenta de prueba),
--           'denegado' (permission denied), o 'error:<mensaje>'.
create or replace function pg_temp.llamar(p_rol text, p_sql text, p_uid uuid default null) returns text language plpgsql as $$
declare
  v_u uuid := (select u from pg_temp._ctx);
  v_creadas int;
begin
  begin
    perform set_config('request.jwt.claims',
      case when p_uid is not null then json_build_object('sub', p_uid, 'role', p_rol)::text
           else json_build_object('role', p_rol)::text end, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    perform set_config('request.jwt.claim.role', p_rol, true);
    execute format('set local role %I', p_rol);
    execute p_sql;
    execute 'reset role';
    -- now() es la hora de la transacción: solo matchea filas creadas por esta prueba.
    select count(*) into v_creadas from user_credits where user_id = v_u and created_at = now();
    raise exception 'DESHACER:%', v_creadas using errcode = 'P0999';
  exception
    when sqlstate 'P0999' then return 'paso:' || split_part(sqlerrm, ':', 2);
    when insufficient_privilege then return 'denegado';
    when others then return 'error:' || sqlerrm;
  end;
end $$;

-- Clasifica y anota. p_con_permiso = qué tiene que pasar si ese rol TIENE EXECUTE sobre la función:
--   'funciona'  -> corre y acredita          'ejecuta'   -> corre (puede terminar en un error de datos)
--   'rechazado' -> la frena su chequeo interno (is_admin / socio activo)
-- Si el rol NO tiene EXECUTE, lo esperado es siempre 'denegado'.
-- p_debe_tener_permiso: true = ese rol TIENE que conservar el EXECUTE (si no, se rompe algo legítimo).
create or replace function pg_temp.anotar(
  p_caso text, p_descripcion text, p_resultado text, p_rol text, p_funcion regprocedure,
  p_con_permiso text, p_debe_tener_permiso boolean default false, p_agujero boolean default false
) returns void language plpgsql as $$
declare
  v_tiene boolean := has_function_privilege(p_rol, p_funcion, 'execute');
  v_tipo text := split_part(p_resultado, ':', 1);
  v_creadas int := case when v_tipo = 'paso' then split_part(p_resultado, ':', 2)::int end;
  v_msg text := case when v_tipo = 'error' then substr(p_resultado, 7) end;
  v_obtenido text;
  v_esperado text := case when v_tiene then p_con_permiso else 'denegado' end;
  v_ok boolean;
begin
  v_obtenido := case
    when v_tipo = 'denegado' then 'denegado'
    when v_tipo = 'paso' and v_creadas > 0 then 'funciona'
    when v_tipo = 'paso' then 'ejecuta'
    when v_msg ilike '%permisos de administrador%' or v_msg ilike '%cuenta de socio activa%' then 'rechazado'
    else 'ejecuta' end;
  v_ok := (v_obtenido = v_esperado or (v_esperado = 'ejecuta' and v_obtenido = 'funciona'))
          and (v_tiene or not p_debe_tener_permiso);

  insert into pg_temp._log(caso, linea) values (p_caso,
    case when v_ok then 'OK        ' else 'FALLA     ' end || p_descripcion || ' -> '
    || case v_obtenido
         when 'funciona' then format('FUNCIONÓ (%s filas de créditos creadas y deshechas)', v_creadas)
         when 'ejecuta' then 'EJECUTÓ' || coalesce(' (terminó con: ' || left(v_msg, 70) || ')', '')
         when 'rechazado' then 'RECHAZADO por el chequeo interno de la función'
         else 'DENEGADO (permission denied)' end
    || case
         when v_ok and p_agujero and v_obtenido in ('funciona', 'ejecuta') then '  <-- AGUJERO reproducido'
         when v_ok then ''
         when p_debe_tener_permiso and not v_tiene then '  <-- ESTE ROL NECESITA EL PERMISO: se rompió algo legítimo'
         else '  (se esperaba: ' || v_esperado || ')' end);
end $$;

-- ============ acreditar_pack: nadie la tiene que poder llamar desde afuera ============
select pg_temp.anotar('1', 'acreditar_pack <- socio logueado',
  pg_temp.llamar('authenticated', format('select * from public.acreditar_pack(%L, %L, ''manual'', ''prueba-revoke'')', c.u, c.pack), c.u),
  'authenticated', c.f_acreditar, 'funciona', false, true) from _ctx c;
select pg_temp.anotar('1', 'acreditar_pack <- anónimo (sin login)',
  pg_temp.llamar('anon', format('select * from public.acreditar_pack(%L, %L, ''manual'', ''prueba-revoke'')', c.u, c.pack)),
  'anon', c.f_acreditar, 'funciona', false, true) from _ctx c;

-- ============ mp_process_payment: solo el webhook (service_role) ============
select pg_temp.anotar('2', 'mp_process_payment <- socio logueado (pago "approved" inventado)',
  pg_temp.llamar('authenticated', format(
    'select * from public.mp_process_payment(%L, %L, ''[]''::jsonb, false, 30, null, 1, ''prueba-revoke'', ''prueba-revoke-socio'', ''approved'')', c.u, c.pack), c.u),
  'authenticated', c.f_mp, 'funciona', false, true) from _ctx c;
select pg_temp.anotar('2', 'mp_process_payment <- anónimo (sin login)',
  pg_temp.llamar('anon', format(
    'select * from public.mp_process_payment(%L, %L, ''[]''::jsonb, false, 30, null, 1, ''prueba-revoke'', ''prueba-revoke-anon'', ''approved'')', c.u, c.pack)),
  'anon', c.f_mp, 'funciona', false, true) from _ctx c;
select pg_temp.anotar('2', 'mp_process_payment <- webhook de Mercado Pago (service_role)  [TIENE que funcionar]',
  pg_temp.llamar('service_role', format(
    'select * from public.mp_process_payment(%L, %L, ''[]''::jsonb, false, 30, null, 1, ''prueba-revoke'', ''prueba-revoke-webhook'', ''approved'')', c.u, c.pack)),
  'service_role', c.f_mp, 'funciona', true) from _ctx c;

-- ============ admin_acreditar_creditos_manual: solo el Admin ("Registrar Pago") ============
select pg_temp.anotar('3', 'admin_acreditar_creditos_manual <- socio logueado (se acredita a sí mismo)',
  pg_temp.llamar('authenticated', format(
    'select * from public.admin_acreditar_creditos_manual(%L, %L::jsonb, false, 30, null)',
    c.u, json_build_array(json_build_object('discipline_id', c.disciplina, 'credits', 1))::text), c.u),
  'authenticated', c.f_manual, 'rechazado') from _ctx c;
select pg_temp.anotar('3', 'admin_acreditar_creditos_manual <- anónimo (sin login)',
  pg_temp.llamar('anon', format(
    'select * from public.admin_acreditar_creditos_manual(%L, %L::jsonb, false, 30, null)',
    c.u, json_build_array(json_build_object('discipline_id', c.disciplina, 'credits', 1))::text)),
  'anon', c.f_manual, 'rechazado') from _ctx c;
select pg_temp.anotar('3', 'admin_acreditar_creditos_manual <- ADMIN logueado ("Registrar Pago")  [TIENE que funcionar]',
  pg_temp.llamar('authenticated', format(
    'select * from public.admin_acreditar_creditos_manual(%L, %L::jsonb, false, 30, null)',
    c.u, json_build_array(json_build_object('discipline_id', c.disciplina, 'credits', 1))::text), c.admin),
  'authenticated', c.f_manual, 'funciona', true) from _ctx c;

-- ============ admin_aprobar_comprobante: solo el Admin ============
select pg_temp.anotar('4', 'admin_aprobar_comprobante <- socio logueado',
  pg_temp.llamar('authenticated', format('select * from public.admin_aprobar_comprobante(%L)', gen_random_uuid()), c.u),
  'authenticated', c.f_aprobar, 'rechazado') from _ctx c;
select pg_temp.anotar('4', 'admin_aprobar_comprobante <- anónimo (sin login)',
  pg_temp.llamar('anon', format('select * from public.admin_aprobar_comprobante(%L)', gen_random_uuid())),
  'anon', c.f_aprobar, 'rechazado') from _ctx c;
select pg_temp.anotar('4', 'admin_aprobar_comprobante <- ADMIN logueado (comprobante inexistente)  [TIENE que ejecutar]',
  pg_temp.llamar('authenticated', format('select * from public.admin_aprobar_comprobante(%L)', gen_random_uuid()), c.admin),
  'authenticated', c.f_aprobar, 'ejecuta', true) from _ctx c;

-- ============ crear_pago_pendiente_transferencia: solo un socio activo (comprobante en la PWA) ============
select pg_temp.anotar('5', 'crear_pago_pendiente_transferencia <- anónimo (sin login)',
  pg_temp.llamar('anon', format('select public.crear_pago_pendiente_transferencia(%L, ''prueba-revoke/comprobante.jpg'', 1)', c.pack)),
  'anon', c.f_comprobante, 'rechazado') from _ctx c;
select pg_temp.anotar('5', 'crear_pago_pendiente_transferencia <- SOCIO logueado (paga con comprobante)  [TIENE que funcionar]',
  pg_temp.llamar('authenticated', format('select public.crear_pago_pendiente_transferencia(%L, ''prueba-revoke/comprobante.jpg'', 1)', c.pack), c.u),
  'authenticated', c.f_comprobante, 'funciona', true) from _ctx c;

-- ============ active_socio_ids / debtor_user_ids: listas de user_id de socios (privacidad) ============
select pg_temp.anotar('7', 'active_socio_ids <- anónimo (sin login): lista de socios activos',
  pg_temp.llamar('anon', 'select * from public.active_socio_ids()'),
  'anon', c.f_activos, 'ejecuta', false, true) from _ctx c;
select pg_temp.anotar('7', 'active_socio_ids <- socio logueado',
  pg_temp.llamar('authenticated', 'select * from public.active_socio_ids()', c.u),
  'authenticated', c.f_activos, 'ejecuta', false, true) from _ctx c;
select pg_temp.anotar('7', 'debtor_user_ids <- anónimo (sin login): lista de socios sin créditos',
  pg_temp.llamar('anon', 'select * from public.debtor_user_ids()'),
  'anon', c.f_deudores, 'ejecuta', false, true) from _ctx c;
select pg_temp.anotar('7', 'debtor_user_ids <- Edge Function send-push (service_role)  [TIENE que ejecutar]',
  pg_temp.llamar('service_role', 'select * from public.debtor_user_ids()'),
  'service_role', c.f_deudores, 'ejecuta', true) from _ctx c;
-- La policy notifications_select_recipient llama a debtor_user_ids() con los permisos del socio:
-- si authenticated perdiera el EXECUTE, esta lectura fallaría con permission denied.
select pg_temp.anotar('7', 'socio logueado lee sus notificaciones (la policy usa debtor_user_ids)  [TIENE que ejecutar]',
  pg_temp.llamar('authenticated', 'select count(*) from public.notifications', c.u),
  'authenticated', c.f_deudores, 'ejecuta', true) from _ctx c;

-- ============ 6: por qué las llamadas internas a acreditar_pack siguen funcionando ============
-- Dentro de una función SECURITY DEFINER el permiso se chequea contra el DUEÑO de esa función, no
-- contra quien la llamó. Tiene que cumplirse: las que llaman a acreditar_pack son SECURITY DEFINER
-- y su dueño tiene EXECUTE sobre acreditar_pack.
insert into _log(caso, linea)
select '6',
  case when p.prosecdef and has_function_privilege(p.proowner, c.f_acreditar, 'execute') then 'OK        ' else 'FALLA     ' end
  || format('%s: security definer = %s, dueño = %s, el dueño puede ejecutar acreditar_pack = %s',
    p.proname, case when p.prosecdef then 'sí' else 'NO' end, pg_get_userbyid(p.proowner),
    case when has_function_privilege(p.proowner, c.f_acreditar, 'execute') then 'sí' else 'NO' end)
from pg_proc p, _ctx c
where p.oid in (c.f_comprobante, c.f_aprobar, c.f_mp)
order by p.proname;

-- ── FINAL ──
insert into _log(caso, linea)
select 'FINAL',
  case when a.creditos = d.creditos and a.pagos = d.pagos and a.socio is not distinct from d.socio
    then 'OK        user_credits, pagos_socio y la ficha de socios de la cuenta de prueba quedaron idénticos'
    else 'FALLA     la cuenta de prueba CAMBIÓ (avisar antes de seguir)' end
from _antes a, (
  select
    (select coalesce(md5(string_agg(md5(uc::text), '' order by uc.id::text)), '') from user_credits uc where uc.user_id = (select u from _ctx)) as creditos,
    (select coalesce(md5(string_agg(md5(ps::text), '' order by ps.id::text)), '') from pagos_socio ps where ps.user_id = (select u from _ctx)) as pagos,
    (select md5(s::text) from socios s where s.dni = (select dni from _ctx)) as socio
) d;

insert into _log(caso, linea)
select 'RESUMEN', format('%s OK, %s FALLA', count(*) filter (where linea like 'OK%'), count(*) filter (where linea like 'FALLA%'))
from _log;

commit;

select caso, linea from pg_temp._log order by n;
