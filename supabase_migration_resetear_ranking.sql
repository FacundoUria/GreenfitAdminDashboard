-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor) CUANDO SE
-- QUIERA activar el botón "Resetear Ranking" del panel Admin (Comunidad >
-- Ranking). Mismo proyecto de Supabase que usa la PWA -- xp_events,
-- profiles, is_admin() ya existen ahí (ver
-- greenfit-app/backend/supabase_migration_xp.sql y
-- PAGINA SUPABASE/supabase_migration_xp_disciplina.sql). No se ejecuta
-- automáticamente: es un cambio de schema sobre producción.

-- ============================================================
-- 1) RPC: reinicia el Ranking de Comunidad a 0 XP para TODOS los socios --
--    NO borra xp_events (auditoría completa, mismo criterio que
--    admin_revertir_xp_evento): por cada socio con XP positivo, inserta UNA
--    fila de compensación NEGATIVA que neutraliza exactamente su suma
--    actual. `fetchTotalXp` (PWA) y `community_ranking_xp` (Admin y PWA)
--    ya suman TODO `xp_events.xp_amount` por usuario -- ninguno de los dos
--    necesita ningún cambio de código para reflejar el reseteo: apenas
--    corre este RPC, el próximo fetch de cualquiera de los dos ya da 0
--    (y Nivel 1, calcularNivel(0) = floor(0/500)+1 = 1) solo.
--
--    Idempotente: correrlo dos veces seguidas no resta de más -- la
--    segunda vez ya no encuentra a nadie con suma > 0, así que no inserta
--    nada (0 afectados).
-- ============================================================

create or replace function public.admin_resetear_ranking()
returns integer
language plpgsql
security definer
as $$
declare
  v_fila record;
  v_afectados integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  for v_fila in
    select user_id, sum(xp_amount)::int as total
    from xp_events
    group by user_id
    having sum(xp_amount) > 0
  loop
    insert into xp_events (user_id, event_type, xp_amount, event_date, created_by)
    values (v_fila.user_id, 'reversion', -v_fila.total, current_date, auth.uid());
    v_afectados := v_afectados + 1;
  end loop;

  return v_afectados;
end;
$$;

grant execute on function public.admin_resetear_ranking() to authenticated;

-- ============================================================
-- 2) Recordatorio visual de reseteo programado -- SIN automatización real
--    (pg_cron): es solo una fecha que el propio Admin carga y ve reflejada
--    como aviso en la pantalla de Ranking, para acordarse de tocar el botón
--    manual de arriba ese día. Activar un cron job real de Supabase
--    (pg_cron) para blanquear la XP solo, sin intervención humana, es una
--    pieza de infraestructura aparte (requiere habilitar la extensión a
--    nivel de proyecto y no se puede verificar/probar sin acceso directo a
--    la base) -- se prioriza que el reseteo MANUAL funcione perfecto, tal
--    como permite el propio pedido si la automatización real resulta
--    demasiada complejidad.
-- ============================================================

alter table configuracion add column if not exists proximo_reseteo_ranking date;
