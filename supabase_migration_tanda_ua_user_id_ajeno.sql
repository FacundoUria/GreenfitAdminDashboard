-- =====================================================================================
-- TANDA UA -- Tres funciones dejan de aceptar el user_id de cualquiera.
-- Corrida en producción el 20/11/2026 (prueba 15 de 15; Comunidad y ficha del Admin revisadas
-- en pantalla). Diagnóstico de ese día (QUERY 2): esta_habilitado_para_disciplina la llaman
-- acreditar_pack, admin_book_class, admin_otorgar_checkin_aparatos, award_xp_asistencia y
-- book_class, todas SECURITY DEFINER de postgres; a resolver_fecha_plan_actual y a
-- community_author_names no las llama ninguna función; ninguna política usa las tres.
--
-- 1) esta_habilitado_para_disciplina(p_user_id, p_discipline_id)
--    Hoy cualquier socio logueado puede preguntar si OTRO socio tiene el plan vigente. Se le
--    inserta una guarda al principio del cuerpo de PRODUCCIÓN: solo responde si p_user_id es
--    el propio, o si pregunta un admin, o service_role (webhook, Edge Functions), o una
--    conexión directa a la base sin JWT (SQL Editor, cron: las consultas de investigación la
--    usan con ids ajenos). Una conexión directa nunca llega por la API: todo pedido de la API
--    entra como "authenticator", y a ese la excepción no le aplica. Si no, 42501.
--    Las SECURITY DEFINER que la llaman corren con el JWT del que pidió: book_class (su propio
--    id), admin_book_class / check-in / asistencia (admin), acreditación (service_role o el
--    propio socio con auth.uid()). La ficha del Admin la llama directo como admin.
--
-- 2) resolver_fecha_plan_actual(p_user_id)
--    Ningún cliente la llama, y en producción tampoco ninguna función (QUERY 2). Se le saca
--    EXECUTE a authenticated. service_role y el dueño lo conservan; una SECURITY DEFINER de
--    postgres que la llame en el futuro sigue andando (corre como postgres).
--
-- 3) community_author_names(p_ids)
--    Hoy devuelve nombre y foto de CUALQUIER perfil. Ahora solo responde a un socio activo o
--    a un admin, y solo para: el propio id, autores de posts o comentarios de la Comunidad, o
--    quien comparte un DM con quien pregunta. Es todo lo que piden la PWA (posts, comentarios,
--    mensajes de un DM) y el Admin (posts y comentarios). El ranking no la usa (trae sus
--    nombres de community_ranking_xp). A un socio no activo le devuelve 0 filas, sin error:
--    la PWA muestra "Socio GreenFit". Los mensajes de grupos no se cubren: hoy no los usa
--    ninguna pantalla.
--
-- En 1) y 3) el cambio se inserta en la definición de PRODUCCIÓN (no en una copia del repo):
-- el resto del texto queda igual letra por letra (G7). Permisos, dueño y atributos no cambian.
--
-- Guardas (si alguna falla, no se aplica nada):
--   G0) Corre como postgres; las tres huellas están pegadas.
--   G1) esta_habilitado_para_disciplina: huella EXACTA de producción (QUERY 1); el punto de
--       inserción aparece 1 vez; todavía no tiene la guarda.
--   G2) community_author_names: huella EXACTA; el select a reemplazar aparece 1 vez; lenguaje sql.
--   G3) resolver_fecha_plan_actual: permisos EXACTOS de producción (QUERY 1); anon y PUBLIC
--       no; authenticated y service_role sí.
--   G4) resolver_fecha_plan_actual: no aparece en ninguna política, default, CHECK ni vista; y
--       TODA función que la llama es SECURITY DEFINER y de postgres.
--   G5) Existen auth.uid(), is_admin(), is_active_socio() y las columnas de Comunidad.
--   DESPUÉS:
--   G6) resolver_fecha_plan_actual: authenticated no; service_role sí; anon no; el proacl es el
--       de antes menos authenticated.
--   G7) esta_habilitado y community_author_names: cuerpo = el de producción con el cambio,
--       exacto; mismos permisos, dueño, security definer, volatilidad y config.
--   G8) Ninguna OTRA función de la base cambió (cuerpo ni permisos).
--
-- Respaldo: definiciones y permisos de antes y de después en respaldo.tanda_ua_funciones.
-- Prueba:   prueba_tanda_ua.sql (DESPUÉS de esta migración).
-- Rollback: rollback_tanda_ua.sql.
-- =====================================================================================

