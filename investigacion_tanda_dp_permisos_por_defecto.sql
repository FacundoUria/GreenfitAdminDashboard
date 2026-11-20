-- =====================================================================================
-- TANDA DP -- DIAGNÓSTICO (SOLO LECTURA). Son SELECT: no modifican nada.
-- Correr DE A UNA (el editor muestra solo la última grilla) y pasarme el resultado.
--
-- Para qué: saber de dónde sale que toda función nueva de public nazca con EXECUTE para
-- PUBLIC y anon (así se deshace Tanda C cada vez que una migración crea o recrea una), y
-- qué se puede cambiar desde el SQL Editor:
--   * PUBLIC: Postgres le da EXECUTE a PUBLIC a toda función nueva (default GLOBAL, no
--     depende del esquema). Solo aparece en pg_default_acl si alguien ya lo cambió.
--   * anon / authenticated / service_role: los agrega Supabase con una fila de
--     pg_default_acl para el esquema public.
--   * Cada fila es "para los objetos que crea el rol X": las de postgres aplican a lo que se
--     crea desde el SQL Editor; las de supabase_admin, a lo que crea la plataforma.
-- =====================================================================================


-- ============================================================
-- QUERY 1 -- Con qué rol corre el editor y si puede tocar los defaults de supabase_admin
-- (para eso tendría que ser superusuario o miembro de supabase_admin).
-- ============================================================
select current_user                                                     as corro_como,
       r.rolsuper                                                       as soy_superusuario,
       exists (select 1 from pg_roles where rolname = 'supabase_admin') as existe_supabase_admin,
       case when exists (select 1 from pg_roles where rolname = 'supabase_admin')
            then pg_has_role(current_user, 'supabase_admin', 'MEMBER') end as soy_miembro_de_supabase_admin
from pg_roles r
where r.rolname = current_user;


-- ============================================================
-- QUERY 2 -- Todos los permisos por defecto de hoy, uno por fila.
--   rol_que_crea: los defaults aplican a los objetos que crea ese rol.
--   esquema '(global)': aplica en todos los esquemas.
-- ============================================================
select d.defaclrole::regrole::text                                      as rol_que_crea,
       coalesce(n.nspname, '(global)')                                  as esquema,
       case d.defaclobjtype when 'r' then 'tablas'    when 'S' then 'secuencias'
                            when 'f' then 'funciones' when 'T' then 'tipos'
                            when 'n' then 'esquemas'  else d.defaclobjtype::text end as tipo_de_objeto,
       case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as recibe,
       string_agg(a.privilege_type || case when a.is_grantable then ' (con grant)' else '' end,
                  ', ' order by a.privilege_type)                       as privilegios
from pg_default_acl d
left join pg_namespace n on n.oid = d.defaclnamespace
cross join lateral aclexplode(d.defaclacl) a
group by 1, 2, 3, 4
order by 1, 2, 3, 4;


-- ============================================================
-- QUERY 3 -- La HUELLA de pg_default_acl (todas las filas). Va en la guarda G1 de la
-- migración: si cambia una sola fila antes de correrla, la migración no aplica.
-- ============================================================
select count(*) as filas,
       coalesce(md5(string_agg(
         d.defaclrole::regrole::text || '|' || coalesce(n.nspname, '(global)') || '|'
           || d.defaclobjtype::text || '|' || coalesce(d.defaclacl::text, 'NULL'),
         ';' order by d.defaclrole::regrole::text, coalesce(n.nspname, '(global)'), d.defaclobjtype::text)),
       'SIN FILAS') as huella_default_acl
from pg_default_acl d
left join pg_namespace n on n.oid = d.defaclnamespace;


-- ============================================================
-- QUERY 4 -- Quiénes reciben EXECUTE HOY en una función NUEVA de public, según quién la crea.
-- Combina la fila global (si no hay: el default de Postgres, PUBLIC y el dueño) con la fila
-- de public, igual que hace Postgres al crearla.
-- ============================================================
select c.rolname as la_crea,
       case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as recibe_execute
from pg_roles c
cross join lateral (
  select coalesce((select d.defaclacl from pg_default_acl d
                   where d.defaclrole = c.oid and d.defaclnamespace = 0 and d.defaclobjtype = 'f'),
                  acldefault('f', c.oid)) as acl
  union all
  select d.defaclacl from pg_default_acl d
  where d.defaclrole = c.oid and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'f'
) x
cross join lateral aclexplode(x.acl) a
where c.rolname in ('postgres', 'supabase_admin') and a.privilege_type = 'EXECUTE'
group by 1, 2
order by 1, 2;


-- ============================================================
-- QUERY 5 -- Dueños de las funciones de public (si todas son de postgres, los defaults de
-- supabase_admin no nos afectan).
-- ============================================================
select pg_get_userbyid(p.proowner)           as duenio,
       count(*)                              as funciones,
       count(*) filter (where p.prosecdef)   as security_definer
from pg_proc p
where p.pronamespace = 'public'::regnamespace
group by 1
order by 2 desc;


-- ============================================================
-- QUERY 6 -- Funciones de public abiertas HOY a PUBLIC o anon. Después de Tanda C tendrían
-- que ser solo is_admin(), is_active_socio() y handle_new_user(). Cualquier otra se creó o
-- se recreó después del 10/11 y nació abierta.
-- ============================================================
select p.oid::regprocedure::text   as firma,
       pg_get_userbyid(p.proowner) as duenio,
       coalesce(p.proacl::text, '(por defecto: ' || acldefault('f', p.proowner)::text || ')') as proacl
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.prokind = 'f'
  and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where a.privilege_type = 'EXECUTE' and (a.grantee = 0 or a.grantee = 'anon'::regrole))
order by 1;


-- ============================================================
-- QUERY 7 -- Cuenta de test para la prueba (DNI 44537978): su user id.
-- ============================================================
select id, dni, role from profiles where dni = '44537978';
