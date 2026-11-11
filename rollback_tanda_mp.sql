-- =====================================================================================
-- ROLLBACK de supabase_migration_tanda_mp_on_conflict.sql. NO SE CORRIÓ.
--
-- mp_process_payment vuelve EXACTAMENTE a la definición que guardó la migración en
-- respaldo.tanda_mp_funciones (la de Tanda B, con el on conflict viejo). OJO: con esto
-- mp_process_payment vuelve a fallar SIEMPRE (el bug del índice parcial).
-- Se borra solo respaldo.tanda_mp_funciones; el respaldo de Tanda B queda.
--
-- Solo una función: ningún UPDATE/DELETE/INSERT sobre datos. Los pagos que se hayan
-- grabado con la versión nueva quedan como están.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) ANTES: existe el respaldo con 1 fila y mp_process_payment sigue con la huella de
--      Tanda MP (si alguien la cambió después, se frena).
--   2) DESPUÉS: huella EXACTA = la de antes de Tanda MP (y, si sigue el respaldo de Tanda B,
--      sin espacios = la de Tanda B); permisos y atributos iguales.
-- =====================================================================================

begin;

set local lock_timeout = '5s';

do $guarda$
declare
  b record;
begin
  if to_regclass('respaldo.tanda_mp_funciones') is null then
    raise exception 'Rollback Tanda MP: no existe respaldo.tanda_mp_funciones (¿Tanda MP no se aplicó?). No se aplicó nada.';
  end if;
  if (select count(*) from respaldo.tanda_mp_funciones) <> 1 then
    raise exception 'Rollback Tanda MP: el respaldo no tiene exactamente 1 fila. No se aplicó nada.';
  end if;
  select * into b from respaldo.tanda_mp_funciones;
  if to_regprocedure(b.funcion) is null
     or md5(regexp_replace(pg_get_functiondef(to_regprocedure(b.funcion)), '\s+', '', 'g')) <> b.huella_nueva_sin_espacios then
    raise exception 'Rollback Tanda MP: mp_process_payment ya no es la versión de Tanda MP (o no existe). No se aplicó nada.';
  end if;
end;
$guarda$;

do $restaurar$
begin
  execute (select definicion_antes from respaldo.tanda_mp_funciones);
end;
$restaurar$;

do $verifica$
declare
  b record;
  p record;
begin
  select * into b from respaldo.tanda_mp_funciones;
  select * into p from pg_proc where oid = to_regprocedure(b.funcion);

  if md5(pg_get_functiondef(p.oid)) <> b.huella_antes then
    raise exception 'Rollback Tanda MP: mp_process_payment no volvió exacta a la versión de antes. No se aplicó nada.';
  end if;
  if to_regclass('respaldo.tanda_b_funciones') is not null
     and md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', '', 'g'))
         is distinct from (select huella_nueva_sin_espacios from respaldo.tanda_b_funciones
                           where to_regprocedure(funcion) = p.oid) then
    raise exception 'Rollback Tanda MP: mp_process_payment no quedó con la huella de Tanda B. No se aplicó nada.';
  end if;
  if coalesce(p.proacl::text, '(por defecto)') <> b.permisos
     or p.prosecdef <> b.security_definer
     or p.provolatile <> b.volatilidad
     or coalesce(array_to_string(p.proconfig, ','), '') <> b.config then
    raise exception 'Rollback Tanda MP: cambiaron permisos o atributos. No se aplicó nada.';
  end if;

  raise notice 'Rollback Tanda MP aplicado: mp_process_payment con su huella exacta de antes (%).', b.huella_antes;
end;
$verifica$;

drop table respaldo.tanda_mp_funciones;

commit;
