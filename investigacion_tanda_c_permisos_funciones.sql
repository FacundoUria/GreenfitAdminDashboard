-- =====================================================================================
-- TANDA C -- DIAGNÓSTICO (SOLO LECTURA). Son SELECT: no modifican nada.
-- Correr DE A UNA (el editor muestra solo la última grilla) y pasarme el resultado.
--
-- Para qué: la migración de Tanda C le saca EXECUTE a PUBLIC y anon a las funciones de
-- public que hoy lo tienen. Antes hay que saber, DESDE LA BASE (el grep de los repos no ve
-- bien las dependencias internas), quién las usa sin login:
--   * políticas RLS: se evalúan con el rol de quien consulta; si la landing (anon) lee una
--     tabla con una política SIN "to authenticated" que llama a f(), anon necesita EXECUTE
--     sobre f() o la consulta falla con "permission denied for function";
--   * defaults de columnas y CHECKs: también corren con el rol de quien escribe;
--   * vistas; triggers (y en qué tabla: los de auth.* los dispara supabase_auth_admin);
--   * otras funciones: si la que llama es SECURITY DEFINER corre como su dueño y no necesita
--     el permiso del que llama; si es INVOKER, sí.
-- =====================================================================================


-- ============================================================
-- QUERY 1 -- La lista exacta: funciones de public con EXECUTE para PUBLIC o anon.
-- Debería dar las 36 de tu tabla. `firma` es lo que usa la migración.
-- ============================================================
select
  p.oid::regprocedure::text as firma,
  p.prosecdef as security_definer,
  p.prorettype = 'trigger'::regtype as es_de_trigger,
  coalesce(p.proacl::text, '(por defecto: ' || acldefault('f', p.proowner)::text || ')') as proacl,
  exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x,
  exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 'anon'::regrole and a.privilege_type = 'EXECUTE') as anon_x
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.prokind = 'f'
  and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where a.privilege_type = 'EXECUTE' and (a.grantee = 0 or a.grantee = 'anon'::regrole))
order by 1;


-- ============================================================
-- QUERY 2 -- La HUELLA de esa lista (firma = proacl, ordenada). Es la que va en la guarda
-- de la migración: si cambia una sola función o un solo permiso, la migración no aplica.
-- ============================================================
select
  count(*) as funciones,
  md5(string_agg(p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, 'NULL'), ';' order by p.oid::regprocedure::text)) as huella_lista
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.prokind = 'f'
  and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where a.privilege_type = 'EXECUTE' and (a.grantee = 0 or a.grantee = 'anon'::regrole));


-- ============================================================
-- QUERY 3 -- Quién usa cada una DENTRO de la base: políticas (con sus roles), triggers (con
-- su tabla), defaults, CHECKs, vistas y otras funciones (con si la que llama es definer).
-- `aplica_a_anon` = la política no está limitada a authenticated (roles {public} o {anon}).
-- ============================================================
with objetivo as (
  select p.oid, p.proname, p.oid::regprocedure::text as firma
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
    and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.privilege_type = 'EXECUTE' and (a.grantee = 0 or a.grantee = 'anon'::regrole))
)
select o.firma, u.tipo, u.donde, u.detalle
from objetivo o
join lateral (
  -- políticas
  select 'politica' as tipo,
         pol.schemaname || '.' || pol.tablename || ' / ' || pol.policyname as donde,
         format('cmd=%s roles=%s aplica_a_anon=%s', pol.cmd, pol.roles,
                (pol.roles && array['public', 'anon']::name[])) as detalle
  from pg_policies pol
  where coalesce(pol.qual, '') ~* ('\m' || o.proname || '\(')
     or coalesce(pol.with_check, '') ~* ('\m' || o.proname || '\(')
  union all
  -- triggers
  select 'trigger', t.tgrelid::regclass::text || ' / ' || t.tgname,
         case when t.tgrelid::regclass::text like 'auth.%' then 'TABLA DE AUTH: lo dispara supabase_auth_admin' else '' end
  from pg_trigger t where t.tgfoid = o.oid and not t.tgisinternal
  union all
  -- defaults de columnas
  select 'default', d.adrelid::regclass::text || '.' || a.attname, pg_get_expr(d.adbin, d.adrelid)
  from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  where pg_get_expr(d.adbin, d.adrelid) ~* ('\m' || o.proname || '\(')
  union all
  -- CHECKs
  select 'check', c.conrelid::regclass::text || ' / ' || c.conname, pg_get_constraintdef(c.oid)
  from pg_constraint c
  where c.contype = 'c' and pg_get_constraintdef(c.oid) ~* ('\m' || o.proname || '\(')
  union all
  -- vistas
  select 'vista', v.schemaname || '.' || v.viewname, ''
  from pg_views v
  where v.schemaname not in ('pg_catalog', 'information_schema')
    and v.definition ~* ('\m' || o.proname || '\(')
  union all
  -- otras funciones que la llaman
  select 'la llama otra funcion', q.oid::regprocedure::text,
         case when q.prosecdef then 'la que llama es SECURITY DEFINER' else 'la que llama es INVOKER (el que llama necesita EXECUTE)' end
  from pg_proc q
  where q.oid <> o.oid
    and q.prolang not in (select l.oid from pg_language l where l.lanname in ('c', 'internal'))
    and q.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
    and q.prosrc ~* ('\m' || o.proname || '\(')
) u on true
order by o.firma, u.tipo, u.donde;


-- ============================================================
-- QUERY 4 -- Políticas de las tablas que lee la landing SIN login (index.html de
-- greenfit-site): configuracion (banner y redes), disciplines (catálogo) y classes
-- (horarios). Toda política con aplica_a_anon = true se evalúa en las lecturas de la landing.
-- ============================================================
select pol.tablename, pol.policyname, pol.cmd, pol.roles,
       (pol.roles && array['public', 'anon']::name[]) as aplica_a_anon,
       pol.qual, pol.with_check
from pg_policies pol
where pol.schemaname = 'public' and pol.tablename in ('configuracion', 'disciplines', 'classes')
order by pol.tablename, pol.policyname;


-- ============================================================
-- QUERY 5 -- TODAS las políticas que usan is_admin() o is_active_socio(), en cualquier
-- esquema (storage.objects incluido: la API de Storage consulta con el rol del que pide,
-- anon en un bucket público).
-- ============================================================
select pol.schemaname, pol.tablename, pol.policyname, pol.cmd, pol.roles,
       (pol.roles && array['public', 'anon']::name[]) as aplica_a_anon,
       (coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')) ~* '\mis_admin\(' as usa_is_admin,
       (coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')) ~* '\mis_active_socio\(' as usa_is_active_socio
from pg_policies pol
where (coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')) ~* '\m(is_admin|is_active_socio)\('
order by aplica_a_anon desc, pol.schemaname, pol.tablename, pol.policyname;


-- ============================================================
-- QUERY 6 -- Cuenta de test para la prueba (DNI 44537978): su user id.
-- ============================================================
select id, dni, role from profiles where dni = '44537978';
