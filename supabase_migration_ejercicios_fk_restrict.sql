-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- 1a -- Que no se pueda borrar un ejercicio en uso.
--
-- BUG: borrar un ejercicio de la Biblioteca del Admin cascadeaba en silencio:
--   exercises -> routine_exercises (ON DELETE CASCADE): desaparecía de TODAS las
--                rutinas de TODOS los socios (y de ahí, sus tildes del día);
--   exercises -> user_exercise_weights (ON DELETE CASCADE): se borraban los pesos
--                que cargó cada socio.
--
-- FIX: las dos FKs pasan a ON DELETE RESTRICT. Borrar un ejercicio que está en
-- alguna rutina, o que tiene pesos de algún socio, falla con 23503. Uno sin uso
-- se sigue borrando igual que antes.
--
-- NO cambia (son otras FKs, que siguen en CASCADE):
--   routines -> routine_days -> routine_exercises -> routine_completions: borrar
--   una rutina o un día (deleteRoutine, y saveRoutineFull, que borra los días y
--   los vuelve a insertar) sigue funcionando igual. RESTRICT solo frena borrar la
--   fila PADRE (el ejercicio); borrar filas de routine_exercises o de
--   user_exercise_weights no se ve afectado.
--   user_exercise_weights.user_id -> profiles: borrar un socio sigue borrando sus pesos.
--
-- Mismos nombres de constraint: se buscan en el catálogo (no se asumen) y se
-- recrean con el mismo nombre. Todo en una transacción: o cambian las dos o
-- ninguna. Idempotente (se puede volver a correr).
--
-- Al agregar la FK, Postgres revalida las filas existentes: todas ya cumplen
-- (la FK vieja las garantizaba). Toma un lock corto sobre las dos tablas.
--
-- Probar con prueba_ejercicios_fk_restrict.sql.

begin;

do $$
declare
  v_tabla text;
  v_nombre text;
begin
  foreach v_tabla in array array['routine_exercises', 'user_exercise_weights'] loop
    select con.conname into v_nombre
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.contype = 'f'
      and con.conrelid = format('public.%I', v_tabla)::regclass
      and con.confrelid = 'public.exercises'::regclass
      and att.attname = 'exercise_id';

    if v_nombre is null then
      raise exception 'No encontré la FK de %.exercise_id hacia exercises', v_tabla;
    end if;

    execute format('alter table public.%I drop constraint %I', v_tabla, v_nombre);
    execute format(
      'alter table public.%I add constraint %I foreign key (exercise_id) references public.exercises(id) on delete restrict',
      v_tabla, v_nombre
    );
    raise notice '%: % ahora es ON DELETE RESTRICT', v_tabla, v_nombre;
  end loop;
end $$;

commit;

-- Verificación rápida: las dos tienen que decir 'r' (restrict).
--   select conrelid::regclass as tabla, conname, confdeltype
--   from pg_constraint
--   where contype = 'f' and confrelid = 'public.exercises'::regclass;
