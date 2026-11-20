-- =====================================================================================
-- TANDA DP -- Las funciones NUEVAS dejan de nacer abiertas a PUBLIC y anon.
-- Corrida en producción el 20/11/2026 (prueba 10 de 10). Diagnóstico de ese día: postgres no
-- es superusuario ni miembro de supabase_admin; pg_default_acl con 24 filas (huella abajo);
-- las 57 funciones de public son de postgres; abiertas a anon solo handle_new_user,
-- is_active_socio e is_admin.
--
-- Por qué: Tanda C (10/11/2026) les sacó EXECUTE a PUBLIC y anon a las funciones que ya
-- existían. Toda función que se cree después (o que una migración recree con drop + create)
-- nace otra vez abierta: Postgres le da EXECUTE a PUBLIC a toda función nueva, y Supabase
-- agrega una fila de permisos por defecto en public que le da EXECUTE a anon, authenticated
-- y service_role. Si una migración se olvidaba del revoke, la función quedaba llamable sin
-- login por /rest/v1/rpc.
--
-- Qué cambia (solo los permisos POR DEFECTO de lo que crea postgres, el rol del SQL Editor):
--   1) alter default privileges for role postgres revoke execute on functions from public;
--      SIN "in schema", a propósito: el EXECUTE a PUBLIC es el default GLOBAL de Postgres,
--      no una fila de public, y un revoke "in schema" no puede sacar un permiso global (lo
--      dice la documentación de ALTER DEFAULT PRIVILEGES). La versión "in schema public" no
--      cambia nada para PUBLIC; la G3 y la prueba lo controlan.
--   2) alter default privileges for role postgres in schema public revoke execute on functions from anon;
--      Este sí sale de la fila de public que puso Supabase.
--   authenticated y service_role siguen recibiendo EXECUTE en las funciones nuevas de public.
--
-- Qué NO cambia:
--   * Ninguna función existente (la G4 compara el proacl de TODAS antes y después).
--   * Los defaults de supabase_admin: postgres no es miembro de ese rol, así que no puede
--     cambiarlos (QUERY 1), y solo aplican a lo que crea supabase_admin (QUERY 5).
--   * Tablas y secuencias (ver la nota del final).
--   * "create or replace" de una función que ya existe: conserva sus permisos, como siempre.
--
-- A partir de acá, en las migraciones:
--   * Función nueva que tenga que andar SIN login: "grant execute ... to anon" explícito.
--     Hoy son is_admin() e is_active_socio() (las evalúan políticas que corren para la
--     landing). Si alguna vez se hace drop + create de alguna de las dos, hay que volver a
--     darle anon o la landing se rompe.
--   * Función nueva de uso interno (solo la llaman otras SECURITY DEFINER): sigue naciendo
--     con authenticated; hay que sacárselo a mano, como hasta ahora.
--   * Aplica a funciones nuevas de postgres en CUALQUIER esquema (el revoke a PUBLIC es
--     global), incluidas las de una extensión que se instale desde el editor.
--
-- Guardas (si alguna falla, no se aplica nada):
--   G0) Corre como postgres.
--   G1) La huella de pg_default_acl (todas las filas) es la del diagnóstico (QUERY 3).
--   G2) ANTES: una función nueva en public recibe EXECUTE para PUBLIC, anon, authenticated y
--       service_role (el estado que se corrige; si no, el diagnóstico estaba mal).
--   G3) DESPUÉS: una función nueva en public recibe EXECUTE para authenticated y
--       service_role, y NO para PUBLIC ni anon.
--   G4) DESPUÉS: en los defaults de postgres para funciones solo salieron esas dos entradas
--       (PUBLIC global y anon en public); las demás filas de pg_default_acl quedaron
--       idénticas; el proacl de TODAS las funciones de la base quedó idéntico.
--
-- Respaldo: las dos filas de (postgres, funciones) tal como estaban, en
-- respaldo.permisos_por_defecto (tanda 'DP'). El rollback las restaura exactas.
-- Prueba:   prueba_tanda_dp.sql (DESPUÉS de esta migración: todo OK).
-- Rollback: rollback_tanda_dp.sql.
--
-- Nota (fuera de esta tanda): la misma fila de Supabase le da ALL a anon en TABLAS y
-- SECUENCIAS nuevas de public. Con RLS activada no pasa nada; una tabla nueva sin RLS
-- quedaría abierta. Queda anotado; no se toca acá.
-- =====================================================================================

begin;

-- ── Ayudas (pg_temp: viven solo en esta sesión) ─────────────────────────────────────

-- Fila de pg_default_acl de (postgres, funciones) para un esquema (0 = la global).
create function pg_temp.dp_fila(p_ns oid) returns aclitem[]
language sql stable as $f$
  select d.defaclacl from pg_default_acl d
  where d.defaclrole = 'postgres'::regrole and d.defaclobjtype = 'f' and d.defaclnamespace = p_ns
$f$;

-- Entradas (esquema, recibe, privilegio, con_grant) de esas dos filas. Sin fila global
-- rige el default de Postgres (acldefault: PUBLIC y el dueño).
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

-- Quiénes reciben EXECUTE en una función NUEVA de public creada por postgres (Postgres
-- combina la fila global con la de public).
create function pg_temp.dp_funcion_nueva() returns text[]
language sql stable as $f$
  select coalesce(array_agg(distinct a.recibe order by a.recibe), '{}')
  from pg_temp.dp_actual() a
  where a.privilegio = 'EXECUTE'
$f$;

-- Huella de pg_default_acl (misma cuenta que la QUERY 3 del diagnóstico). Con
-- p_sin_objetivo, sin las dos filas que cambia esta tanda.
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