begin;

create temp table _ua on commit drop as
select 'public.esta_habilitado_para_disciplina(uuid, uuid)'::regprocedure as habilitado,
       'public.resolver_fecha_plan_actual(uuid)'::regprocedure            as resolver,
       'public.community_author_names(uuid[])'::regprocedure              as autores,
       '2de0edc9e2f6e27172f7e957d8cc2751'::text           as huella_habilitado,   -- QUERY 1 (20/11/2026)
       '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::text
                                                           as permisos_resolver,   -- QUERY 1 (20/11/2026)
       'd2efbff4ef13c9a35d66cf64429dd73d'::text           as huella_autores,      -- QUERY 1 (20/11/2026)
       'select kind into v_kind from disciplines where id = p_discipline_id;'::text as ancla_habilitado,
       $bloque$-- NUEVO (Tanda UA): solo la habilitación propia, salvo un admin, service_role (webhook,
  -- Edge Functions) o una conexión directa a la base sin JWT (SQL Editor, cron). Las
  -- SECURITY DEFINER que la llaman corren con el JWT del que pidió.
  if p_user_id is distinct from auth.uid()
     and not public.is_admin()
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role'
     and (session_user = 'authenticator'
          or nullif(current_setting('request.jwt.claims', true), '') is not null) then
    raise exception 'No autorizado: solo se puede consultar la habilitación propia.'
      using errcode = '42501';
  end if;

  $bloque$::text as bloque_habilitado,
       'select id, full_name, avatar_url from profiles where id = any(p_ids);'::text as ancla_autores,
       $cuerpo$select p.id, p.full_name, p.avatar_url
  from profiles p
  where p.id = any(p_ids)
    -- NUEVO (Tanda UA): solo para un socio activo o un admin, y solo el propio nombre, el de
    -- autores de la Comunidad (posts y comentarios) o el de quien comparte un DM con quien pregunta.
    and (public.is_admin() or public.is_active_socio())
    and (
      p.id = auth.uid()
      or exists (select 1 from community_posts x where x.author_id = p.id)
      or exists (select 1 from community_comments x where x.author_id = p.id)
      or exists (select 1 from community_dm_threads t
                 where (t.user_a = auth.uid() and t.user_b = p.id)
                    or (t.user_b = auth.uid() and t.user_a = p.id))
    );$cuerpo$::text as cuerpo_autores;

-- Huella de TODAS las demás funciones (cuerpo y permisos), para la G8.
create function pg_temp.ua_huella_otras() returns text
language sql stable as $f$
  select md5(string_agg(p.oid::text || '=' || coalesce(p.proacl::text, 'NULL') || '=' || md5(coalesce(p.prosrc, '')),
                        ';' order by p.oid))
  from pg_proc p
  where p.oid not in (select habilitado::oid from _ua union all select resolver::oid from _ua
                      union all select autores::oid from _ua)
    and p.pronamespace not in (select n.oid from pg_namespace n where n.nspname like 'pg_temp%')
$f$;

-- ── G0 a G5 ─────────────────────────────────────────────────────────────────────────
do $guarda$
declare
  r record;
  v_src text;
  v_veces int;
  v_mal text;
