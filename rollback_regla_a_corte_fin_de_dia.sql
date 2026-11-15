-- =====================================================================================
-- ROLLBACK de supabase_migration_regla_a_corte_fin_de_dia.sql. NO SE CORRIÓ.
--
-- Las 6 funciones vuelven EXACTAMENTE a la definición que guardó la migración en
-- respaldo.regla_a_funciones (now() + días: el lote nuevo vence a la hora de la compra).
-- Se borra solo respaldo.regla_a_funciones.
--
-- Solo funciones: ningún UPDATE/DELETE/INSERT sobre datos. Los lotes que se crearon con la
-- versión nueva quedan como están, a las 23:59:59.999999 AR: es el mismo DÍA que hubieran
-- tenido con la versión vieja, así que no chocan con el candado T7 ni cambian lo que se ve.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) ANTES: existe el respaldo con 6 filas y cada función sigue con la huella que dejó la
--      migración (si alguien cambió alguna después, se frena y la nombra).
--   2) DESPUÉS: huella EXACTA de cada una = la de antes de la migración; permisos y atributos
--      iguales.
-- =====================================================================================

begin;

set local lock_timeout = '5s';

do $guarda$
declare
  v_txt text;
begin
  if to_regclass('respaldo.regla_a_funciones') is null then
    raise exception 'Rollback Regla A: no existe respaldo.regla_a_funciones (¿no se aplicó?). No se aplicó nada.';
  end if;
  if (select count(*) from respaldo.regla_a_funciones) <> 6 then
    raise exception 'Rollback Regla A: el respaldo no tiene exactamente 6 filas. No se aplicó nada.';
  end if;
  select string_agg(b.funcion, ', ') into v_txt
  from respaldo.regla_a_funciones b
  where to_regprocedure(b.funcion) is null
     or md5(regexp_replace(pg_get_functiondef(to_regprocedure(b.funcion)), '\s+', '', 'g')) <> b.huella_nueva_sin_espacios;
  if v_txt is not null then
    raise exception 'Rollback Regla A: estas funciones ya no son las que dejó la migración (o no existen): %. No se aplicó nada.', v_txt;
  end if;
end;
$guarda$;

do $restaurar$
declare
  b record;
begin
  for b in select funcion, definicion_antes from respaldo.regla_a_funciones order by funcion loop
    execute b.definicion_antes;
  end loop;
end;
$restaurar$;

do $verifica$
declare
  v_txt text;
begin
  select string_agg(b.funcion, ', ') into v_txt
  from respaldo.regla_a_funciones b
  join pg_proc p on p.oid = to_regprocedure(b.funcion)
  where md5(pg_get_functiondef(p.oid)) <> b.huella_antes
     or coalesce(p.proacl::text, '(por defecto)') <> b.permisos
     or p.prosecdef <> b.security_definer
     or p.provolatile <> b.volatilidad
     or coalesce(array_to_string(p.proconfig, ','), '') <> b.config;
  if v_txt is not null then
    raise exception 'Rollback Regla A: estas funciones no volvieron exactas a la versión de antes (o cambiaron permisos): %. No se aplicó nada.', v_txt;
  end if;

  select string_agg(funcion || ' = ' || huella_antes, ' | ' order by funcion) into v_txt from respaldo.regla_a_funciones;
  raise notice 'Rollback Regla A aplicado. Huellas exactas de antes: %', v_txt;
end;
$verifica$;

drop table respaldo.regla_a_funciones;

commit;
