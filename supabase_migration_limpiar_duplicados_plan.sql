-- Ejecutar en el SQL Editor de Supabase.
--
-- Bug real reportado: la grilla de Socios mostraba disciplinas duplicadas
-- visualmente (ej. "Aparatos Aparatos", "Crossfit Crossfit"). Causa real:
-- `socios.plan` es un array de texto libre -- si un socio tenía "CrossFit"
-- Y "Crosstraining" cargados (dos strings distintos, misma disciplina
-- real), supabase_migration_unificar_disciplinas.sql (la migración de
-- unificación de nomenclatura) normalizó cada string por separado sin
-- deduplicar el array resultante, dejando literalmente
-- plan=["CrossFit","CrossFit"]. `handleTogglePlan()` en NuevoSocioModal.jsx
-- (checkboxes fijos, ver ese archivo) ya es estructuralmente incapaz de
-- pushear un duplicado nuevo -- esto es 100% limpieza de datos históricos,
-- no hay nada más que prevenir del lado del código para casos futuros
-- (normalizarPlanes() en utils/planes.js también dedupea ahora en
-- lectura, así que ni siquiera hace falta correr esto para que la UI deje
-- de mostrar el duplicado -- pero el dato en la base sigue sucio hasta
-- correrlo, y cualquier código nuevo que lea `socios.plan` directo, sin
-- pasar por normalizarPlanes(), seguiría viendo el duplicado).
--
-- Idempotente: el WHERE solo alcanza a las filas que TIENEN un duplicado
-- real (longitud del array distinta a la cantidad de valores únicos) --
-- correrlo de nuevo sobre datos ya limpios no cambia nada.
--
-- Nota sobre el orden: array_agg(distinct elem) devuelve los valores en
-- orden alfabético (no el orden original de carga) -- `plan` es un
-- conjunto de actividades tildadas, no una lista donde el orden importe
-- en ningún lado del código (ver planesDeCreditos/formatearPlanes en
-- utils/planes.js, ninguna depende del orden), así que esto es seguro.
update socios
set plan = (select array_agg(distinct elem) from unnest(plan) as elem)
where plan is not null
  and array_length(plan, 1) is distinct from (select count(distinct elem) from unnest(plan) as elem);

-- ── Verificación (opcional, después de correr lo de arriba) ────────────────
-- Debería devolver 0 filas:
-- select id, dni, plan
--   from socios
--   where plan is not null
--     and array_length(plan, 1) is distinct from (select count(distinct elem) from unnest(plan) as elem);
