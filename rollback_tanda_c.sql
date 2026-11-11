-- =====================================================================================
-- ROLLBACK de Tanda C (supabase_migration_tanda_c_cerrar_anon.sql).
-- NO SE CORRIÓ TODAVÍA. ESTAMOS EN PRODUCCIÓN.
--
-- Restaura el proacl EXACTO de cada función que cerró Tanda C, desde
-- respaldo.permisos_funciones (tanda 'C'). Solo toca permisos: ninguna función ni dato.
--
-- Cómo: para cada función, saca EXECUTE a PUBLIC, anon, authenticated y service_role, y
-- vuelve a dar exactamente los permisos que tenía (aclexplode del respaldo: mismo
-- beneficiario, mismo WITH GRANT OPTION). El dueño no se toca. Un proacl que era null
-- (permisos por defecto) se restaura como su equivalente explícito (acldefault).
--
-- Guardas: existe el respaldo de Tanda C; cada función del respaldo existe; DESPUÉS los
-- permisos de cada una son, uno por uno, los del respaldo (se comparan como conjunto de
-- grantor/beneficiario/privilegio/grant option; también se informa si el texto coincide).
-- =====================================================================================

begin;

do $rollback$
declare
  r record;
  g record;
  v_mal text;
  v_texto_distinto int := 0;
begin
  if not exists (select 1 from respaldo.permisos_funciones where tanda = 'C') then
    raise exception 'Rollback Tanda C: no hay respaldo de Tanda C. No se hizo nada.';
  end if;

  select string_agg(firma, ', ') into v_mal
  from (select distinct firma from respaldo.permisos_funciones where tanda = 'C') x
  where to_regprocedure(firma) is null;
  if v_mal is not null then
    raise exception 'Rollback Tanda C: ya no existen: %. No se hizo nada.', v_mal;
  end if;

  for r in
    select distinct on (firma) firma, proacl, to_regprocedure(firma) as oid
    from respaldo.permisos_funciones where tanda = 'C'
    order by firma, id desc
  loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', r.oid::regprocedure);

    for g in
      select a.grantee, a.is_grantable
      from pg_proc p,
           aclexplode(coalesce(r.proacl, acldefault('f', p.proowner))) a
      where p.oid = r.oid and a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner
    loop
      execute format('grant execute on function %s to %s%s',
        r.oid::regprocedure,
        case when g.grantee = 0 then 'public' else quote_ident(g.grantee::regrole::text) end,
        case when g.is_grantable then ' with grant option' else '' end);
    end loop;
  end loop;

  -- Verificación: mismo conjunto de permisos que el respaldo, función por función.
  select string_agg(x.firma, ', ') into v_mal
  from (select distinct on (firma) firma, proacl, to_regprocedure(firma) as oid
        from respaldo.permisos_funciones where tanda = 'C' order by firma, id desc) x
  join pg_proc p on p.oid = x.oid
  where exists (
    (select a.grantor, a.grantee, a.privilege_type, a.is_grantable from aclexplode(coalesce(x.proacl, acldefault('f', p.proowner))) a
     except
     select a.grantor, a.grantee, a.privilege_type, a.is_grantable from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a)
    union all
    (select a.grantor, a.grantee, a.privilege_type, a.is_grantable from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     except
     select a.grantor, a.grantee, a.privilege_type, a.is_grantable from aclexplode(coalesce(x.proacl, acldefault('f', p.proowner))) a)
  );
  if v_mal is not null then
    raise exception 'Rollback Tanda C: estas no quedaron con los permisos del respaldo: %. Se deshace todo.', v_mal;
  end if;

  select count(*) into v_texto_distinto
  from (select distinct on (firma) firma, proacl, to_regprocedure(firma) as oid
        from respaldo.permisos_funciones where tanda = 'C' order by firma, id desc) x
  join pg_proc p on p.oid = x.oid
  where p.proacl::text is distinct from x.proacl::text;

  raise notice 'Rollback Tanda C aplicado: permisos restaurados. % función(es) con los mismos permisos pero en otro orden en el texto del proacl.', v_texto_distinto;
end;
$rollback$;

commit;
