-- =====================================================================================
-- TANDA UA -- DIAGNÓSTICO (SOLO LECTURA). Son SELECT: no modifican nada.
-- Correr DE A UNA (el editor muestra solo la última grilla) y pasarme el resultado.
--
-- Para qué: tres funciones aceptan el user_id de cualquiera.
--   * esta_habilitado_para_disciplina(p_user_id, p_discipline_id): cualquier socio logueado
--     puede preguntar si OTRO socio tiene el plan vigente.
--   * resolver_fecha_plan_actual(p_user_id): cualquier socio logueado puede ver la fecha de
--     plan de OTRO socio. Ningún cliente la llama (solo funciones SECURITY DEFINER).
--   * community_author_names(p_ids): devuelve nombre y foto de CUALQUIER perfil.
-- Antes de tocarlas: huellas exactas, puntos de inserción, quién las usa dentro de la base y
-- con qué permisos, y las cuentas para la prueba.
-- =====================================================================================


-- ============================================================
-- QUERY 1 -- HUELLAS de producción. Van en las guardas de la migración:
--   esta_habilitado_para_disciplina -> huella   (y ancla_veces tiene que dar 1)
--   resolver_fecha_plan_actual      -> permisos (texto exacto del proacl)
--   community_author_names          -> huella   (y ancla_veces tiene que dar 1)
-- ya_tiene_guarda tiene que dar false en las tres. Pasame también la definicion.
-- ============================================================
select p.oid::regprocedure::text                        as funcion,
       md5(pg_get_functiondef(p.oid))                   as huella,
       coalesce(p.proacl::text, '(por defecto)')        as permisos,
       pg_get_userbyid(p.proowner)                      as duenio,
       l.lanname                                        as lenguaje,
       p.prosecdef                                      as security_definer,
       p.provolatile                                    as volatilidad,
       coalesce(array_to_string(p.proconfig, ','), '')  as config,
       case p.proname
         when 'esta_habilitado_para_disciplina' then
           (length(p.prosrc) - length(replace(p.prosrc, 'select kind into v_kind from disciplines where id = p_discipline_id;', '')))
             / length('select kind into v_kind from disciplines where id = p_discipline_id;')
         when 'community_author_names' then
           (length(p.prosrc) - length(replace(p.prosrc, 'select id, full_name, avatar_url from profiles where id = any(p_ids);', '')))
             / length('select id, full_name, avatar_url from profiles where id = any(p_ids);')
       end                                              as ancla_veces,
       position('Tanda UA' in p.prosrc) > 0             as ya_tiene_guarda,
       pg_get_functiondef(p.oid)                        as definicion
from pg_proc p
join pg_language l on l.oid = p.prolang
where p.oid in ('public.esta_habilitado_para_disciplina(uuid, uuid)'::regprocedure,
                'public.resolver_fecha_plan_actual(uuid)'::regprocedure,
                'public.community_author_names(uuid[])'::regprocedure)
order by 1;