-- Huella del proacl de TODAS las funciones de la base.
create function pg_temp.dp_huella_funciones() returns text
language sql stable as $f$
  select md5(string_agg(p.oid::text || '=' || coalesce(p.proacl::text, 'NULL'), ';' order by p.oid))
  from pg_proc p
$f$;

-- ── Foto de antes ───────────────────────────────────────────────────────────────────
create temp table _antes on commit drop as
select pg_temp.dp_fila(0)                      as fila_global,
       pg_temp.dp_fila('public'::regnamespace) as fila_public,
       pg_temp.dp_huella_default_acl(true)     as huella_otras_filas,
       pg_temp.dp_huella_funciones()           as huella_funciones;

-- ── G0, G1, G2 ──────────────────────────────────────────────────────────────────────
do $guarda$
declare
  v_huella_esperada text := '6292f1748004dc777a7b09c0e5e9a9c1';   -- QUERY 3 (20/11/2026)
  v_huella text := pg_temp.dp_huella_default_acl(false);
  v_recibe text[] := pg_temp.dp_funcion_nueva();
begin
  if v_huella_esperada like 'PEGAR_%' then
    raise exception 'Tanda DP: falta pegar la huella de la QUERY 3 del diagnóstico. No se aplicó nada.';
  end if;

  -- G0
  if current_user <> 'postgres' then
    raise exception 'Tanda DP: hay que correrla como postgres (está corriendo como %). No se aplicó nada.', current_user;
  end if;

  -- G1
  if v_huella <> v_huella_esperada then
    raise exception 'Tanda DP: pg_default_acl cambió desde el diagnóstico (huella %, se esperaba %). No se aplicó nada.',
      v_huella, v_huella_esperada;
  end if;

  -- G2
  if not (v_recibe @> array['PUBLIC', 'anon', 'authenticated', 'service_role']) then
    raise exception 'Tanda DP: hoy una función nueva en public recibe EXECUTE para % (se esperaba PUBLIC, anon, authenticated y service_role). No se aplicó nada.',
      array_to_string(v_recibe, ', ');
  end if;

  raise notice 'Tanda DP: antes, una función nueva en public recibe EXECUTE para %.', array_to_string(v_recibe, ', ');
end;
$guarda$;

-- ── Respaldo de las dos filas ───────────────────────────────────────────────────────
create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

create table if not exists respaldo.permisos_por_defecto (
  id bigserial primary key,
  tanda text not null,
  rol text not null,
  esquema text not null,        -- '(global)' = la fila sin esquema
  tipo text not null,           -- 'f' = funciones
  acl aclitem[],                -- null = no había fila (regía el default de Postgres)
  guardado_en timestamptz not null default now()
);
revoke all on respaldo.permisos_por_defecto from public, anon, authenticated;

insert into respaldo.permisos_por_defecto (tanda, rol, esquema, tipo, acl)
select 'DP', 'postgres', '(global)', 'f', fila_global from _antes
union all
select 'DP', 'postgres', 'public', 'f', fila_public from _antes;

-- ── El cambio ───────────────────────────────────────────────────────────────────────
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon;

-- ── G3, G4: después ─────────────────────────────────────────────────────────────────
do $despues$
declare
  v_recibe text[] := pg_temp.dp_funcion_nueva();
  v_mal text;
begin
  -- G3
  if v_recibe && array['PUBLIC', 'anon'] or not (v_recibe @> array['authenticated', 'service_role']) then
    raise exception 'Tanda DP: después, una función nueva en public recibiría EXECUTE para % (se esperaba authenticated y service_role, sin PUBLIC ni anon). Se deshace todo.',
      array_to_string(v_recibe, ', ');
  end if;

  -- G4a: en los defaults de postgres para funciones solo salieron las dos entradas.
  select string_agg(format('%s: %s / %s / %s', x.cambio, x.esquema, x.recibe, x.privilegio), '; ')
    into v_mal
  from (
    (select 'salió' as cambio, e.*
     from _antes b, pg_temp.dp_entradas(b.fila_global, b.fila_public) e
     except
     select 'salió', * from pg_temp.dp_actual())
    union all
    (select 'entró' as cambio, * from pg_temp.dp_actual()
     except
     select 'entró', e.*
     from _antes b, pg_temp.dp_entradas(b.fila_global, b.fila_public) e)
  ) x
  where not (x.cambio = 'salió' and x.privilegio = 'EXECUTE'
             and ((x.esquema = '(global)' and x.recibe = 'PUBLIC')
                  or (x.esquema = 'public' and x.recibe = 'anon')));
  if v_mal is not null then
    raise exception 'Tanda DP: en los defaults de postgres para funciones cambió algo más que PUBLIC y anon: %. Se deshace todo.', v_mal;
  end if;

  -- G4b: las demás filas de pg_default_acl (otros roles, otros tipos de objeto) iguales.
  if pg_temp.dp_huella_default_acl(true) <> (select huella_otras_filas from _antes) then
    raise exception 'Tanda DP: cambiaron otras filas de pg_default_acl (de otro rol o de otro tipo de objeto). Se deshace todo.';
  end if;

  -- G4c: ninguna función existente cambió de permisos.
  if pg_temp.dp_huella_funciones() <> (select huella_funciones from _antes) then
    raise exception 'Tanda DP: cambió el proacl de alguna función existente. Se deshace todo.';
  end if;

  raise notice 'Tanda DP aplicada: una función nueva en public recibe EXECUTE para %.', array_to_string(v_recibe, ', ');
end;
$despues$;

drop function pg_temp.dp_funcion_nueva();
drop function pg_temp.dp_actual();
drop function pg_temp.dp_entradas(aclitem[], aclitem[]);
drop function pg_temp.dp_fila(oid);
drop function pg_temp.dp_huella_default_acl(boolean);
drop function pg_temp.dp_huella_funciones();

commit;
