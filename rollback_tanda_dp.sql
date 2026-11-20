-- =====================================================================================
-- ROLLBACK de Tanda DP (supabase_migration_tanda_dp_permisos_por_defecto.sql).
-- NO SE CORRIÓ TODAVÍA. ESTAMOS EN PRODUCCIÓN. Solo si la prueba falla.
--
-- Vuelve a dar EXECUTE por defecto a PUBLIC (global) y a anon (en public) en las funciones
-- que cree postgres: las dos filas de (postgres, funciones) quedan EXACTAMENTE como en
-- respaldo.permisos_por_defecto (tanda 'DP'). No toca ninguna función existente, tampoco
-- las que se hayan creado mientras la tanda estuvo aplicada (esas conservan sus permisos).
--
-- Guardas (si alguna falla, no se hace nada):
--   G0) Corre como postgres y existe el respaldo de Tanda DP.
--   G1) Hoy los defaults son los que dejó la migración (el respaldo sin PUBLIC global ni
--       anon en public). Si alguien los cambió después, no se pisa nada.
--   G2) DESPUÉS: las entradas de las dos filas son, una por una, las del respaldo; las demás
--       filas de pg_default_acl y el proacl de todas las funciones no cambiaron.
-- =====================================================================================

begin;

-- ── G0 ──────────────────────────────────────────────────────────────────────────────
do $g0$
begin
  if current_user <> 'postgres' then
    raise exception 'Rollback Tanda DP: hay que correrlo como postgres (está corriendo como %). No se hizo nada.', current_user;
  end if;
  if to_regclass('respaldo.permisos_por_defecto') is null then
    raise exception 'Rollback Tanda DP: no existe respaldo.permisos_por_defecto. No se hizo nada.';
  end if;
  if not exists (select 1 from respaldo.permisos_por_defecto where tanda = 'DP') then
    raise exception 'Rollback Tanda DP: no hay respaldo de Tanda DP. No se hizo nada.';
  end if;
end $g0$;

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

create function pg_temp.dp_actual()
returns table (esquema text, recibe text, privilegio text, con_grant boolean)
language sql stable as $f$
  select * from pg_temp.dp_entradas(pg_temp.dp_fila(0), pg_temp.dp_fila('public'::regnamespace))
$f$;

create function pg_temp.dp_funcion_nueva() returns text[]
language sql stable as $f$
  select coalesce(array_agg(distinct a.recibe order by a.recibe), '{}')
  from pg_temp.dp_actual() a
  where a.privilegio = 'EXECUTE'
$f$;

create function pg_temp.dp_huella_default_acl(p_sin_objetivo boolean) returns text
language sql stable as $f$
  select coalesce(md5(string_agg(
           d.defaclrole::regrole::text || '|' || coalesce(n.nspname, '(global)') || '|'
             || d.defaclobjtype::text || '|' || coalesce(d.defaclacl::text, 'NULL'),
           ';' order by d.defaclrole::regrole::text, coalesce(n.nspname, '(global)'), d.defaclobjtype::text)),
         'SIN FILAS')
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
  where not p_sin_objetivo
     or not (d.defaclrole = 'postgres'::regrole and d.defaclobjtype = 'f'
             and d.defaclnamespace in (0::oid, 'public'::regnamespace::oid))
$f$;

create function pg_temp.dp_huella_funciones() returns text
language sql stable as $f$
  select md5(string_agg(p.oid::text || '=' || coalesce(p.proacl::text, 'NULL'), ';' order by p.oid))
  from pg_proc p
$f$;

-- Las dos filas del respaldo (la última guardada de cada una).
create temp table _respaldo on commit drop as
select (select acl from respaldo.permisos_por_defecto
        where tanda = 'DP' and rol = 'postgres' and tipo = 'f' and esquema = '(global)'
        order by id desc limit 1) as fila_global,
       (select acl from respaldo.permisos_por_defecto
        where tanda = 'DP' and rol = 'postgres' and tipo = 'f' and esquema = 'public'
        order by id desc limit 1) as fila_public;

