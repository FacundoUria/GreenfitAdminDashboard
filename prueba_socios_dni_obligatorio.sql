-- =====================================================================================
-- PRUEBA del trigger socios_validar_dni (supabase_migration_socios_dni_obligatorio.sql)
--
-- CÓMO CORRERLO
--   * Pegar TODO el archivo en el SQL Editor y ejecutar UNA vez. El resultado es la ÚLTIMA
--     grilla (una línea OK/FALLA por chequeo y un resumen al final).
--
-- NO DEJA NADA EN LA BASE
--   * Cada escritura de prueba (insert/update sobre `socios`) corre dentro de una
--     subtransacción que se DESHACE SIEMPRE (rollback), haya pasado o haya sido rechazada.
--   * Lo único que sobrevive hasta el final es el log, que es una tabla TEMPORAL de la sesión.
--     (Un `rollback` de toda la transacción borraría también el log, y el editor no mostraría
--     el resultado -- por eso el rollback es por caso y no al final.)
--   * Como todo se deshace, tampoco se llega a crear ninguna cuenta de la app: el pedido que
--     encola el trigger on_socio_dni_upsert se deshace junto con el insert.
--   * El último chequeo confirma que `socios` quedó exactamente igual que antes.
--
-- CASOS
--   1  Alta sin DNI (null)                         -> rechazada
--   2  Alta con DNI vacío / "." / con puntos / con letras / 5 dígitos / 11 dígitos -> rechazadas
--   3  Alta con DNI válido (6, 8 y 10 dígitos)     -> pasa
--   4  Editar un socio histórico SIN DNI válido sin tocarle el DNI (null y no-null) -> pasa
--   5  Cargarle un DNI válido a un socio histórico sin DNI -> pasa
--   6  Cambiarle el DNI a un socio histórico por otro inválido -> rechazado
--   7  Borrarle / romperle el DNI a un socio que lo tiene bien -> rechazado
--   8  Editar un socio con DNI válido sin tocarle el DNI, y corregirle el DNI por otro válido -> pasa
--   9  Re-importar un socio existente sin DNI (insert ... on conflict, como importar_socios.js) -> rechazado
-- =====================================================================================
begin;

drop table if exists pg_temp._log;
create temp table _log (n bigserial primary key, caso text, linea text);

-- DNIs y emails de prueba: no pueden existir ya en la base.
do $$
begin
  if to_regprocedure('public.validar_dni_socio()') is null
     or not exists (select 1 from pg_trigger where tgname = 'socios_validar_dni' and not tgisinternal) then
    raise exception 'Falta correr supabase_migration_socios_dni_obligatorio.sql';
  end if;
  if exists (select 1 from socios where dni in ('999901', '99999902', '9999999903', '99999904', '99999905')) then
    raise exception 'Alguno de los DNI de prueba (999901, 99999902, 9999999903, 99999904, 99999905) ya existe en socios';
  end if;
  if exists (select 1 from socios where email like 'prueba-trigger-dni-%@greenfit.test') then
    raise exception 'Ya hay socios con email prueba-trigger-dni-*@greenfit.test';
  end if;
end $$;

create temp table _antes as
select count(*) as total, coalesce(md5(string_agg(md5(s::text), '' order by s.id::text)), '') as huella from socios s;

-- Corre p_sql dentro de una subtransacción que SIEMPRE se deshace y anota si pasó o si lo
-- rechazó el trigger. Cualquier otro error (ej. otra constraint de la tabla) es FALLA.
create function pg_temp.probar(p_caso text, p_descripcion text, p_sql text, p_debe_rechazar boolean)
returns void language plpgsql as $$
declare
  v_filas int; v_resultado text; v_constraint text; v_mensaje text; v_ok boolean;