begin
  select * into r from _ua;

  -- G0
  if current_user <> 'postgres' then
    raise exception 'Tanda UA: hay que correrla como postgres (está corriendo como %). No se aplicó nada.', current_user;
  end if;
  if r.huella_habilitado like 'PEGAR_%' or r.permisos_resolver like 'PEGAR_%' or r.huella_autores like 'PEGAR_%' then
    raise exception 'Tanda UA: faltan pegar las huellas/permisos de la QUERY 1 del diagnóstico. No se aplicó nada.';
  end if;

  -- G1
  if md5(pg_get_functiondef(r.habilitado)) <> r.huella_habilitado then
    raise exception 'Tanda UA: esta_habilitado_para_disciplina no es la versión del diagnóstico (huella %, se esperaba %). No se aplicó nada.',
      md5(pg_get_functiondef(r.habilitado)), r.huella_habilitado;
  end if;
  select prosrc into v_src from pg_proc where oid = r.habilitado;
  v_veces := (length(v_src) - length(replace(v_src, r.ancla_habilitado, ''))) / length(r.ancla_habilitado);
  if v_veces <> 1 then
    raise exception 'Tanda UA: el punto de inserción aparece % vez/veces en esta_habilitado_para_disciplina (se esperaba 1). No se aplicó nada.', v_veces;
  end if;
  if position('Tanda UA' in v_src) > 0 then
    raise exception 'Tanda UA: esta_habilitado_para_disciplina ya tiene la guarda. No se aplicó nada.';
  end if;

  -- G2
  if md5(pg_get_functiondef(r.autores)) <> r.huella_autores then
    raise exception 'Tanda UA: community_author_names no es la versión del diagnóstico (huella %, se esperaba %). No se aplicó nada.',
      md5(pg_get_functiondef(r.autores)), r.huella_autores;
  end if;
  select prosrc into v_src from pg_proc where oid = r.autores;
  v_veces := (length(v_src) - length(replace(v_src, r.ancla_autores, ''))) / length(r.ancla_autores);
  if v_veces <> 1 then
    raise exception 'Tanda UA: el select a reemplazar aparece % vez/veces en community_author_names (se esperaba 1). No se aplicó nada.', v_veces;
  end if;
  if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = r.autores) <> 'sql' then
    raise exception 'Tanda UA: community_author_names no es language sql. No se aplicó nada.';
  end if;

  -- G3
  if (select coalesce(proacl::text, '(por defecto)') from pg_proc where oid = r.resolver) <> r.permisos_resolver then
    raise exception 'Tanda UA: los permisos de resolver_fecha_plan_actual cambiaron desde el diagnóstico (hoy %, se esperaba %). No se aplicó nada.',
      (select coalesce(proacl::text, '(por defecto)') from pg_proc where oid = r.resolver), r.permisos_resolver;
  end if;
  if has_function_privilege('anon', r.resolver, 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = r.resolver and a.grantee = 0 and a.privilege_type = 'EXECUTE')
     or not has_function_privilege('authenticated', r.resolver, 'EXECUTE')
     or not has_function_privilege('service_role', r.resolver, 'EXECUTE') then
    raise exception 'Tanda UA: resolver_fecha_plan_actual no tiene los permisos de Tanda C (anon/PUBLIC no, authenticated y service_role sí). No se aplicó nada.';
  end if;

  -- G4
  select string_agg(x.donde, '; ') into v_mal
  from (
    select 'política ' || pol.schemaname || '.' || pol.tablename || ' / ' || pol.policyname as donde
    from pg_policies pol
    where (coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')) ~* '\mresolver_fecha_plan_actual\s*\('
    union all
    select 'default ' || d.adrelid::regclass::text
    from pg_attrdef d where pg_get_expr(d.adbin, d.adrelid) ~* '\mresolver_fecha_plan_actual\s*\('
    union all
    select 'check ' || c.conname
    from pg_constraint c where c.contype = 'c' and pg_get_constraintdef(c.oid) ~* '\mresolver_fecha_plan_actual\s*\('
    union all
    select 'vista ' || v.schemaname || '.' || v.viewname
    from pg_views v
    where v.schemaname not in ('pg_catalog', 'information_schema') and v.definition ~* '\mresolver_fecha_plan_actual\s*\('
    union all
    select 'función ' || q.oid::regprocedure::text || case when q.prosecdef then '' else ' (INVOKER)' end
           || ' de ' || pg_get_userbyid(q.proowner)
    from pg_proc q
    where q.oid <> r.resolver
      and q.prolang not in (select l.oid from pg_language l where l.lanname in ('c', 'internal'))
      and q.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
      and q.prosrc ~* '\mresolver_fecha_plan_actual\s*\('
      and not (q.prosecdef and pg_get_userbyid(q.proowner) = 'postgres')
  ) x;
  if v_mal is not null then
    raise exception 'Tanda UA: resolver_fecha_plan_actual se usa desde un lugar que necesitaría el EXECUTE de quien llama: %. No se aplicó nada.', v_mal;
  end if;

  -- G5
  if to_regprocedure('auth.uid()') is null or to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.is_active_socio()') is null then
    raise exception 'Tanda UA: falta auth.uid(), is_admin() o is_active_socio(). No se aplicó nada.';
  end if;
  if (select count(*) from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'community_posts' and column_name = 'author_id')
          or (table_name = 'community_comments' and column_name = 'author_id')
          or (table_name = 'community_dm_threads' and column_name in ('user_a', 'user_b')))) <> 4 then
    raise exception 'Tanda UA: faltan columnas de Comunidad (author_id de posts/comentarios, user_a/user_b de DMs). No se aplicó nada.';
  end if;
