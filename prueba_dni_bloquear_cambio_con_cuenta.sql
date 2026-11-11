-- =====================================================================================
-- PRUEBA de DNI-C (supabase_migration_dni_bloquear_cambio_con_cuenta.sql). Correr DESPUÉS.
-- Después correr también prueba_socios_dni_obligatorio.sql (los 9 casos de siempre).
--
-- NO DEJA NADA EN LA BASE: cada escritura corre en una subtransacción que se deshace SIEMPRE,
-- pase o la rechacen. Tampoco se crea ninguna cuenta: el pedido que encola on_socio_dni_upsert
-- (caso 1) se deshace junto con el update. El último chequeo confirma que socios quedó idéntica.
--
-- CASOS
--   1  Florencia (socio 473, sin cuenta): cargarle un DNI válido                 -> pasa
--   2  Florencia: cobrarle (forma de Socios.jsx handleConfirmarPago, sin dni)    -> pasa
--   3  Cuenta de test 44537978 (con cuenta): cambiarle el DNI a otro válido      -> RECHAZADO,
--      con el mensaje exacto 'Este socio ya tiene cuenta en la app. Para corregir el DNI avisale a Facundo.'
--   4  44537978: borrarle el DNI (null)                                         -> RECHAZADO (con cuenta)
--   5  44537978: editar el teléfono sin tocar el DNI, y reenviando el mismo DNI -> pasan
--   6  Socio con DNI válido SIN cuenta: corregirle el DNI por otro válido       -> pasa (como hoy)
--   7  Alta nueva con DNI válido                                                -> pasa (como hoy)
-- =====================================================================================
begin;

drop table if exists pg_temp._log;
create temp table _log (n bigserial primary key, caso text, linea text);

do $$
begin
  if position('socios_dni_con_cuenta' in pg_get_functiondef('public.validar_dni_socio()'::regprocedure)) = 0 then
    raise exception 'Falta correr supabase_migration_dni_bloquear_cambio_con_cuenta.sql';
  end if;
  if not exists (select 1 from socios where id = 473) then
    raise exception 'No existe el socio 473 (Florencia)';
  end if;
  if exists (select 1 from socios s join profiles p on p.dni = s.dni where s.id = 473) then
    raise exception 'El socio 473 (Florencia) ya tiene cuenta: el caso 1 no probaría lo que tiene que probar';
  end if;
  if not exists (select 1 from socios where dni = '44537978') then
    raise exception 'No hay ningún socio con DNI 44537978 (cuenta de test)';
  end if;
  if not exists (select 1 from profiles where dni = '44537978') then
    raise exception 'El DNI 44537978 no tiene cuenta en profiles: el caso 3 no probaría lo que tiene que probar';
  end if;
  if exists (select 1 from socios where dni in ('99999951', '99999952', '99999953', '99999954'))
     or exists (select 1 from profiles where dni in ('99999951', '99999952', '99999953', '99999954')) then
    raise exception 'Algún DNI de prueba (99999951..99999954) ya existe en socios o profiles';
  end if;
  if exists (select 1 from socios where email = 'prueba-dni-c@greenfit.test') then
    raise exception 'Ya hay un socio con email prueba-dni-c@greenfit.test';
  end if;
end $$;

create temp table _antes as
select count(*) as total, coalesce(md5(string_agg(md5(s::text), '' order by s.id::text)), '') as huella from socios s;

