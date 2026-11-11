-- =====================================================================================
-- TANDA C -- Las funciones de public dejan de poder ejecutarse sin login (PUBLIC y anon).
-- Corrida en producción el 10/11/2026 (prueba 47 de 47; quedan abiertas a anon is_admin,
-- is_active_socio y handle_new_user).
--
-- Hoy 36 funciones de public tienen EXECUTE para PUBLIC y anon: cualquiera con la clave
-- pública (la que está en el HTML de la landing) las puede llamar por /rest/v1/rpc sin
-- iniciar sesión. Nadie las necesita sin login:
--   * la landing (greenfit-site/index.html) no llama ninguna RPC: solo lee configuracion,
--     disciplines y classes con select;
--   * la PWA no tiene pantallas sin login que usen la base (Login usa la API de Auth);
--   * el Admin y la PWA llaman todo con sesión (authenticated); las Edge Functions con
--     service_role.
-- Para cada una: revoke execute ... from public, anon; grant execute ... to authenticated,
-- service_role. El dueño (postgres) no cambia.
--
-- SE QUEDAN COMO ESTÁN (lista explícita, v_quedan):
--   * is_admin() e is_active_socio(): las usan políticas RLS sin "to authenticated". Confirmado
--     en producción (diagnóstico del 10/11/2026, QUERY 4 y 5): las 3 tablas que lee la landing
--     como anon tienen una política FOR ALL roles={public} con is_admin()
--     (configuracion_admin_write, disciplines_admin_write, classes_admin_write), que también se
--     evalúa en el SELECT de anon; sin EXECUTE, la landing fallaría con "permission denied for
--     function is_admin". is_active_socio() solo está en políticas de INSERT {public} (comunidad,
--     consentimientos, metas, storage), ninguna en tablas de la landing: se queda por la regla
--     acordada (las dos van juntas).
--   Ninguna otra de las 36 aparece en una política, default, CHECK o vista (QUERY 3); las que
--   llaman otras funciones lo hacen siempre desde funciones SECURITY DEFINER.
--   * las funciones de trigger de tablas de auth.* (handle_new_user): las dispara
--     supabase_auth_admin al crear una cuenta. Una función de trigger no se puede llamar por
--     RPC, así que cerrarla no gana nada, y tocarla arriesga el alta de cuentas.
-- Las demás funciones de trigger (tablas de public) SÍ se cierran: las disparan authenticated,
-- service_role o postgres, que conservan EXECUTE.
--
-- Guardas (si alguna falla, no se aplica nada):
--   G1) La lista de funciones con EXECUTE para PUBLIC/anon es EXACTAMENTE la del diagnóstico:
--       misma cantidad y misma huella (firma=proacl de todas, QUERY 2 de
--       investigacion_tanda_c_permisos_funciones.sql). Pegarlas abajo.
--   G2) Las de v_quedan existen y están en esa lista.
--   G3) Ninguna de las que se cierran aparece en una política que aplique a anon (roles
--       {public} o {anon}), en ningún esquema. Si aparece, no se cierra nada: hay que pasarla
--       a v_quedan o cambiar la política.
--   G4) DESPUÉS: las cerradas no tienen EXECUTE para PUBLIC ni anon y sí para authenticated
--       y service_role; las de v_quedan quedaron con el proacl EXACTO de antes; las únicas
--       funciones de public que siguen abiertas a PUBLIC/anon son las de v_quedan.
--
-- Respaldo: el proacl de cada función que se cierra, en respaldo.permisos_funciones
-- (tanda 'C'). El rollback lo restaura exacto.
-- Prueba:   prueba_tanda_c.sql (DESPUÉS de esta migración: todo OK).
-- Rollback: rollback_tanda_c.sql.
-- =====================================================================================

begin;

-- Las que se quedan abiertas (por nombre: se comparan contra pg_proc.proname).
create temp table _quedan on commit drop as
select unnest(array['is_admin', 'is_active_socio']) as proname;

-- Las candidatas: todo lo de public con EXECUTE para PUBLIC o anon, HOY.
create temp table _abiertas on commit drop as
select p.oid, p.proname, p.oid::regprocedure::text as firma, p.proacl,
       p.prorettype = 'trigger'::regtype as es_de_trigger,
       exists (select 1 from pg_trigger t
               where t.tgfoid = p.oid and not t.tgisinternal
                 and t.tgrelid::regclass::text like 'auth.%') as trigger_de_auth
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.prokind = 'f'
  and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where a.privilege_type = 'EXECUTE' and (a.grantee = 0 or a.grantee = 'anon'::regrole));

-- Las que se cierran.
create temp table _cerrar on commit drop as
select a.* from _abiertas a
where a.proname not in (select proname from _quedan)
  and not a.trigger_de_auth;

