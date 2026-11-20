-- =====================================================================================
-- PRUEBA de Tanda DP (supabase_migration_tanda_dp_permisos_por_defecto.sql). Correr DESPUÉS.
--
-- NO DEJA NADA EN LA BASE: la función de prueba (public._prueba_tanda_dp) se crea, se usa y
-- se borra dentro de una subtransacción que se deshace SIEMPRE; cada llamada como anon o como
-- la cuenta de test va en su propia subtransacción (también el "set local role"). Lo único
-- que sobrevive es el log (tabla temporal de la sesión). El caso H lo confirma.
--
-- CASOS
--   A  Defaults: una función nueva en public recibiría EXECUTE para authenticated y
--      service_role, y NO para PUBLIC ni anon.
--   B  Crear de verdad una función nueva en public: su proacl no tiene PUBLIC ni anon;
--      authenticated y service_role sí.
--   C  Llamarla como anon (sin login) -> FALLA con 42501.
--   D  Llamarla como la cuenta de test (authenticated, DNI 44537978) -> ANDA y devuelve su
--      propio id (auth.uid()).
--   E  drop + create de la misma función (lo que hace una migración que la recrea; así se
--      deshacía Tanda C) -> sigue cerrada: anon no puede (42501).
--   F  Con "grant execute ... to anon" explícito -> anon SÍ puede (el camino para una función
--      que tenga que andar sin login, como is_admin() si algún día se recrea).
--   G  Lo que quedó abierto a propósito no cambió: is_admin() e is_active_socio() -> anon
--      puede (la landing).
--   H  No quedó nada: la función de prueba no existe y pg_default_acl está igual que antes
--      de la prueba.
-- Resultado esperado: 10 OK, 0 FALLA.
-- =====================================================================================
begin;

drop table if exists pg_temp._log;
create temp table _log (n bigserial primary key, caso text, linea text);

do $$
begin
  if to_regclass('respaldo.permisos_por_defecto') is null then
    raise exception 'Falta correr supabase_migration_tanda_dp_permisos_por_defecto.sql';
  end if;
  if not exists (select 1 from respaldo.permisos_por_defecto where tanda = 'DP') then
    raise exception 'Falta correr supabase_migration_tanda_dp_permisos_por_defecto.sql';
  end if;
  if not exists (select 1 from profiles where dni = '44537978') then
    raise exception 'No existe la cuenta de test (profiles.dni = 44537978)';
  end if;
  if to_regprocedure('public._prueba_tanda_dp()') is not null then
    raise exception 'Ya existe public._prueba_tanda_dp(): no la piso. Avisame antes de seguir.';
  end if;
end $$;

-- ── Ayudas (mismas cuentas que la migración) ────────────────────────────────────────
create function pg_temp.dp_fila(p_ns oid) returns aclitem[]
language sql stable as $f$
  select d.defaclacl from pg_default_acl d
  where d.defaclrole = 'postgres'::regrole and d.defaclobjtype = 'f' and d.defaclnamespace = p_ns
$f$;

create function pg_temp.dp_entradas(p_global aclitem[], p_public aclitem[])
returns table (esquema text, recibe text, privilegio text, con_grant boolean)
language sql stable as $f$
  select '(global)', case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
         a.privilege_type, a.is_grantable
  from aclexplode(coalesce(p_global, acldefault('f', 'postgres'::regrole))) a
  union all
  select 'public', case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
         a.privilege_type, a.is_grantable
  from aclexplode(coalesce(p_public, '{}'::aclitem[])) a
$f$;

create function pg_temp.dp_funcion_nueva() returns text[]
language sql stable as $f$
  select coalesce(array_agg(distinct a.recibe order by a.recibe), '{}')
  from pg_temp.dp_entradas(pg_temp.dp_fila(0), pg_temp.dp_fila('public'::regnamespace)) a
  where a.privilegio = 'EXECUTE'
$f$;

create function pg_temp.dp_huella_default_acl() returns text
language sql stable as $f$
  select coalesce(md5(string_agg(
           d.defaclrole::regrole::text || '|' || coalesce(n.nspname, '(global)') || '|'
             || d.defaclobjtype::text || '|' || coalesce(d.defaclacl::text, 'NULL'),
           ';' order by d.defaclrole::regrole::text, coalesce(n.nspname, '(global)'), d.defaclobjtype::text)),
         'SIN FILAS')
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
$f$;

create function pg_temp.dp_log(p_caso text, p_ok boolean, p_texto text) returns void
language sql as $f$
  insert into pg_temp._log (caso, linea)
  values (p_caso, case when p_ok then 'OK        ' else 'FALLA     ' end || p_texto)
$f$;

-- Corre p_sql como p_rol (con el JWT de p_user si viene) en una subtransacción que se
-- deshace siempre. resultado: 'anda' o el SQLSTATE del error; valor: lo que devolvió o el
-- mensaje del error.
create function pg_temp.dp_llamar(p_rol text, p_user uuid, p_sql text, out resultado text, out valor text)
language plpgsql as $f$
begin
  begin
    execute format('set local role %I', p_rol);
    perform set_config('request.jwt.claims',
      case when p_user is null then json_build_object('role', p_rol)::text
           else json_build_object('sub', p_user, 'role', p_rol)::text end, true);
    execute p_sql into valor;
    resultado := 'anda';
    raise exception 'DESHACER' using errcode = 'P0999';
  exception
    when sqlstate 'P0999' then null;
    when others then
      get stacked diagnostics resultado = returned_sqlstate, valor = message_text;
  end;
end $f$;

create function pg_temp.dp_txt(p_resultado text, p_valor text) returns text
language sql immutable as $f$
  select case when p_resultado = 'anda' then 'anduvo, devolvió ' || coalesce(p_valor, 'null')
              else format('error %s: %s', p_resultado, p_valor) end
