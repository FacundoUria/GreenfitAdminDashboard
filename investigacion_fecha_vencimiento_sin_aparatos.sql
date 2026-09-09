-- Investigación (solo lectura, no modifica nada) -- correr en el SQL
-- Editor de Supabase y pasarme el resultado.
--
-- Pregunta: ¿cuántos socios tienen socios.fecha_vencimiento con un valor
-- real, pero NO tienen 'Aparatos' (ni 'Pase Libre', el otro plan por
-- vencimiento) tildado en su plan? Ese es exactamente el caso Agustina
-- Barbero (DNI 43151174, plan=solo CrossFit) -- una fecha que la tabla de
-- Socios muestra hoy sin ninguna etiqueta, pero que no le corresponde a
-- nada real en su plan actual.

-- 1) El número que dimensiona el problema.
select count(*) as socios_con_fecha_vencimiento_stray
from socios
where fecha_vencimiento is not null
  and not exists (
    select 1 from unnest(plan) p where lower(trim(p)) in ('aparatos', 'pase libre')
  );

-- 2) Mismo conteo, pero separando "nunca tuvo Aparatos/Pase Libre" (dato
-- 100% legacy/importado) de "lo tuvo antes y se lo sacaron" -- no hay
-- forma de distinguir eso con las columnas actuales, así que esto es solo
-- el listado para inspección manual.
select dni, nombre, apellido, plan, fecha_vencimiento, dia_corte, activo, estado
from socios
where fecha_vencimiento is not null
  and not exists (
    select 1 from unnest(plan) p where lower(trim(p)) in ('aparatos', 'pase libre')
  )
order by fecha_vencimiento desc
limit 200;

-- 3) Confirmar el caso puntual de Agustina Barbero.
select dni, nombre, apellido, plan, fecha_vencimiento, creditos
from socios
where dni = '43151174';