end;
$guarda$;

-- ── Foto de antes ───────────────────────────────────────────────────────────────────
create temp table _antes on commit drop as
select p.oid                                            as funcion_oid,
       pg_get_functiondef(p.oid)                        as definicion,
       p.prosrc                                         as prosrc,
       coalesce(p.proacl::text, 'NULL')                 as permisos,
       p.proacl                                         as acl,
       p.proowner                                       as duenio,
       p.prosecdef                                      as security_definer,
       p.provolatile                                    as volatilidad,
       coalesce(array_to_string(p.proconfig, ','), '') as config
from pg_proc p
where p.oid in (select habilitado::oid from _ua union all select resolver::oid from _ua
                union all select autores::oid from _ua);

create temp table _huella_otras_antes on commit drop as
select pg_temp.ua_huella_otras() as huella;

-- ── Respaldo ────────────────────────────────────────────────────────────────────────
create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

-- Sin "if not exists": si ya existe, esta tanda ya se corrió y no se aplica nada.
create table respaldo.tanda_ua_funciones (
  funcion           text primary key,
  definicion_antes  text not null,
  huella_antes      text not null,
  permisos_antes    text not null,
  definicion_nueva  text,           -- null para resolver_fecha_plan_actual (solo cambian permisos)
  huella_nueva      text,
  permisos_despues  text,
  guardado_en       timestamptz not null default now()
);
revoke all on respaldo.tanda_ua_funciones from public, anon, authenticated;

-- ── El cambio ───────────────────────────────────────────────────────────────────────
do $aplicar$
declare
  r record;
  a record;
  v_nueva text;
begin
  select * into r from _ua;

  -- 1) esta_habilitado_para_disciplina: la guarda, insertada en la definición de producción.
  select * into a from _antes where funcion_oid = r.habilitado;
  v_nueva := replace(a.definicion, r.ancla_habilitado, r.bloque_habilitado || r.ancla_habilitado);
  insert into respaldo.tanda_ua_funciones (funcion, definicion_antes, huella_antes, permisos_antes, definicion_nueva)
  values ('public.esta_habilitado_para_disciplina(uuid, uuid)', a.definicion, md5(a.definicion), a.permisos, v_nueva);
  execute v_nueva;

  -- 3) community_author_names: el select nuevo, en lugar del de producción.
  select * into a from _antes where funcion_oid = r.autores;
  v_nueva := replace(a.definicion, r.ancla_autores, r.cuerpo_autores);
  insert into respaldo.tanda_ua_funciones (funcion, definicion_antes, huella_antes, permisos_antes, definicion_nueva)
  values ('public.community_author_names(uuid[])', a.definicion, md5(a.definicion), a.permisos, v_nueva);
  execute v_nueva;

  -- 2) resolver_fecha_plan_actual: solo permisos.
  select * into a from _antes where funcion_oid = r.resolver;
  insert into respaldo.tanda_ua_funciones (funcion, definicion_antes, huella_antes, permisos_antes)
  values ('public.resolver_fecha_plan_actual(uuid)', a.definicion, md5(a.definicion), a.permisos);
  revoke execute on function public.resolver_fecha_plan_actual(uuid) from authenticated;

  update respaldo.tanda_ua_funciones f
  set huella_nueva     = md5(pg_get_functiondef(to_regprocedure(f.funcion))),
      permisos_despues = (select coalesce(p.proacl::text, 'NULL') from pg_proc p where p.oid = to_regprocedure(f.funcion));
