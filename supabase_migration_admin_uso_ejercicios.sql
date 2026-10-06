-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- ESTAMOS EN PRODUCCIÓN.  ** PUNTO A APROBAR: función nueva con permisos **
--
-- 1a / 1b -- Conteos de uso de los ejercicios para el panel Admin.
--
-- Por qué una función: el Admin necesita saber, antes de borrar un ejercicio,
-- en cuántas rutinas está, de cuántos socios, y cuántos pesos cargados tiene.
-- Los pesos están en user_exercise_weights, cuya RLS solo deja ver los propios:
-- desde el cliente el Admin no puede contarlos. Esta función los cuenta del
-- lado del servidor (SECURITY DEFINER) y solo devuelve NÚMEROS, nunca pesos ni
-- ids de socios. Exige is_admin().
--
-- p_exercise_ids: los ejercicios a contar; null = todos (1b usa la lista
-- completa para ordenar las sugerencias por uso).
--
-- Devuelve una fila por ejercicio:
--   rutinas_asignadas  rutinas de socios (routines.user_id no nulo) que lo usan
--   plantillas         plantillas (sin socio) que lo usan
--   socios             socios distintos con alguna rutina que lo usa
--   pesos              filas de user_exercise_weights (socios que cargaron un peso)
--
-- Permisos: se cierra public y anon, se mantiene authenticated (el panel
-- llama con la sesión normal del admin; la protección real es el is_admin()).

create or replace function public.admin_uso_ejercicios(p_exercise_ids uuid[] default null)
returns table (
  exercise_id uuid,
  rutinas_asignadas int,
  plantillas int,
  socios int,
  pesos int
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  return query
  select
    e.id,
    (select count(distinct r.id)::int
       from routine_exercises re
       join routine_days rd on rd.id = re.day_id
       join routines r on r.id = rd.routine_id
      where re.exercise_id = e.id and r.user_id is not null),
    (select count(distinct r.id)::int
       from routine_exercises re
       join routine_days rd on rd.id = re.day_id
       join routines r on r.id = rd.routine_id
      where re.exercise_id = e.id and r.user_id is null),
    (select count(distinct r.user_id)::int
       from routine_exercises re
       join routine_days rd on rd.id = re.day_id
       join routines r on r.id = rd.routine_id
      where re.exercise_id = e.id and r.user_id is not null),
    (select count(*)::int from user_exercise_weights w where w.exercise_id = e.id)
  from exercises e
  where p_exercise_ids is null or e.id = any (p_exercise_ids);
end;
$$;

revoke execute on function public.admin_uso_ejercicios(uuid[]) from public, anon;
grant execute on function public.admin_uso_ejercicios(uuid[]) to authenticated;
