-- =====================================================================================
-- ROLLBACK de Tanda UA (supabase_migration_tanda_ua_user_id_ajeno.sql).
-- NO SE CORRIÓ TODAVÍA. ESTAMOS EN PRODUCCIÓN. Solo si la prueba falla.
--
-- Vuelve las tres funciones a como estaban, desde respaldo.tanda_ua_funciones:
--   * esta_habilitado_para_disciplina y community_author_names: ejecuta la definición de
--     antes, tal cual (create or replace conserva dueño y permisos).
--   * resolver_fecha_plan_actual: le devuelve EXECUTE a authenticated.
-- Ningún dato se modifica (el respaldo queda guardado).
--
-- Guardas (si alguna falla, no se hace nada):
--   G1) Existe el respaldo con las tres funciones.
--   G2) Hoy las tres son las que dejó la migración (huella_nueva y permisos_despues). Si
--       alguien las cambió después, no se pisa nada.
--   DESPUÉS:
--   G3) Las dos con cuerpo vuelven a su huella de antes (si solo difieren en espacios, se
--       acepta y se avisa) y a sus permisos de antes.
--   G4) resolver_fecha_plan_actual tiene los mismos permisos que antes (mismo conjunto).
--   G5) Ninguna otra función de la base cambió.
-- =====================================================================================

begin;

create temp table _otras_antes on commit drop as
select md5(string_agg(p.oid::text || '=' || coalesce(p.proacl::text, 'NULL') || '=' || md5(coalesce(p.prosrc, '')),
                      ';' order by p.oid)) as huella
from pg_proc p
where p.oid not in ('public.esta_habilitado_para_disciplina(uuid, uuid)'::regprocedure::oid,
                    'public.resolver_fecha_plan_actual(uuid)'::regprocedure::oid,
                    'public.community_author_names(uuid[])'::regprocedure::oid)
  and p.pronamespace not in (select n.oid from pg_namespace n where n.nspname like 'pg_temp%');

do $rollback$
declare
  v record;
  v_def text;
  v_mal text;
begin
  -- G1
  if to_regclass('respaldo.tanda_ua_funciones') is null then
    raise exception 'Rollback Tanda UA: no existe respaldo.tanda_ua_funciones. No se hizo nada.';
  end if;
  if (select count(*) from respaldo.tanda_ua_funciones) <> 3 then
    raise exception 'Rollback Tanda UA: el respaldo no tiene las 3 funciones. No se hizo nada.';
  end if;

  -- G2
  select string_agg(f.funcion, ', ') into v_mal
  from respaldo.tanda_ua_funciones f
  join pg_proc p on p.oid = to_regprocedure(f.funcion)
  where md5(pg_get_functiondef(p.oid)) is distinct from f.huella_nueva
     or coalesce(p.proacl::text, 'NULL') is distinct from f.permisos_despues;
  if v_mal is not null then
    raise exception 'Rollback Tanda UA: estas no son la versión que dejó la migración: %. No se hizo nada.', v_mal;
  end if;

  -- Volver.
  for v in select * from respaldo.tanda_ua_funciones where definicion_nueva is not null loop
    execute v.definicion_antes;
  end loop;
  grant execute on function public.resolver_fecha_plan_actual(uuid) to authenticated;

  -- G3
  for v in select * from respaldo.tanda_ua_funciones where definicion_nueva is not null loop
    v_def := pg_get_functiondef(to_regprocedure(v.funcion));
    if md5(v_def) <> v.huella_antes then
      if md5(regexp_replace(v_def, '\s+', '', 'g')) <> md5(regexp_replace(v.definicion_antes, '\s+', '', 'g')) then
        raise exception 'Rollback Tanda UA: % no volvió a la definición de antes. Se deshace todo.', v.funcion;
      end if;
      raise notice 'Rollback Tanda UA: % volvió a la definición de antes (difiere solo en espacios).', v.funcion;
    end if;
    if (select coalesce(p.proacl::text, 'NULL') from pg_proc p where p.oid = to_regprocedure(v.funcion)) <> v.permisos_antes then
      raise exception 'Rollback Tanda UA: los permisos de % no son los de antes. Se deshace todo.', v.funcion;
    end if;
  end loop;

  -- G4: mismo conjunto de permisos que antes (el orden del texto puede cambiar).
  select * into v from respaldo.tanda_ua_funciones where funcion = 'public.resolver_fecha_plan_actual(uuid)';
  if exists (
    (select a.grantee, a.privilege_type, a.is_grantable
     from aclexplode(case when v.permisos_antes = 'NULL' then acldefault('f', 'postgres'::regrole)
                          else v.permisos_antes::aclitem[] end) a
     except
     select a.grantee, a.privilege_type, a.is_grantable
     from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = 'public.resolver_fecha_plan_actual(uuid)'::regprocedure)
    union all
    (select a.grantee, a.privilege_type, a.is_grantable
     from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = 'public.resolver_fecha_plan_actual(uuid)'::regprocedure
     except
     select a.grantee, a.privilege_type, a.is_grantable
     from aclexplode(case when v.permisos_antes = 'NULL' then acldefault('f', 'postgres'::regrole)
                          else v.permisos_antes::aclitem[] end) a)
  ) then
    raise exception 'Rollback Tanda UA: resolver_fecha_plan_actual no quedó con los permisos de antes. Se deshace todo.';
  end if;

  -- G5
  if (select md5(string_agg(p.oid::text || '=' || coalesce(p.proacl::text, 'NULL') || '=' || md5(coalesce(p.prosrc, '')),
                            ';' order by p.oid))
      from pg_proc p
      where p.oid not in ('public.esta_habilitado_para_disciplina(uuid, uuid)'::regprocedure::oid,
                          'public.resolver_fecha_plan_actual(uuid)'::regprocedure::oid,
                          'public.community_author_names(uuid[])'::regprocedure::oid)
        and p.pronamespace not in (select n.oid from pg_namespace n where n.nspname like 'pg_temp%'))
     <> (select huella from _otras_antes) then
    raise exception 'Rollback Tanda UA: cambió alguna otra función de la base. Se deshace todo.';
  end if;

  raise notice 'Rollback Tanda UA aplicado: las tres funciones volvieron a como estaban.';
end;
$rollback$;

commit;