-- Entradas del respaldo; con p_sin_objetivo, sin las dos que sacó la migración.
create function pg_temp.dp_del_respaldo(p_sin_objetivo boolean)
returns table (esquema text, recibe text, privilegio text, con_grant boolean)
language sql stable as $f$
  select e.*
  from pg_temp._respaldo r, pg_temp.dp_entradas(r.fila_global, r.fila_public) e
  where not p_sin_objetivo
     or not (e.privilegio = 'EXECUTE'
             and ((e.esquema = '(global)' and e.recibe = 'PUBLIC')
                  or (e.esquema = 'public' and e.recibe = 'anon')))
$f$;

create temp table _antes on commit drop as
select pg_temp.dp_huella_default_acl(true) as huella_otras_filas,
       pg_temp.dp_huella_funciones()       as huella_funciones;

-- ── G1: hoy está lo que dejó la migración ───────────────────────────────────────────
do $g1$
declare
  v_mal text;
begin
  select string_agg(format('%s: %s / %s / %s', x.cambio, x.esquema, x.recibe, x.privilegio), '; ')
    into v_mal
  from (
    (select 'falta' as cambio, * from pg_temp.dp_del_respaldo(true)
     except
     select 'falta', * from pg_temp.dp_actual())
    union all
    (select 'sobra' as cambio, * from pg_temp.dp_actual()
     except
     select 'sobra', * from pg_temp.dp_del_respaldo(true))
  ) x;
  if v_mal is not null then
    raise exception 'Rollback Tanda DP: los defaults de hoy no son los que dejó la migración (%). No se hizo nada.', v_mal;
  end if;
end $g1$;

-- ── Restaurar ───────────────────────────────────────────────────────────────────────
alter default privileges for role postgres grant execute on functions to public;
alter default privileges for role postgres in schema public grant execute on functions to anon;

-- ── G2: después ─────────────────────────────────────────────────────────────────────
do $g2$
declare
  v_mal text;
begin
  select string_agg(format('%s: %s / %s / %s', x.cambio, x.esquema, x.recibe, x.privilegio), '; ')
    into v_mal
  from (
    (select 'falta' as cambio, * from pg_temp.dp_del_respaldo(false)
     except
     select 'falta', * from pg_temp.dp_actual())
    union all
    (select 'sobra' as cambio, * from pg_temp.dp_actual()
     except
     select 'sobra', * from pg_temp.dp_del_respaldo(false))
  ) x;
  if v_mal is not null then
    raise exception 'Rollback Tanda DP: los defaults no quedaron como el respaldo: %. Se deshace todo.', v_mal;
  end if;

  if pg_temp.dp_huella_default_acl(true) <> (select huella_otras_filas from _antes) then
    raise exception 'Rollback Tanda DP: cambiaron otras filas de pg_default_acl. Se deshace todo.';
  end if;

  if pg_temp.dp_huella_funciones() <> (select huella_funciones from _antes) then
    raise exception 'Rollback Tanda DP: cambió el proacl de alguna función existente. Se deshace todo.';
  end if;

  raise notice 'Rollback Tanda DP aplicado: una función nueva en public vuelve a recibir EXECUTE para %. Fila global: %. Fila de public: %.',
    array_to_string(pg_temp.dp_funcion_nueva(), ', '),
    case when pg_temp.dp_fila(0)::text is not distinct from (select fila_global::text from _respaldo)
         then 'igual al respaldo' else 'mismos permisos, otro texto' end,
    case when pg_temp.dp_fila('public'::regnamespace)::text is not distinct from (select fila_public::text from _respaldo)
         then 'igual al respaldo' else 'mismos permisos, otro orden' end;
end $g2$;

drop function pg_temp.dp_del_respaldo(boolean);
drop function pg_temp.dp_funcion_nueva();
drop function pg_temp.dp_actual();
drop function pg_temp.dp_entradas(aclitem[], aclitem[]);
drop function pg_temp.dp_fila(oid);
drop function pg_temp.dp_huella_default_acl(boolean);
drop function pg_temp.dp_huella_funciones();

commit;