end;
$aplicar$;

-- ── G6, G7, G8: después ─────────────────────────────────────────────────────────────
do $despues$
declare
  r record;
  a record;
  d record;
  v_mal text;
begin
  select * into r from _ua;

  -- G6
  if has_function_privilege('authenticated', r.resolver, 'EXECUTE')
     or not has_function_privilege('service_role', r.resolver, 'EXECUTE')
     or has_function_privilege('anon', r.resolver, 'EXECUTE') then
    raise exception 'Tanda UA: resolver_fecha_plan_actual no quedó con authenticated no / service_role sí / anon no. Se deshace todo.';
  end if;
  select * into a from _antes where funcion_oid = r.resolver;
  select string_agg(format('%s %s %s', x.cambio, x.grantee, x.privilege_type), '; ') into v_mal
  from (
    (select 'salió' as cambio, e.grantee::regrole::text as grantee, e.privilege_type
     from aclexplode(coalesce(a.acl, acldefault('f', a.duenio))) e where e.grantee <> 0
     except
     select 'salió', e.grantee::regrole::text, e.privilege_type
     from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e where p.oid = r.resolver and e.grantee <> 0)
    union all
    (select 'entró' as cambio, e.grantee::regrole::text, e.privilege_type
     from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e where p.oid = r.resolver and e.grantee <> 0
     except
     select 'entró', e.grantee::regrole::text, e.privilege_type
     from aclexplode(coalesce(a.acl, acldefault('f', a.duenio))) e where e.grantee <> 0)
  ) x
  where not (x.cambio = 'salió' and x.grantee = 'authenticated' and x.privilege_type = 'EXECUTE');
  if v_mal is not null then
    raise exception 'Tanda UA: en resolver_fecha_plan_actual cambió algo más que authenticated: %. Se deshace todo.', v_mal;
  end if;

  -- G7: esta_habilitado_para_disciplina
  select * into a from _antes where funcion_oid = r.habilitado;
  select p.prosrc, coalesce(p.proacl::text, 'NULL') as permisos, p.proowner as duenio, p.prosecdef as security_definer,
         p.provolatile as volatilidad, coalesce(array_to_string(p.proconfig, ','), '') as config
    into d from pg_proc p where p.oid = r.habilitado;
  if d.prosrc <> replace(a.prosrc, r.ancla_habilitado, r.bloque_habilitado || r.ancla_habilitado)
     or d.permisos <> a.permisos or d.duenio <> a.duenio or d.security_definer <> a.security_definer
     or d.volatilidad <> a.volatilidad or d.config <> a.config then
    raise exception 'Tanda UA: esta_habilitado_para_disciplina no quedó como producción + la guarda (o cambiaron sus permisos/atributos). Se deshace todo.';
  end if;

  -- G7: community_author_names
  select * into a from _antes where funcion_oid = r.autores;
  select p.prosrc, coalesce(p.proacl::text, 'NULL') as permisos, p.proowner as duenio, p.prosecdef as security_definer,
         p.provolatile as volatilidad, coalesce(array_to_string(p.proconfig, ','), '') as config
    into d from pg_proc p where p.oid = r.autores;
  if d.prosrc <> replace(a.prosrc, r.ancla_autores, r.cuerpo_autores)
     or d.permisos <> a.permisos or d.duenio <> a.duenio or d.security_definer <> a.security_definer
     or d.volatilidad <> a.volatilidad or d.config <> a.config then
    raise exception 'Tanda UA: community_author_names no quedó como producción con el select nuevo (o cambiaron sus permisos/atributos). Se deshace todo.';
  end if;

  -- G8
  if pg_temp.ua_huella_otras() <> (select huella from _huella_otras_antes) then
    raise exception 'Tanda UA: cambió alguna otra función de la base. Se deshace todo.';
  end if;

  raise notice 'Tanda UA aplicada: esta_habilitado_para_disciplina con guarda, community_author_names acotada, resolver_fecha_plan_actual sin authenticated.';
end;
$despues$;

drop function pg_temp.ua_huella_otras();

commit;
