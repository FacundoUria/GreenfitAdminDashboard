-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor) CUANDO SE
-- QUIERA activar: que la PWA nunca pueda mostrar una disciplina que el
-- panel Admin no tenga tildada para ese socio. Mismo proyecto de Supabase
-- que usa la PWA (greenfit-app) -- user_credits, socios, profiles,
-- disciplines ya existen ahí. No se ejecuta automáticamente.
--
-- ============================================================
-- CAUSA REAL DEL DESFASAJE (auditado antes de tocar nada)
-- ============================================================
-- `user_credits` es un ledger APPEND-ONLY por diseño (nunca se borra una
-- fila, ver todas las migraciones de créditos/vencimiento de esta app).
-- fetchUserBalances() (creditsApi.ts) lee "la fila más reciente por
-- disciplina" -- pero eso incluye CUALQUIER disciplina que ALGUNA VEZ tuvo
-- una fila, sin importar si sigue en `socios.plan` HOY. Si el admin destilda
-- Kickboxing y CrossFit de un socio, esas filas de user_credits siguen
-- existiendo intactas (correcto para el ledger, auditoría completa) -- pero
-- nada las invalidaba nunca, así que la PWA las seguía mostrando como
-- activas para siempre. Eso es el "se acumulan en vez de reflejar la
-- decisión del admin" que reportó Seba.
--
-- FIX: no se toca el ledger (nunca se borra nada, sigue siendo auditable).
-- Se agrega un FILTRO en la LECTURA: la PWA solo puede mostrar disciplinas
-- que estén en `socios.plan` en este momento. Así, aunque una fila vieja de
-- user_credits siga ahí, deja de ser VISIBLE apenas el admin la saca del
-- plan -- sin esperar ninguna sincronización manual, sin depender de que
-- alguien se acuerde de limpiar nada al guardar. Es estructuralmente
-- imposible que la PWA muestre algo que el admin no tildó, porque el propio
-- RPC que arma la lista nunca deja pasar esa fila.
-- ============================================================

-- Devuelve SIEMPRE exactamente 1 fila (nunca 0, nunca varias) -- más fácil
-- de consumir del lado cliente con .single() que un set de filas variable.
--   vinculado=false -- el socio autenticado no tiene DNI cargado en su
--     profile, o no hay ninguna ficha en `socios` con ese DNI. Sin una
--     ficha admin real de la que depender, no se filtra nada (mismo
--     criterio "fail open" que ya usa sync_my_membership para esta misma
--     situación) -- discipline_ids viene null, el cliente lo interpreta
--     como "no filtrar".
--   vinculado=true -- discipline_ids trae el set real (puede ser vacío,
--     ej. un socio sin ningún plan tildado hoy) de disciplinas que están
--     en `socios.plan` AHORA MISMO. Cualquier balance de user_credits que
--     no esté en este set se descarta en la lectura.
create or replace function public.disciplinas_del_plan_actual()
returns table (vinculado boolean, discipline_ids uuid[])
language plpgsql
security definer
stable
as $$
declare
  v_user_id uuid := auth.uid();
  v_dni text;
  v_plan text[];
  v_ids uuid[];
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  select p.dni into v_dni from profiles p where p.id = v_user_id;
  if v_dni is null then
    return query select false, null::uuid[];
    return;
  end if;

  select s.plan into v_plan from socios s where s.dni = v_dni limit 1;
  if v_plan is null then
    -- DNI cargado pero sin ficha en `socios` (o ficha sin `plan` cargado
    -- todavía) -- no hay ninguna decisión real del admin de la que
    -- depender acá, se deja sin filtrar en vez de vaciarle la pantalla a
    -- alguien que en teoría sí debería tener acceso.
    return query select false, null::uuid[];
    return;
  end if;

  -- Resuelve cada nombre de `socios.plan` contra `disciplines` por NOMBRE
  -- (case-insensitive, mismo criterio que resolverDisciplinaId en
  -- creditosPwa.js) -- MÁS el mismo fallback legado de "Pase Libre"
  -- (etiqueta sin fila propia en `disciplines`, cuenta como cualquier
  -- disciplina kind='membership') que ya usa sincronizarVencimientoPwa.
  select array_agg(distinct d.id) into v_ids
  from disciplines d
  where lower(d.name) = any (select lower(unnest(v_plan)))
     or (
       d.kind = 'membership'
       and exists (select 1 from unnest(v_plan) p2 where lower(p2) = 'pase libre')
     );

  return query select true, coalesce(v_ids, '{}'::uuid[]);
end;
$$;

grant execute on function public.disciplinas_del_plan_actual() to authenticated;

-- ============================================================
-- Verificación rápida después de correr esto (con el caso real de Isa
-- Giurato, o cualquier socio con el mismo síntoma):
--   1. En el panel Admin, confirmar que `socios.plan` para ese socio
--      efectivamente diga solo lo esperado (ej. ['Boxeo']):
--        select nombre, apellido, plan, creditos from socios where dni = '...';
--   2. Logueado como ESE socio en la PWA (Inicio/Mi Perfil), confirmar que
--      SOLO aparezca esa disciplina, aunque user_credits todavía tenga
--      filas viejas de otras:
--        select uc.*, d.name from user_credits uc
--        join profiles p on p.id = uc.user_id
--        join disciplines d on d.id = uc.discipline_id
--        where p.dni = '...' order by uc.created_at desc;
--      (esta consulta puede seguir mostrando Kickboxing/CrossFit -- es
--      esperado, el ledger no se borra. Lo que importa es que la PWA ya
--      no las muestre.)
-- ============================================================
