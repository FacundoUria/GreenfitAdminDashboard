-- Ejecutar en el SQL Editor de Supabase.
--
-- Continuación de la unificación de nomenclatura (después de Kickboxing ->
-- Kickstrike, ver supabase_migration_rename_kickstrike.sql): el cliente
-- pide fijar de una vez las 3 disciplinas restantes con nombre único y
-- estricto:
--   - "Aparatos / Musculación" / "Musculación"  -> "Aparatos"
--   - "Crosstraining" / "Cross Training"        -> "CrossFit"
--   - cualquier variante de mayúsculas          -> "Boxeo"
--
-- AUDITORÍA (antes de escribir esto): grep exhaustivo en los dos repos --
-- "Crosstraining"/"Cross Training" NO aparece en ningún archivo de código
-- actual (a diferencia de "Aparatos / Musculación", que sí es una etiqueta
-- viva en varios lugares). Si "Crosstraining" existe, es un dato viejo que
-- solo vive en la base -- el bloque de abajo lo cubre igual, por las
-- dudas; es un no-op si no hay nada que consolidar.
--
-- ── PASO 1: catálogo (disciplines) ──────────────────────────────────────
-- Mismo mecanismo que supabase_migration_consolidar_disciplinas_duplicadas.sql:
-- agrupa las filas por su nombre CANÓNICO (no el crudo), se queda con la
-- más antigua de cada grupo, reasigna las FK de las demás
-- (user_credits/credit_transactions/classes/packs/community_posts) hacia
-- la que sobrevive, borra el resto, y deja el name exacto en la forma
-- canónica. Todo en un solo paso -- no hace falta un UPDATE simple ANTES:
-- si ya existían dos filas (ej. "CrossFit" y "Crosstraining"), ese UPDATE
-- ciego chocaría con la unique constraint de disciplines.name
-- (case-sensitive) antes de llegar a consolidar nada, el mismo problema
-- que ya pasó una vez con Kickstrike.
do $$
declare
  grupo record;
  canonico uuid;
  duplicado uuid;
  i int;
begin
  for grupo in
    select nombre_canonico, array_agg(id order by created_at asc) as ids
    from (
      select
        id,
        created_at,
        case
          when name ilike '%aparat%' or name ilike '%musculac%' then 'Aparatos'
          when name ilike '%crossfit%' or name ilike '%cross%training%' then 'CrossFit'
          when name ~* '^\s*boxeo\s*$' then 'Boxeo'
        end as nombre_canonico
      from disciplines
    ) t
    where nombre_canonico is not null
    group by nombre_canonico
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

      raise notice 'Consolidada disciplina duplicada % -> % (grupo: %)', duplicado, canonico, grupo.nombre_canonico;
    end loop;

    update disciplines set name = grupo.nombre_canonico where id = canonico and name <> grupo.nombre_canonico;
  end loop;
end $$;

-- ── PASO 2: socios.plan (array de texto libre) ──────────────────────────
-- Reconstruye el array elemento por elemento -- mismo criterio que el
-- rename de Kickstrike, ahora con las 3 reglas juntas.
update socios
set plan = (
  select array_agg(
    case
      when elem ilike '%aparat%' or elem ilike '%musculac%' then 'Aparatos'
      when elem ilike '%crossfit%' or elem ilike '%cross%training%' then 'CrossFit'
      when elem ~* '^\s*boxeo\s*$' then 'Boxeo'
      else elem
    end
    order by ord
  )
  from unnest(plan) with ordinality as t(elem, ord)
)
where exists (
  select 1 from unnest(plan) as elem
  where elem <> (
    case
      when elem ilike '%aparat%' or elem ilike '%musculac%' then 'Aparatos'
      when elem ilike '%crossfit%' or elem ilike '%cross%training%' then 'CrossFit'
      when elem ~* '^\s*boxeo\s*$' then 'Boxeo'
      else elem
    end
  )
);

-- ── PASO 3: historial de pagos (pagos_socio.paquete) ────────────────────
-- Puede ser el nombre exacto de la disciplina o parte de un nombre de
-- pack más largo (ej. "Pack 12 clases Crosstraining") -- substring,
-- case-insensitive. "Boxeo" NO lleva substring (evita tocar "Kickboxing"
-- por accidente si quedara alguno sin migrar).
update pagos_socio set paquete = regexp_replace(paquete, 'Aparatos\s*/\s*Musculaci[oó]n|Musculaci[oó]n', 'Aparatos', 'gi')
where paquete ~* 'musculaci[oó]n';

update pagos_socio set paquete = regexp_replace(paquete, 'Cross\s*[Tt]raining', 'CrossFit', 'gi')
where paquete ~* 'cross\s*training';

update pagos_socio set paquete = regexp_replace(paquete, '\yBoxeo\y', 'Boxeo', 'gi')
where paquete ~* '\yboxeo\y' and paquete !~ '\yBoxeo\y';

-- ── PASO 4: nombres de packs (packs.name) ───────────────────────────────
update packs set name = regexp_replace(name, 'Aparatos\s*/\s*Musculaci[oó]n|Musculaci[oó]n', 'Aparatos', 'gi')
where name ~* 'musculaci[oó]n';

update packs set name = regexp_replace(name, 'Cross\s*[Tt]raining', 'CrossFit', 'gi')
where name ~* 'cross\s*training';

update packs set name = regexp_replace(name, '\yBoxeo\y', 'Boxeo', 'gi')
where name ~* '\yboxeo\y' and name !~ '\yBoxeo\y';

-- ── PASO 5: títulos de clases (classes.title) ───────────────────────────
update classes set title = regexp_replace(title, 'Aparatos\s*/\s*Musculaci[oó]n|Musculaci[oó]n', 'Aparatos', 'gi')
where title ~* 'musculaci[oó]n';

update classes set title = regexp_replace(title, 'Cross\s*[Tt]raining', 'CrossFit', 'gi')
where title ~* 'cross\s*training';

update classes set title = regexp_replace(title, '\yBoxeo\y', 'Boxeo', 'gi')
where title ~* '\yboxeo\y' and title !~ '\yBoxeo\y';

-- ── PASO 6: snapshot desnormalizado de Comunidad (community_posts.author_discipline) ──
update community_posts set author_discipline = regexp_replace(author_discipline, 'Aparatos\s*/\s*Musculaci[oó]n|Musculaci[oó]n', 'Aparatos', 'gi')
where author_discipline ~* 'musculaci[oó]n';

update community_posts set author_discipline = regexp_replace(author_discipline, 'Cross\s*[Tt]raining', 'CrossFit', 'gi')
where author_discipline ~* 'cross\s*training';

update community_posts set author_discipline = regexp_replace(author_discipline, '\yBoxeo\y', 'Boxeo', 'gi')
where author_discipline ~* '\yboxeo\y' and author_discipline !~ '\yBoxeo\y';

-- ── Verificación (opcional, después de correr todo lo de arriba) ───────────
-- select id, name from disciplines order by name; -- una sola fila por disciplina, nombres exactos
-- select lower(trim(name)), count(*) from disciplines group by 1 having count(*) > 1; -- 0 filas
-- select id, plan from socios where plan::text ilike '%musculac%' or plan::text ilike '%cross%training%'; -- 0 filas
-- select id, paquete from pagos_socio where paquete ilike '%musculac%' or paquete ilike '%cross%training%'; -- 0 filas
-- select id, name from packs where name ilike '%musculac%' or name ilike '%cross%training%'; -- 0 filas
-- select id, title from classes where title ilike '%musculac%' or title ilike '%cross%training%'; -- 0 filas