begin
  begin
    execute p_sql;
    get diagnostics v_filas = row_count;
    raise exception 'DESHACER:%', v_filas using errcode = 'P0999';
  exception
    when sqlstate 'P0999' then
      v_filas := split_part(sqlerrm, ':', 2)::int;
      v_resultado := 'paso';
    when others then
      get stacked diagnostics v_constraint = constraint_name, v_mensaje = message_text;
      v_resultado := case when v_constraint = 'socios_dni_valido' then 'rechazado' else 'otro_error' end;
  end;

  if v_resultado = 'paso' and v_filas = 0 then
    insert into _log(caso, linea) values (p_caso, 'SALTEADO  ' || p_descripcion || ' -- no hay ningún socio así en la base, no se pudo probar');
    return;
  end if;

  v_ok := (p_debe_rechazar and v_resultado = 'rechazado') or (not p_debe_rechazar and v_resultado = 'paso');
  insert into _log(caso, linea) values (
    p_caso,
    case when v_ok then 'OK        ' else 'FALLA     ' end || p_descripcion || ' -> '
      || case v_resultado
           when 'paso' then 'pasó'
           when 'rechazado' then 'rechazado por el trigger'
           else 'ERROR INESPERADO: ' || v_mensaje
         end
      || case when v_ok then '' else case when p_debe_rechazar then ' (se esperaba: rechazado)' else ' (se esperaba: pasa)' end end
  );
end $$;

-- ── 1 y 2: altas inválidas ──
select pg_temp.probar('1', 'alta sin DNI (null)',
  $q$ insert into socios (nombre, apellido, email, estado) values ('Prueba', 'Trigger', 'prueba-trigger-dni-1@greenfit.test', 'Activo') $q$, true);
select pg_temp.probar('2', 'alta con DNI vacío ""',
  $q$ insert into socios (nombre, apellido, dni, email, estado) values ('Prueba', 'Trigger', '', 'prueba-trigger-dni-2@greenfit.test', 'Activo') $q$, true);
select pg_temp.probar('2', 'alta con DNI "."',
  $q$ insert into socios (nombre, apellido, dni, email, estado) values ('Prueba', 'Trigger', '.', 'prueba-trigger-dni-2@greenfit.test', 'Activo') $q$, true);
select pg_temp.probar('2', 'alta con DNI con puntos "99.999.902"',
  $q$ insert into socios (nombre, apellido, dni, email, estado) values ('Prueba', 'Trigger', '99.999.902', 'prueba-trigger-dni-2@greenfit.test', 'Activo') $q$, true);
select pg_temp.probar('2', 'alta con DNI con letras "9999990A"',
  $q$ insert into socios (nombre, apellido, dni, email, estado) values ('Prueba', 'Trigger', '9999990A', 'prueba-trigger-dni-2@greenfit.test', 'Activo') $q$, true);
select pg_temp.probar('2', 'alta con DNI con espacio " 99999902"',
  $q$ insert into socios (nombre, apellido, dni, email, estado) values ('Prueba', 'Trigger', ' 99999902', 'prueba-trigger-dni-2@greenfit.test', 'Activo') $q$, true);
select pg_temp.probar('2', 'alta con DNI de 5 dígitos',
  $q$ insert into socios (nombre, apellido, dni, email, estado) values ('Prueba', 'Trigger', '99999', 'prueba-trigger-dni-2@greenfit.test', 'Activo') $q$, true);
select pg_temp.probar('2', 'alta con DNI de 11 dígitos',
  $q$ insert into socios (nombre, apellido, dni, email, estado) values ('Prueba', 'Trigger', '99999999999', 'prueba-trigger-dni-2@greenfit.test', 'Activo') $q$, true);

-- ── 3: altas válidas ──
select pg_temp.probar('3', 'alta con DNI válido de 6 dígitos',
  $q$ insert into socios (nombre, apellido, dni, email, estado) values ('Prueba', 'Trigger', '999901', 'prueba-trigger-dni-3@greenfit.test', 'Activo') $q$, false);
select pg_temp.probar('3', 'alta con DNI válido de 8 dígitos',
  $q$ insert into socios (nombre, apellido, dni, email, estado) values ('Prueba', 'Trigger', '99999902', 'prueba-trigger-dni-3@greenfit.test', 'Activo') $q$, false);
select pg_temp.probar('3', 'alta con DNI válido de 10 dígitos',
  $q$ insert into socios (nombre, apellido, dni, email, estado) values ('Prueba', 'Trigger', '9999999903', 'prueba-trigger-dni-3@greenfit.test', 'Activo') $q$, false);