$f$;

create temp table _antes on commit drop as
select pg_temp.dp_huella_default_acl() as huella;

-- ── A: los defaults ─────────────────────────────────────────────────────────────────
do $a$
declare
  v text[] := pg_temp.dp_funcion_nueva();
begin
  perform pg_temp.dp_log('A', not (v && array['PUBLIC', 'anon']) and v @> array['authenticated', 'service_role'],
    'una función nueva en public recibiría EXECUTE para: ' || array_to_string(v, ', '));
end $a$;

-- ── B a F: una función nueva de verdad (todo se deshace al final del bloque interno) ──
do $casos$
declare
  v_test   uuid := (select id from profiles where dni = '44537978');
  k_firma  constant text := 'public._prueba_tanda_dp()';
  k_crear  constant text := $c$
    create function public._prueba_tanda_dp() returns text
    language plpgsql stable as $f$ begin return coalesce(auth.uid()::text, 'sin usuario'); end $f$
  $c$;
  k_llamar constant text := 'select public._prueba_tanda_dp()';
  -- Resultados: las variables sobreviven a la subtransacción que se deshace.
  b_acl text; b_public boolean; b_anon boolean; b_auth boolean; b_srv boolean;
  c_res record; d_res record; e_anon boolean; e_res record; f_res record;
begin
  begin
    -- B: crearla y mirar sus permisos.
    execute k_crear;
    select coalesce(p.proacl::text, 'NULL'),
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE')
      into b_acl, b_public
    from pg_proc p where p.oid = to_regprocedure(k_firma);
    b_anon := has_function_privilege('anon', k_firma, 'EXECUTE');
    b_auth := has_function_privilege('authenticated', k_firma, 'EXECUTE');
    b_srv  := has_function_privilege('service_role', k_firma, 'EXECUTE');

    -- C y D: llamarla sin login y con la cuenta de test.
    select * into c_res from pg_temp.dp_llamar('anon', null, k_llamar);
    select * into d_res from pg_temp.dp_llamar('authenticated', v_test, k_llamar);

    -- E: drop + create (como una migración que la recrea).
    execute 'drop function public._prueba_tanda_dp()';
    execute k_crear;
    e_anon := has_function_privilege('anon', k_firma, 'EXECUTE');
    select * into e_res from pg_temp.dp_llamar('anon', null, k_llamar);

    -- F: abrirla a anon a propósito.
    execute 'grant execute on function public._prueba_tanda_dp() to anon';
    select * into f_res from pg_temp.dp_llamar('anon', null, k_llamar);

    raise exception 'DESHACER' using errcode = 'P0999';
  exception
    when sqlstate 'P0999' then null;
  end;

  perform pg_temp.dp_log('B', not b_public and not b_anon and b_auth and b_srv,
    format('función nueva -> proacl %s; PUBLIC %s, anon %s, authenticated %s, service_role %s', b_acl,
      case when b_public then 'PUEDE' else 'no puede' end,
      case when b_anon   then 'PUEDE' else 'no puede' end,
      case when b_auth   then 'puede' else 'NO PUEDE' end,
      case when b_srv    then 'puede' else 'NO PUEDE' end));
  perform pg_temp.dp_log('C', c_res.resultado = '42501',
    'anon (sin login) la llama -> ' || pg_temp.dp_txt(c_res.resultado, c_res.valor));
  perform pg_temp.dp_log('D', d_res.resultado = 'anda' and d_res.valor = v_test::text,
    'la cuenta de test la llama -> ' || pg_temp.dp_txt(d_res.resultado, d_res.valor)
      || ' (su id es ' || v_test::text || ')');
  perform pg_temp.dp_log('E', not e_anon and e_res.resultado = '42501',
    'drop + create: anon ' || case when e_anon then 'PUEDE' else 'no puede' end
      || '; la llama -> ' || pg_temp.dp_txt(e_res.resultado, e_res.valor));
  perform pg_temp.dp_log('F', f_res.resultado = 'anda',
    'con grant explícito a anon, anon la llama -> ' || pg_temp.dp_txt(f_res.resultado, f_res.valor));
end;
$casos$;

-- ── G: las que quedaron abiertas a propósito ────────────────────────────────────────
insert into _log (caso, linea)
select 'G',
  case when has_function_privilege('anon', f, 'EXECUTE') then 'OK        ' else 'FALLA     ' end
  || f || ' -> anon ' || case when has_function_privilege('anon', f, 'EXECUTE')
                              then 'puede (sigue abierta para la landing)'
                              else 'NO PUEDE (la landing se rompe)' end
from unnest(array['public.is_admin()', 'public.is_active_socio()']) f;

-- ── H: no quedó nada ────────────────────────────────────────────────────────────────
do $h$
declare
  v_existe boolean := to_regprocedure('public._prueba_tanda_dp()') is not null;
  v_igual  boolean := pg_temp.dp_huella_default_acl() = (select huella from _antes);
begin
  perform pg_temp.dp_log('H', not v_existe,
    'función de prueba: ' || case when v_existe then 'TODAVÍA EXISTE' else 'no existe (se deshizo)' end);
  perform pg_temp.dp_log('H', v_igual,
    'pg_default_acl: ' || case when v_igual then 'igual que antes de la prueba' else 'CAMBIÓ durante la prueba' end);
end $h$;

insert into _log (caso, linea)
select 'RESUMEN', format('%s OK, %s FALLA',
  count(*) filter (where linea like 'OK%'), count(*) filter (where linea like 'FALLA%'))
from _log;

commit;

select caso, linea from pg_temp._log order by n;