-- p_esperado: 'pasa' | 'socios_dni_con_cuenta' | 'socios_dni_valido'
-- p_mensaje: si no es null, el mensaje del error tiene que ser EXACTAMENTE ese.
create function pg_temp.probar(p_caso text, p_descripcion text, p_sql text, p_esperado text, p_mensaje text default null)
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
      v_resultado := 'pasa';
    when others then
      get stacked diagnostics v_constraint = constraint_name, v_mensaje = message_text;
      v_resultado := coalesce(nullif(v_constraint, ''), 'otro_error');
  end;

  if v_resultado = 'pasa' and v_filas = 0 then
    insert into _log(caso, linea) values (p_caso, 'SALTEADO  ' || p_descripcion || ' -- 0 filas, no se pudo probar');
    return;
  end if;

  v_ok := v_resultado = p_esperado and (p_mensaje is null or v_mensaje = p_mensaje);
  insert into _log(caso, linea) values (p_caso,
    case when v_ok then 'OK        ' else 'FALLA     ' end || p_descripcion || ' -> '
      || case when v_resultado = 'pasa' then format('pasó (%s filas)', v_filas)
              else format('rechazado [%s]: %s', v_resultado, v_mensaje) end
      || case when v_ok then '' else format(' (se esperaba: %s%s)', p_esperado, coalesce(' con "' || p_mensaje || '"', '')) end);
end $$;

-- 1 y 2: Florencia, sin cuenta
select pg_temp.probar('1', 'Florencia (473, sin cuenta): cargarle el DNI 99999951',
  $q$ update socios set dni = '99999951' where id = 473 $q$, 'pasa');
select pg_temp.probar('2', 'Florencia (473): cobrarle sin tocar el DNI',
  $q$ update socios set ultimo_pago = current_date, fecha_vencimiento = current_date + 30,
        dia_corte = extract(day from current_date + 30)::int, estado = 'Activo'
      where id = 473 $q$, 'pasa');

-- 3, 4 y 5: cuenta de test 44537978, con cuenta
select pg_temp.probar('3', '44537978 (con cuenta): cambiarle el DNI a 99999952',
  $q$ update socios set dni = '99999952' where dni = '44537978' $q$,
  'socios_dni_con_cuenta', 'Este socio ya tiene cuenta en la app. Para corregir el DNI avisale a Facundo.');
select pg_temp.probar('4', '44537978 (con cuenta): borrarle el DNI',
  $q$ update socios set dni = null where dni = '44537978' $q$,
  'socios_dni_con_cuenta', 'Este socio ya tiene cuenta en la app. Para corregir el DNI avisale a Facundo.');
select pg_temp.probar('5', '44537978: editar el teléfono sin tocar el DNI',
  $q$ update socios set telefono = coalesce(telefono, '') || '0' where dni = '44537978' $q$, 'pasa');
select pg_temp.probar('5', '44537978: editar reenviando el mismo DNI',
  $q$ update socios set nombre = nombre, dni = dni where dni = '44537978' $q$, 'pasa');

-- 6: DNI válido SIN cuenta -> como hoy
select pg_temp.probar('6', 'socio con DNI válido sin cuenta: corregirle el DNI a 99999953',
  $q$ update socios set dni = '99999953'
      where id = (select s.id from socios s
                  where s.dni ~ '^\d{6,10}$' and not exists (select 1 from profiles p where p.dni = s.dni)
                  order by s.id limit 1) $q$, 'pasa');

-- 7: alta
select pg_temp.probar('7', 'alta nueva con DNI válido',
  $q$ insert into socios (nombre, apellido, dni, email, estado)
      values ('Prueba', 'DNI-C', '99999954', 'prueba-dni-c@greenfit.test', 'Activo') $q$, 'pasa');

-- FINAL
insert into _log(caso, linea)
select 'FINAL',
  case when d.total = a.total and d.huella = a.huella
    then format('OK        socios quedó idéntica (%s filas)', d.total)
    else format('FALLA     socios CAMBIÓ: antes %s filas, ahora %s (avisar antes de seguir)', a.total, d.total) end
from _antes a,
  (select count(*) as total, coalesce(md5(string_agg(md5(s::text), '' order by s.id::text)), '') as huella from socios s) d;

insert into _log(caso, linea)
select 'RESUMEN', format('%s OK, %s FALLA, %s SALTEADO',
  count(*) filter (where linea like 'OK%'), count(*) filter (where linea like 'FALLA%'), count(*) filter (where linea like 'SALTEADO%'))
from _log;

commit;

select caso, linea from pg_temp._log order by n;
