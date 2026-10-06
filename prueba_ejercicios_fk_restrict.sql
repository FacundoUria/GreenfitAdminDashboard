-- =====================================================================================
-- PRUEBA de supabase_migration_ejercicios_fk_restrict.sql (1a).
-- Cuenta de prueba (socio): Facundo Uria, DNI 44537978.
--
-- CÓMO CORRERLO
--   * Pegar TODO el archivo en el SQL Editor y ejecutar UNA vez. El resultado es la ÚLTIMA
--     grilla (una línea OK/FALLA por chequeo y un resumen al final).
--
-- NO DEJA NADA EN LA BASE
--   * Cada caso crea lo que necesita (un ejercicio temporal "ZZ PRUEBA ...", una plantilla
--     temporal sin socio, un tilde o un peso de la cuenta de prueba) adentro de una
--     subtransacción que se DESHACE SIEMPRE, y recién ahí prueba.
--   * Nunca se borra ni se toca un ejercicio, una rutina o un peso real.
--   * El chequeo FINAL confirma que quedó todo igual: exercises, routines, routine_days y
--     routine_exercises completas, y routine_completions / user_exercise_weights SOLO de la
--     cuenta de prueba (los socios reales pueden marcar o cargar pesos mientras corre esto, y
--     eso no es un cambio del script).
--
-- CASOS
--   1  Las dos FKs hacia exercises son ON DELETE RESTRICT (y conservaron el nombre)
--   2  Borrar un ejercicio que está en una rutina                     -> falla con 23503
--   3  Borrar un ejercicio que solo tiene pesos de un socio           -> falla con 23503
--   4  Borrar un ejercicio sin uso                                    -> se borra
--   5  Borrar una RUTINA sigue cascadeando a días, ejercicios de la rutina y tildes
--      (y el ejercicio del catálogo queda)
--   6  Borrar un DÍA sigue cascadeando a sus ejercicios de la rutina
--   7  Lo que hace saveRoutineFull (borrar los días y volver a insertarlos con el mismo
--      ejercicio) sigue funcionando
--   8  (datos reales, solo lectura) cuántos ejercicios quedaron protegidos
-- =====================================================================================
begin;

drop table if exists pg_temp._log;
drop table if exists pg_temp._ctx;
drop table if exists pg_temp._antes;
create temp table _log (n bigserial primary key, caso text, linea text);

create temp table _ctx as
select (select id from profiles where dni = '44537978') as u;

do $$
begin
  if (select u from pg_temp._ctx) is null then
    raise exception 'No existe el perfil con DNI 44537978';
  end if;
  if exists (
    select 1 from pg_constraint
    where contype = 'f' and confrelid = 'public.exercises'::regclass and confdeltype <> 'r'
  ) then
    raise exception 'Falta correr supabase_migration_ejercicios_fk_restrict.sql (hay FKs hacia exercises que no son RESTRICT)';
  end if;
  if exists (select 1 from exercises where name like 'ZZ PRUEBA FK%') then
    raise exception 'Ya hay ejercicios llamados "ZZ PRUEBA FK..." en el catálogo';
  end if;
end $$;

-- Huella de lo que el script podría tocar: el catálogo y las rutinas completas (los socios no
-- los escriben), y los tildes y pesos SOLO de la cuenta de prueba (los de los socios reales
-- pueden cambiar mientras corre esto sin que sea culpa del script).
create or replace function pg_temp.huella() returns text language sql as $f$
  select md5(
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from exercises t) ||
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from routines t) ||
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from routine_days t) ||
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from routine_exercises t) ||
    (select coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '') from routine_completions t
       where t.user_id = (select u from pg_temp._ctx)) ||
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from user_exercise_weights t
       where t.user_id = (select u from pg_temp._ctx))
  );
$f$;

create temp table _antes as select pg_temp.huella() as huella;

create or replace function pg_temp.ok(p_caso text, p_ok boolean, p_texto text) returns void language sql as $f$
  insert into pg_temp._log(caso, linea)
  values (p_caso, case when coalesce(p_ok, false) then 'OK        ' else 'FALLA     ' end || p_texto);
$f$;

-- Arma una plantilla temporal (sin socio) con 1 día y 1 ejercicio de la rutina, apuntando a
-- p_ex. Devuelve el id de la rutina. Solo se usa adentro de subtransacciones que se deshacen.
create or replace function pg_temp.rutina_temporal(p_ex uuid, out rutina uuid, out dia uuid, out fila uuid)
language plpgsql as $f$
begin
  insert into routines (title, is_template, user_id) values ('ZZ PRUEBA FK rutina (temporal)', true, null)
    returning id into rutina;
  insert into routine_days (routine_id, title, order_index) values (rutina, 'Día 1', 0)
    returning id into dia;
  insert into routine_exercises (day_id, exercise_id, sets, reps, order_index) values (dia, p_ex, 3, '10', 0)
    returning id into fila;
