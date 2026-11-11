-- =====================================================================================
-- ROLLBACK de DNI-C (supabase_migration_dni_bloquear_cambio_con_cuenta.sql).
-- Se corrió una vez en producción el 10/11/2026, por error; DNI-C se volvió a aplicar el mismo
-- día. Sigue sirviendo: respaldo.funciones guarda la última copia antes de cada aplicación, y
-- la versión vigente de DNI-C se aplicó sobre la versión original (huella 79a0cb…).
--
-- Restaura validar_dni_socio() EXACTAMENTE como estaba antes de DNI-C, desde el respaldo
-- (respaldo.funciones, tanda 'DNI-C'): sin SECURITY DEFINER y sin el bloqueo por cuenta.
-- El trigger socios_validar_dni no se toca (DNI-C no lo tocó). No toca datos.
--
-- Ojo: después de volver atrás, cambiar el DNI de un socio con cuenta vuelve a dejar su cuenta
-- huérfana y a crear otra (el problema de siempre).
--
-- Guardas: existe el respaldo; la función actual es la de DNI-C; DESPUÉS la huella es
-- 79a0cb0ff4c758de7c0c3aff8ef03359 (la de producción antes de DNI-C), no es SECURITY DEFINER
-- y los permisos quedan iguales.
-- =====================================================================================

begin;

do $rollback$
declare
  v_def text;
  v_acl text;
  v_huella text;
begin
  select definicion into v_def
  from respaldo.funciones
  where tanda = 'DNI-C' and funcion = 'public.validar_dni_socio()'
  order by id desc limit 1;

  if v_def is null then
    raise exception 'Rollback DNI-C: no hay respaldo de DNI-C. No se hizo nada.';
  end if;

  if position('socios_dni_con_cuenta' in pg_get_functiondef('public.validar_dni_socio()'::regprocedure)) = 0 then
    raise exception 'Rollback DNI-C: la función actual no es la de DNI-C. No se hizo nada.';
  end if;

  select coalesce(proacl::text, '(por defecto)') into v_acl
  from pg_proc where oid = 'public.validar_dni_socio()'::regprocedure;

  -- create or replace sin "security definer" la deja SECURITY INVOKER otra vez.
  execute v_def;

  v_huella := md5(regexp_replace(pg_get_functiondef('public.validar_dni_socio()'::regprocedure), '\s+', '', 'g'));
  if v_huella <> '79a0cb0ff4c758de7c0c3aff8ef03359' then
    raise exception 'Rollback DNI-C: la función restaurada tiene huella % (se esperaba 79a0cb0ff4c758de7c0c3aff8ef03359). Se deshace todo.', v_huella;
  end if;
  if (select prosecdef from pg_proc where oid = 'public.validar_dni_socio()'::regprocedure) then
    raise exception 'Rollback DNI-C: la función sigue siendo SECURITY DEFINER. Se deshace todo.';
  end if;
  if (select coalesce(proacl::text, '(por defecto)') from pg_proc where oid = 'public.validar_dni_socio()'::regprocedure) <> v_acl then
    raise exception 'Rollback DNI-C: cambiaron los permisos. Se deshace todo.';
  end if;

  raise notice 'Rollback DNI-C aplicado: validar_dni_socio() volvió a la versión de producción anterior.';
end;
$rollback$;

commit;