-- ============================================================
-- QUERY 2 -- Quién las usa DENTRO de la base: otras funciones (con si son SECURITY DEFINER y
-- de quién), políticas (con sus roles), triggers, defaults, CHECKs y vistas.
-- Para resolver_fecha_plan_actual: si TODAS las que la llaman son SECURITY DEFINER de
-- postgres y no aparece en políticas/defaults/CHECKs/vistas, se le puede sacar authenticated.
-- ============================================================
with objetivo as (
  select p.oid, p.proname, p.oid::regprocedure::text as firma
  from pg_proc p
  where p.oid in ('public.esta_habilitado_para_disciplina(uuid, uuid)'::regprocedure,
                  'public.resolver_fecha_plan_actual(uuid)'::regprocedure,
                  'public.community_author_names(uuid[])'::regprocedure)
)
select o.firma, u.tipo, u.donde, u.detalle
from objetivo o
join lateral (
  select 'la llama otra funcion' as tipo, q.oid::regprocedure::text as donde,
         format('%s, dueño %s', case when q.prosecdef then 'SECURITY DEFINER' else 'INVOKER (el que llama necesita EXECUTE)' end,
                pg_get_userbyid(q.proowner)) as detalle
  from pg_proc q
  where q.oid <> o.oid
    and q.prolang not in (select l.oid from pg_language l where l.lanname in ('c', 'internal'))
    and q.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
    and q.prosrc ~* ('\m' || o.proname || '\s*\(')
  union all
  select 'politica', pol.schemaname || '.' || pol.tablename || ' / ' || pol.policyname,
         format('cmd=%s roles=%s', pol.cmd, pol.roles)
  from pg_policies pol
  where coalesce(pol.qual, '') ~* ('\m' || o.proname || '\s*\(')
     or coalesce(pol.with_check, '') ~* ('\m' || o.proname || '\s*\(')
  union all
  select 'trigger', t.tgrelid::regclass::text || ' / ' || t.tgname, ''
  from pg_trigger t where t.tgfoid = o.oid and not t.tgisinternal
  union all
  select 'default', d.adrelid::regclass::text || '.' || a.attname, pg_get_expr(d.adbin, d.adrelid)
  from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  where pg_get_expr(d.adbin, d.adrelid) ~* ('\m' || o.proname || '\s*\(')
  union all
  select 'check', c.conrelid::regclass::text || ' / ' || c.conname, pg_get_constraintdef(c.oid)
  from pg_constraint c
  where c.contype = 'c' and pg_get_constraintdef(c.oid) ~* ('\m' || o.proname || '\s*\(')
  union all
  select 'vista', v.schemaname || '.' || v.viewname, ''
  from pg_views v
  where v.schemaname not in ('pg_catalog', 'information_schema')
    and v.definition ~* ('\m' || o.proname || '\s*\(')
) u on true
order by o.firma, u.tipo, u.donde;


-- ============================================================
-- QUERY 3 -- Permisos efectivos de hoy (después de Tanda C: anon no, authenticated y
-- service_role sí, en las tres).
-- ============================================================
select f as funcion,
       has_function_privilege('anon', f, 'EXECUTE')          as anon,
       has_function_privilege('authenticated', f, 'EXECUTE') as authenticated,
       has_function_privilege('service_role', f, 'EXECUTE')  as service_role
from unnest(array['public.esta_habilitado_para_disciplina(uuid, uuid)',
                  'public.resolver_fecha_plan_actual(uuid)',
                  'public.community_author_names(uuid[])']) f;


-- ============================================================
-- QUERY 4 -- Lo que usa la guarda nueva: auth.uid(), is_admin(), is_active_socio() y las
-- columnas de Comunidad (autores de posts y comentarios, participantes de un DM).
-- Todo tiene que dar true.
-- ============================================================
select to_regprocedure('auth.uid()') is not null                  as hay_auth_uid,
       to_regprocedure('public.is_admin()') is not null           as hay_is_admin,
       to_regprocedure('public.is_active_socio()') is not null    as hay_is_active_socio,
       pg_get_functiondef('public.is_active_socio()'::regprocedure) as is_active_socio,
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'community_posts' and column_name = 'author_id')    as posts_author_id,
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'community_comments' and column_name = 'author_id') as comments_author_id,
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'community_dm_threads' and column_name in ('user_a', 'user_b')) = 2 as dm_user_a_b;


-- ============================================================
-- QUERY 5 -- Tamaño de la Comunidad (para saber a cuántos nombres sigue respondiendo
-- community_author_names) y cuántos socios activos / no activos / admins hay.
-- ============================================================
select (select count(distinct author_id) from community_posts)                       as autores_de_posts,
       (select count(distinct author_id) from community_comments)                    as autores_de_comentarios,
       (select count(*) from community_dm_threads)                                    as dms,
       (select count(*) from profiles where role = 'socio' and active = true)         as socios_activos,
       (select count(*) from profiles where role = 'socio' and active is not true)    as socios_no_activos,
       (select count(*) from profiles where role = 'admin')                           as admins;


-- ============================================================
-- QUERY 6 -- Cuentas para la prueba: la de test (tiene que ser socio activo), el primer admin
-- y si hay algún socio no activo (para el caso "socio no activo no ve nombres").
-- ============================================================
select 'cuenta de test' as que, id, dni, role, active from profiles where dni = '44537978'
union all
(select 'primer admin', id, dni, role, active from profiles where role = 'admin' order by created_at limit 1)
union all
(select 'un socio no activo', id, null, role, active from profiles where role = 'socio' and active is not true order by created_at limit 1);