end;
$f$;

-- ── 1: definición de las FKs ──
insert into _log(caso, linea)
select '1',
  case when con.confdeltype = 'r' then 'OK        ' else 'FALLA     ' end
  || format('%s.%s (%s) -> ON DELETE %s', con.conrelid::regclass, att.attname, con.conname,
       case con.confdeltype when 'r' then 'RESTRICT' when 'c' then 'CASCADE' when 'a' then 'NO ACTION'
                            when 'n' then 'SET NULL' else con.confdeltype::text end)
from pg_constraint con
join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
where con.contype = 'f' and con.confrelid = 'public.exercises'::regclass
order by 1, 2;

select pg_temp.ok('1',
  (select count(*) from pg_constraint where contype = 'f' and confrelid = 'public.exercises'::regclass) = 2,
  'hay exactamente 2 FKs hacia exercises (routine_exercises y user_exercise_weights)');

-- ── 2: ejercicio en una rutina ──
do $$
declare v_ex uuid; v_codigo text; v_existe boolean; v_ok boolean; v_texto text;
begin
  begin
    insert into exercises (name, muscle_group) values ('ZZ PRUEBA FK en rutina', 'Otros') returning id into v_ex;
    perform pg_temp.rutina_temporal(v_ex);
    begin
      delete from exercises where id = v_ex;
      v_codigo := 'sin error';
    exception when others then
      v_codigo := sqlstate;
    end;
    select exists (select 1 from exercises where id = v_ex) into v_existe;
    v_ok := v_codigo = '23503' and v_existe;
    v_texto := format('borrar un ejercicio que está en una rutina -> %s (esperado: 23503) y el ejercicio sigue', v_codigo);
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_ok := false; v_texto := 'ERROR INESPERADO: ' || sqlerrm;
  end;
  -- Se registra DESPUÉS de deshacer: adentro de la subtransacción se perdería con ella.
  perform pg_temp.ok('2', v_ok, v_texto);
end $$;

-- ── 3: ejercicio con un peso de un socio (sin estar en ninguna rutina) ──
do $$
declare v_ex uuid; v_codigo text; v_pesos int; v_ok boolean; v_texto text;
begin
  begin
    insert into exercises (name, muscle_group) values ('ZZ PRUEBA FK con peso', 'Otros') returning id into v_ex;
    insert into user_exercise_weights (user_id, exercise_id, weight_used) values ((select u from pg_temp._ctx), v_ex, '10kg');
    begin
      delete from exercises where id = v_ex;
      v_codigo := 'sin error';
    exception when others then
      v_codigo := sqlstate;
    end;
    select count(*) into v_pesos from user_exercise_weights where exercise_id = v_ex;
    v_ok := v_codigo = '23503' and v_pesos = 1;
    v_texto := format('borrar un ejercicio con pesos de un socio -> %s (esperado: 23503) y el peso sigue (%s)', v_codigo, v_pesos);
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_ok := false; v_texto := 'ERROR INESPERADO: ' || sqlerrm;
  end;
  -- Se registra DESPUÉS de deshacer: adentro de la subtransacción se perdería con ella.
  perform pg_temp.ok('3', v_ok, v_texto);
end $$;

-- ── 4: ejercicio sin uso ──
do $$
declare v_ex uuid; v_existe boolean; v_ok boolean; v_texto text;
begin
  begin
    insert into exercises (name, muscle_group) values ('ZZ PRUEBA FK sin uso', 'Otros') returning id into v_ex;
    delete from exercises where id = v_ex;
    select exists (select 1 from exercises where id = v_ex) into v_existe;
    v_ok := not v_existe;
    v_texto := 'borrar un ejercicio sin uso -> se borra';
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_ok := false; v_texto := 'ERROR INESPERADO: ' || sqlerrm;
  end;
  -- Se registra DESPUÉS de deshacer: adentro de la subtransacción se perdería con ella.
  perform pg_temp.ok('4', v_ok, v_texto);
end $$;