-- ── 4, 5 y 6: socios históricos sin DNI válido (filas reales, se deshace) ──
select pg_temp.probar('4', 'editar el teléfono de un socio histórico con DNI null',
  $q$ update socios set telefono = coalesce(telefono, '') || '0' where id = (select id from socios where dni is null order by id limit 1) $q$, false);
select pg_temp.probar('4', 'editar un socio histórico con DNI inválido (ej. ".") reenviando el mismo DNI',
  $q$ update socios set telefono = coalesce(telefono, '') || '0', dni = dni where id = (select id from socios where dni is not null and dni !~ '^\d{6,10}$' order by id limit 1) $q$, false);
select pg_temp.probar('5', 'cargarle un DNI válido a un socio histórico con DNI null',
  $q$ update socios set dni = '99999904' where id = (select id from socios where dni is null order by id limit 1) $q$, false);
select pg_temp.probar('5', 'cargarle un DNI válido a un socio histórico con DNI inválido',
  $q$ update socios set dni = '99999905' where id = (select id from socios where dni is not null and dni !~ '^\d{6,10}$' order by id limit 1) $q$, false);
select pg_temp.probar('6', 'cambiarle el DNI null a un socio histórico por "."',
  $q$ update socios set dni = '.' where id = (select id from socios where dni is null order by id limit 1) $q$, true);
select pg_temp.probar('6', 'cambiarle el DNI inválido a un socio histórico por null',
  $q$ update socios set dni = null where id = (select id from socios where dni is not null and dni !~ '^\d{6,10}$' order by id limit 1) $q$, true);

-- ── 7 y 8: socios con DNI válido ──
select pg_temp.probar('7', 'borrarle el DNI (null) a un socio que lo tiene bien',
  $q$ update socios set dni = null where id = (select id from socios where dni ~ '^\d{6,10}$' order by id limit 1) $q$, true);
select pg_temp.probar('7', 'cambiarle el DNI por uno con puntos a un socio que lo tiene bien',
  $q$ update socios set dni = '99.999.904' where id = (select id from socios where dni ~ '^\d{6,10}$' order by id limit 1) $q$, true);
select pg_temp.probar('8', 'editar el teléfono de un socio con DNI válido',
  $q$ update socios set telefono = coalesce(telefono, '') || '0' where id = (select id from socios where dni ~ '^\d{6,10}$' order by id limit 1) $q$, false);
select pg_temp.probar('8', 'corregirle el DNI por otro válido a un socio con DNI válido',
  $q$ update socios set dni = '99999904' where id = (select id from socios where dni ~ '^\d{6,10}$' order by id limit 1) $q$, false);

-- ── 9: re-importar sin DNI un socio que ya existe (lo que hacía importar_socios.js) ──
-- "on conflict do nothing" SIN columna a propósito: no depende de que exista ninguna constraint
-- única en particular (producción no tiene unique sobre email). El trigger valida ANTES de que
-- Postgres resuelva el conflicto, así que la fila se rechaza igual.
select pg_temp.probar('9', 're-importar (insert ... on conflict) sin DNI un socio existente',
  $q$ insert into socios (nombre, apellido, dni, email, estado)
      select s.nombre, s.apellido, null, s.email, s.estado
      from socios s where s.dni is null and s.email is not null and trim(s.email) <> '' order by s.id limit 1
      on conflict do nothing $q$, true);

-- ── FINAL: socios quedó exactamente igual ──
insert into _log(caso, linea)
select 'FINAL',
  case when d.total = a.total and d.huella = a.huella
    then format('OK        la tabla socios quedó idéntica a como estaba (%s filas, mismo contenido)', d.total)
    else format('FALLA     la tabla socios CAMBIÓ: antes %s filas, ahora %s (avisar antes de seguir)', a.total, d.total)
  end
from _antes a,
  (select count(*) as total, coalesce(md5(string_agg(md5(s::text), '' order by s.id::text)), '') as huella from socios s) d;

insert into _log(caso, linea)
select 'RESUMEN', format('%s OK, %s FALLA, %s SALTEADO',
  count(*) filter (where linea like 'OK%'), count(*) filter (where linea like 'FALLA%'), count(*) filter (where linea like 'SALTEADO%'))
from _log;

commit;

select caso, linea from pg_temp._log order by n;
