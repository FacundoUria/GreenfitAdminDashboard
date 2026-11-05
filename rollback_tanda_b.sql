-- =====================================================================================
-- ROLLBACK de supabase_migration_tanda_b_hoy_argentina.sql. NO SE CORRIÓ.
--
-- 1) Las 4 funciones vuelven EXACTAMENTE a la definición de producción que guardó la
--    migración en respaldo.tanda_b_funciones (texto byte a byte, no una copia del repo).
-- 2) Los 4 defaults vuelven a CURRENT_DATE.
-- 3) Se borra el esquema respaldo (lo creó Tanda B; no guarda datos de socios).
--
-- Solo funciones y defaults: ningún UPDATE/DELETE/INSERT sobre datos de socios. Las filas
-- que se guardaron con el día de Argentina mientras Tanda B estuvo puesta quedan como están.
-- Sin guarda de horario: volver a UTC se puede a cualquier hora (es el comportamiento viejo).
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) ANTES: existe el respaldo con las 4 funciones y los 4 defaults; cada función sigue
--      con su huella de Tanda B (si alguien la cambió después, se frena: no se pisa un
--      cambio que no conocemos); cada default sigue siendo el que puso Tanda B.
--   2) DESPUÉS: huella EXACTA de cada función = la de producción antes de Tanda B; permisos,
--      security definer, volatilidad y config iguales; los 4 defaults = CURRENT_DATE.
-- =====================================================================================

begin;

set local lock_timeout = '5s';

-- ── Guarda 1 ──────────────────────────────────────────────────────────────────────────
do $guarda$
declare
  v_txt text;
begin
  if to_regclass('respaldo.tanda_b_funciones') is null or to_regclass('respaldo.tanda_b_defaults') is null then
    raise exception 'Rollback Tanda B: no existe el respaldo (¿Tanda B no se aplicó?). No se aplicó nada.';
  end if;
  if (select count(*) from respaldo.tanda_b_funciones) <> 4 or (select count(*) from respaldo.tanda_b_defaults) <> 4 then
    raise exception 'Rollback Tanda B: el respaldo no tiene 4 funciones y 4 defaults. No se aplicó nada.';
  end if;

  select string_agg(b.funcion, ', ') into v_txt
  from respaldo.tanda_b_funciones b
  where to_regprocedure(b.funcion) is null
     or md5(regexp_replace(pg_get_functiondef(to_regprocedure(b.funcion)), '\s+', '', 'g')) <> b.huella_nueva_sin_espacios;
  if v_txt is not null then
    raise exception 'Rollback Tanda B: estas funciones ya no son la versión de Tanda B (o no existen): %. No se aplicó nada.', v_txt;
  end if;

  select string_agg(b.tabla || '.' || b.columna, ', ') into v_txt
  from respaldo.tanda_b_defaults b
  left join pg_attribute a on a.attrelid = to_regclass('public.' || b.tabla) and a.attname = b.columna and not a.attisdropped
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where d.adbin is null or pg_get_expr(d.adbin, d.adrelid) is distinct from b.default_nuevo;
  if v_txt is not null then
    raise exception 'Rollback Tanda B: estos defaults ya no son los de Tanda B: %. No se aplicó nada.', v_txt;
  end if;
end;
$guarda$;

-- ── 1) Funciones: definición original de producción ──────────────────────────────────
do $restaurar$
declare
  r record;
begin
  for r in select funcion, definicion_antes from respaldo.tanda_b_funciones order by funcion loop
    execute r.definicion_antes;
  end loop;
end;
$restaurar$;

-- ── 2) Defaults ───────────────────────────────────────────────────────────────────────
alter table public.asistencias alter column fecha       set default current_date;
alter table public.pagos_socio alter column fecha       set default current_date;
alter table public.socios      alter column ultimo_pago set default current_date;
alter table public.xp_events   alter column event_date  set default current_date;

-- ── Guarda 2: verificación DESPUÉS ────────────────────────────────────────────────────
do $verifica$
declare
  v_txt text;
begin
  select string_agg(b.funcion, ', ') into v_txt
  from respaldo.tanda_b_funciones b
  join pg_proc p on p.oid = b.funcion::regprocedure
  where md5(pg_get_functiondef(p.oid)) <> b.huella_antes
     or coalesce(p.proacl::text, '(por defecto)') <> b.permisos
     or p.prosecdef <> b.security_definer
     or p.provolatile <> b.volatilidad
     or coalesce(array_to_string(p.proconfig, ','), '') <> b.config;
  if v_txt is not null then
    raise exception 'Rollback Tanda B: estas funciones no volvieron exactas a producción (huella, permisos o atributos): %. No se aplicó nada.', v_txt;
  end if;

  select string_agg(b.tabla || '.' || b.columna, ', ') into v_txt
  from respaldo.tanda_b_defaults b
  left join pg_attribute a on a.attrelid = to_regclass('public.' || b.tabla) and a.attname = b.columna and not a.attisdropped
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where d.adbin is null or pg_get_expr(d.adbin, d.adrelid) <> b.default_antes;
  if v_txt is not null then
    raise exception 'Rollback Tanda B: estos defaults no volvieron a CURRENT_DATE: %. No se aplicó nada.', v_txt;
  end if;

  raise notice 'Rollback Tanda B aplicado: 4 funciones con su huella exacta de antes y 4 defaults en CURRENT_DATE.';
end;
$verifica$;

-- ── 3) El respaldo ya no hace falta ───────────────────────────────────────────────────
drop schema respaldo cascade;

commit;