-- ── 5: borrar una RUTINA sigue cascadeando ──
do $$
declare v_ex uuid; t record; v_dias int; v_filas int; v_tildes int; v_ex_existe boolean; v_ok boolean; v_texto text;
begin
  begin
    insert into exercises (name, muscle_group) values ('ZZ PRUEBA FK rutina borrada', 'Otros') returning id into v_ex;
    t := pg_temp.rutina_temporal(v_ex);
    insert into routine_completions (user_id, routine_exercise_id, completed_date)
      values ((select u from pg_temp._ctx), t.fila, current_date);
    delete from routines where id = t.rutina;
    select count(*) into v_dias from routine_days where id = t.dia;
    select count(*) into v_filas from routine_exercises where id = t.fila;
    select count(*) into v_tildes from routine_completions where routine_exercise_id = t.fila;
    select exists (select 1 from exercises where id = v_ex) into v_ex_existe;
    v_ok := v_dias = 0 and v_filas = 0 and v_tildes = 0 and v_ex_existe;
    v_texto := format('borrar una rutina -> días %s, ejercicios de la rutina %s, tildes %s (esperado 0/0/0); el ejercicio del catálogo sigue: %s',
        v_dias, v_filas, v_tildes, v_ex_existe);
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_ok := false; v_texto := 'ERROR INESPERADO: ' || sqlerrm;
  end;
  -- Se registra DESPUÉS de deshacer: adentro de la subtransacción se perdería con ella.
  perform pg_temp.ok('5', v_ok, v_texto);
end $$;

-- ── 6: borrar un DÍA sigue cascadeando ──
do $$
declare v_ex uuid; t record; v_filas int; v_ok boolean; v_texto text;
begin
  begin
    insert into exercises (name, muscle_group) values ('ZZ PRUEBA FK día borrado', 'Otros') returning id into v_ex;
    t := pg_temp.rutina_temporal(v_ex);
    delete from routine_days where id = t.dia;
    select count(*) into v_filas from routine_exercises where id = t.fila;
    v_ok := v_filas = 0;
    v_texto := format('borrar un día -> ejercicios de ese día: %s (esperado 0)', v_filas);
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_ok := false; v_texto := 'ERROR INESPERADO: ' || sqlerrm;
  end;
  -- Se registra DESPUÉS de deshacer: adentro de la subtransacción se perdería con ella.
  perform pg_temp.ok('6', v_ok, v_texto);
end $$;

-- ── 7: lo que hace saveRoutineFull (re-guardar) ──
do $$
declare v_ex uuid; t record; v_dia_nuevo uuid; v_filas int; v_ok boolean; v_texto text;
begin
  begin
    insert into exercises (name, muscle_group) values ('ZZ PRUEBA FK re-guardar', 'Otros') returning id into v_ex;
    t := pg_temp.rutina_temporal(v_ex);
    -- saveRoutineFull: borra TODOS los días de la rutina y los vuelve a insertar.
    delete from routine_days where routine_id = t.rutina;
    insert into routine_days (routine_id, title, order_index) values (t.rutina, 'Día 1', 0) returning id into v_dia_nuevo;
    insert into routine_exercises (day_id, exercise_id, sets, reps, order_index) values (v_dia_nuevo, v_ex, 4, '8', 0);
    select count(*) into v_filas from routine_exercises where day_id = v_dia_nuevo and exercise_id = v_ex;
    v_ok := v_filas = 1;
    v_texto := 're-guardar una rutina (borrar días y reinsertar con el mismo ejercicio) funciona';
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_ok := false; v_texto := 'ERROR INESPERADO: ' || sqlerrm;
  end;
  -- Se registra DESPUÉS de deshacer: adentro de la subtransacción se perdería con ella.
  perform pg_temp.ok('7', v_ok, v_texto);
end $$;

-- ── 8: datos reales (solo lectura) ──
insert into _log(caso, linea)
select '8', format('NOTA      %s ejercicios en el catálogo: %s protegidos (en alguna rutina o con pesos), %s se pueden borrar',
  count(*),
  count(*) filter (where en_uso),
  count(*) filter (where not en_uso))
from (
  select e.id,
    exists (select 1 from routine_exercises re where re.exercise_id = e.id)
    or exists (select 1 from user_exercise_weights w where w.exercise_id = e.id) as en_uso
  from exercises e
) x;

-- ── FINAL ──
select pg_temp.ok('FINAL', (select huella from _antes) = pg_temp.huella(),
  'exercises, routines, routine_days y routine_exercises idénticas; tildes y pesos de la cuenta de prueba idénticos');

insert into _log(caso, linea)
select 'RESUMEN', format('%s OK, %s FALLA',
  count(*) filter (where linea like 'OK%'), count(*) filter (where linea like 'FALLA%'))
from _log;

commit;

select caso, linea from pg_temp._log order by n;
