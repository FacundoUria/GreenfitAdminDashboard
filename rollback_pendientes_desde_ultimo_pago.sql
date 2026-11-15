-- =====================================================================================
-- ROLLBACK de supabase_migration_pendientes_desde_ultimo_pago.sql. NO SE CORRIÓ.
--
-- admin_socios_pendientes_de_cargar() vuelve EXACTAMENTE a la definición que guardó la
-- migración en respaldo.pendientes_up_funciones (la de T5: "nada vigente ahora"). OJO: con
-- esto vuelven los falsos positivos (socios con el plan cargado que vence hoy).
-- Se borra solo respaldo.pendientes_up_funciones; el esquema respaldo y lo demás quedan.
--
-- Solo una función: ningún UPDATE/DELETE/INSERT sobre datos.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) ANTES: existe el respaldo con 1 fila y la función sigue con la huella que dejó la
--      migración (si alguien la cambió después, se frena).
--   2) DESPUÉS: huella EXACTA = la de antes de la migración (y sin espacios = la de T5,
--      9d21d616161c42cb27e711fbe75b2a20); permisos y atributos iguales.
-- =====================================================================================

begin;

set local lock_timeout = '5s';

do $guarda$
declare
  b record;
begin
  if to_regclass('respaldo.pendientes_up_funciones') is null then
    raise exception 'Rollback Pendientes-UP: no existe respaldo.pendientes_up_funciones (¿no se aplicó?). No se aplicó nada.';
  end if;
  if (select count(*) from respaldo.pendientes_up_funciones) <> 1 then
    raise exception 'Rollback Pendientes-UP: el respaldo no tiene exactamente 1 fila. No se aplicó nada.';
  end if;
  select * into b from respaldo.pendientes_up_funciones;
  if to_regprocedure(b.funcion) is null
     or md5(regexp_replace(pg_get_functiondef(to_regprocedure(b.funcion)), '\s+', '', 'g')) <> b.huella_nueva_sin_espacios then
    raise exception 'Rollback Pendientes-UP: la función ya no es la que dejó la migración (o no existe). No se aplicó nada.';
  end if;
end;
$guarda$;

do $restaurar$
begin
  execute (select definicion_antes from respaldo.pendientes_up_funciones);
end;
$restaurar$;

do $verifica$
declare
  b record;
  p record;
begin
  select * into b from respaldo.pendientes_up_funciones;
  select * into p from pg_proc where oid = to_regprocedure(b.funcion);

  if md5(pg_get_functiondef(p.oid)) <> b.huella_antes then
    raise exception 'Rollback Pendientes-UP: la función no volvió exacta a la versión de antes. No se aplicó nada.';
  end if;
  if md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', '', 'g')) <> '9d21d616161c42cb27e711fbe75b2a20' then
    raise exception 'Rollback Pendientes-UP: la función no quedó con la huella de T5. No se aplicó nada.';
  end if;
  if coalesce(p.proacl::text, '(por defecto)') <> b.permisos
     or p.prosecdef <> b.security_definer
     or p.provolatile <> b.volatilidad
     or coalesce(array_to_string(p.proconfig, ','), '') <> b.config then
    raise exception 'Rollback Pendientes-UP: cambiaron permisos o atributos. No se aplicó nada.';
  end if;

  raise notice 'Rollback Pendientes-UP aplicado: admin_socios_pendientes_de_cargar con su huella exacta de antes (%).', b.huella_antes;
end;
$verifica$;

drop table respaldo.pendientes_up_funciones;

commit;
