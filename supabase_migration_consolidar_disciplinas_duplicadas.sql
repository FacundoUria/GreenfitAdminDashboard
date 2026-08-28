-- Ejecutar en el SQL Editor de Supabase DESPUÉS de correr
-- supabase_diagnostico_kickstrike.sql y confirmar que el punto 1 (o el 2)
-- devolvió alguna fila -- si no devolvió nada, este script no tiene nada
-- para hacer (es un no-op seguro, podés correrlo igual sin miedo).
--
-- Causa real del bug ("la grilla de Admin muestra 0 y sumar créditos tira
-- 'disciplina no encontrada'" pese a que la PWA sincroniza bien): la
-- unique constraint de disciplines.name es CASE-SENSITIVE
-- (backend/supabase-schema.sql), así que "Kickstrike" y "kickstrike" (o
-- cualquier otra variante de mayúsculas) pueden convivir como DOS filas
-- legítimas y "únicas" para Postgres -- pero todo el código que resuelve
-- una disciplina por NOMBRE usa `ilike` (case-insensitive), así que ambas
-- matchean a la vez y la resolución se vuelve ambigua. El código ya
-- tolera esto (ver creditosPwa.js/SociosTabla.jsx), pero consolidar el
-- dato de raíz evita que la ambigüedad se arrastre para siempre.
--
-- Qué hace: para cada grupo de disciplinas cuyo nombre es "el mismo" en
-- minúsculas, se queda con la fila MÁS ANTIGUA (la que tiene historial
-- real detrás) como canónica, reasigna todas las referencias (FK) de las
-- filas duplicadas hacia esa fila canónica, y borra las duplicadas. Es
-- 100% genérico -- no está hardcodeado a "Kickstrike", así que de paso
-- limpia cualquier otro duplicado de catálogo que exista hoy o aparezca
-- en el futuro por el mismo motivo.
do $$
declare
  grupo record;
  canonico uuid;
  duplicado uuid;
  i int;
begin
  for grupo in
    select lower(trim(name)) as clave, array_agg(id order by created_at asc) as ids
    from disciplines
    group by lower(trim(name))
    having count(*) > 1
  loop
    canonico := grupo.ids[1]; -- la más antigua del grupo

    for i in 2 .. array_length(grupo.ids, 1) loop
      duplicado := grupo.ids[i];

      update user_credits set discipline_id = canonico where discipline_id = duplicado;
      update credit_transactions set discipline_id = canonico where discipline_id = duplicado;
      update classes set discipline_id = canonico where discipline_id = duplicado;
      update packs set discipline_id = canonico where discipline_id = duplicado;
      update community_posts set discipline_id = canonico where discipline_id = duplicado;

      delete from disciplines where id = duplicado;

      raise notice 'Consolidada disciplina duplicada % -> % (nombre: "%")', duplicado, canonico, grupo.clave;
    end loop;
  end loop;
end $$;

-- Deja el nombre EXACTO de la fila canónica de Kickstrike en la
-- capitalización correcta, por si la fila que sobrevivió (la más antigua)
-- había quedado con otra variante de mayúsculas.
update disciplines
set name = 'Kickstrike'
where lower(trim(name)) = 'kickstrike' and name <> 'Kickstrike';

-- ── Verificación (opcional, después de correr todo lo de arriba) ───────────
-- select lower(trim(name)), count(*) from disciplines group by 1 having count(*) > 1; -- 0 filas
-- select id, name from disciplines where name ilike '%kickstr%'; -- 1 sola fila, "Kickstrike"