do $guarda$
declare
  v_cantidad_esperada int := 36;                                       -- QUERY 2 (10/11/2026)
  v_huella_esperada text := '424ec4ff7231b217ea06ace5050a7619';        -- QUERY 2 (10/11/2026)
  v_cantidad int;
  v_huella text;
  v_falta text;
  v_choque text;
begin
  if v_huella_esperada like 'PEGAR_%' or v_cantidad_esperada < 0 then
    raise exception 'Tanda C: falta pegar la cantidad y la huella de la QUERY 2 del diagnóstico. No se aplicó nada.';
  end if;

  -- G1
  select count(*), md5(string_agg(firma || '=' || coalesce(proacl::text, 'NULL'), ';' order by firma))
    into v_cantidad, v_huella
  from _abiertas;
  if v_cantidad <> v_cantidad_esperada or v_huella <> v_huella_esperada then
    raise exception 'Tanda C: la lista de funciones abiertas cambió desde el diagnóstico (% funciones, huella %; se esperaban % y %). No se aplicó nada.',
      v_cantidad, v_huella, v_cantidad_esperada, v_huella_esperada;
  end if;

  -- G2
  select string_agg(q.proname, ', ') into v_falta
  from _quedan q where not exists (select 1 from _abiertas a where a.proname = q.proname);
  if v_falta is not null then
    raise exception 'Tanda C: % no está(n) en la lista de abiertas. No se aplicó nada.', v_falta;
  end if;

  -- G3
  select string_agg(distinct c.firma || ' (política ' || pol.schemaname || '.' || pol.tablename || ' / ' || pol.policyname || ')', '; ')
    into v_choque
  from _cerrar c
  join pg_policies pol
    on (coalesce(pol.qual, '') ~* ('\m' || c.proname || '\(') or coalesce(pol.with_check, '') ~* ('\m' || c.proname || '\('))
   and pol.roles && array['public', 'anon']::name[];
  if v_choque is not null then
    raise exception 'Tanda C: estas funciones las usa una política que aplica a anon: %. No se aplicó nada.', v_choque;
  end if;

  raise notice 'Tanda C: se cierran % funciones; quedan abiertas %.',
    (select count(*) from _cerrar), (select string_agg(firma, ', ' order by firma) from _abiertas where oid not in (select oid from _cerrar));
end;
$guarda$;

-- ── Respaldo del proacl exacto ──────────────────────────────────────────────────────
create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

create table if not exists respaldo.permisos_funciones (
  id bigserial primary key,
  tanda text not null,
  firma text not null,
  proacl aclitem[],            -- null = permisos por defecto
  guardado_en timestamptz not null default now()
);

insert into respaldo.permisos_funciones (tanda, firma, proacl)
select 'C', firma, proacl from _cerrar;

-- Para la G4: el proacl de las que se quedan, para confirmar que no cambió.
create temp table _quedan_antes on commit drop as
select oid, proacl from _abiertas where oid not in (select oid from _cerrar);

-- ── Cerrar ──────────────────────────────────────────────────────────────────────────
do $cerrar$
declare
  r record;
begin
  for r in select firma from _cerrar order by firma loop
    execute format('revoke execute on function %s from public, anon', r.firma);
    execute format('grant execute on function %s to authenticated, service_role', r.firma);
  end loop;
end;
$cerrar$;

-- ── G4: después ─────────────────────────────────────────────────────────────────────
do $despues$
declare
  v_mal text;
begin
  select string_agg(c.firma, ', ') into v_mal
  from _cerrar c
  where has_function_privilege('anon', c.oid, 'EXECUTE')
     or exists (select 1 from aclexplode((select proacl from pg_proc where oid = c.oid)) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE')
     or not has_function_privilege('authenticated', c.oid, 'EXECUTE')
     or not has_function_privilege('service_role', c.oid, 'EXECUTE');
  if v_mal is not null then
    raise exception 'Tanda C: estas no quedaron cerradas a anon/PUBLIC y abiertas a authenticated/service_role: %. Se deshace todo.', v_mal;
  end if;

  select string_agg(q.oid::regprocedure::text, ', ') into v_mal
  from _quedan_antes q join pg_proc p on p.oid = q.oid
  where p.proacl is distinct from q.proacl;
  if v_mal is not null then
    raise exception 'Tanda C: cambió el proacl de una que se tenía que quedar igual: %. Se deshace todo.', v_mal;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_mal
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
    and p.oid not in (select oid from _quedan_antes)
    and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.privilege_type = 'EXECUTE' and (a.grantee = 0 or a.grantee = 'anon'::regrole));
  if v_mal is not null then
    raise exception 'Tanda C: siguen abiertas a PUBLIC/anon funciones que no están en la lista de las que se quedan: %. Se deshace todo.', v_mal;
  end if;

  raise notice 'Tanda C aplicada: % funciones cerradas a PUBLIC y anon.', (select count(*) from _cerrar);
end;
$despues$;

commit;
