-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor) CUANDO SE
-- QUIERA activar: el botón "Hoy Entrené" en Inicio de la PWA -- reincorpora
-- el autoreporte de XP que se había sacado en
-- backend/supabase_migration_xp_solo_asistencia.sql, ahora con un límite
-- diario real (no 1 fijo): tantos clics por día como disciplinas ACTIVAS
-- tenga el socio. Pedido explícito de Seba, con esa salvaguarda nueva --
-- ver notas de diseño más abajo.
--
-- ============================================================
-- REGLA DE PUNTOS: TODA acción positiva = SIEMPRE Y EXACTAMENTE 100 XP.
-- Ya así estaban reserva (+100, supabase_migration_xp_reserva.sql),
-- cancelación (-100, reversión) y asistencia real (+100, trigger
-- award_xp_asistencia / admin_otorgar_checkin_musculacion) -- no se tocan,
-- ya cumplen la regla. Esta migración solo agrega el +100 de "Hoy Entrené".
-- ============================================================
--
-- ============================================================
-- POR QUÉ UN LÍMITE POR DISCIPLINA (no 1 fijo como antes)
-- ============================================================
-- El índice único idx_xp_events_asistencia_por_dia_sin_disciplina
-- (de supabase_migration_xp.sql) capaba el autoreporte a 1 por día, sin
-- excepción -- incompatible con "hasta N clics, según cuántas disciplinas
-- tenga activas". Se reemplaza el enforcement por el propio RPC (cuenta
-- cuántas veces ya se usó hoy vs. cuántas disciplinas activas tiene,
-- ambos calculados server-side, nunca confiando en lo que mande el
-- cliente) -- más flexible que un índice único, y necesario para el límite
-- variable pedido.
-- ============================================================

-- 1) El índice viejo (1 por día, sin discriminar disciplinas) ya no aplica.
drop index if exists idx_xp_events_asistencia_por_dia_sin_disciplina;

-- 2) RPC: registra "Hoy Entrené" si todavía hay cupo, si no, avisa sin
--    otorgar nada. security definer -- el cliente nunca inserta directo en
--    xp_events (no hay policy de insert para 'authenticated' desde
--    supabase_migration_xp_solo_asistencia.sql, y sigue sin haberla: toda
--    escritura pasa por una función).
--
--    pg_advisory_xact_lock serializa clics del MISMO usuario dentro de la
--    misma transacción -- sin esto, dos clics casi simultáneos (double-tap)
--    podrían leer el mismo conteo "antes" y los dos pasar la validación.
--    Barato (un lock en memoria, se libera solo al terminar la función) y
--    elimina la carrera por completo.
create or replace function public.registrar_hoy_entrene()
returns table (
  otorgado boolean,
  xp_otorgado int,
  entrenamientos_hoy int,
  entrenamientos_maximos int
)
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_disciplinas_activas int;
  v_ya_hoy int;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text || ':hoy_entrene'));

  -- Disciplinas donde el socio tiene algo VIGENTE ahora mismo -- misma
  -- lógica "última fila por (user_id, discipline_id) gana" que ya usa
  -- fetchUserBalances() del lado de la PWA (creditsApi.ts), y el mismo
  -- criterio de "activo" (créditos>0 / expires_at futuro) que ya calculan
  -- getCreditsStatus/getExpiryStatus en membershipStatus.ts -- para que el
  -- número que ve el socio en pantalla y el límite real del servidor
  -- coincidan siempre.
  select count(*) into v_disciplinas_activas
  from (
    select distinct on (uc.discipline_id)
      uc.discipline_id, uc.remaining_credits, uc.expires_at, d.kind
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id
    where uc.user_id = v_user_id
    order by uc.discipline_id, uc.created_at desc
  ) latest
  where (kind = 'credits' and coalesce(remaining_credits, 0) > 0)
     or (kind = 'membership' and expires_at is not null and expires_at > now());

  if v_disciplinas_activas <= 0 then
    raise exception 'Todavía no tenés ninguna disciplina activa -- no hay ningún entrenamiento que registrar hoy.';
  end if;

  -- Autoreportes de HOY -- mismo criterio de siempre: event_type=
  -- 'asistencia' con discipline_id null es la marca de "autoreportado por
  -- el socio, no por una clase reservada ni un check-in del Admin".
  select count(*) into v_ya_hoy
  from xp_events
  where user_id = v_user_id
    and event_type = 'asistencia'
    and discipline_id is null
    and event_date = current_date;

  if v_ya_hoy >= v_disciplinas_activas then
    return query select false, 0, v_ya_hoy, v_disciplinas_activas;
    return;
  end if;

  insert into xp_events (user_id, event_type, xp_amount, event_date, created_by)
  values (v_user_id, 'asistencia', 100, current_date, v_user_id);

  return query select true, 100, v_ya_hoy + 1, v_disciplinas_activas;
end;
$$;

grant execute on function public.registrar_hoy_entrene() to authenticated;

-- ============================================================
-- Verificación rápida después de correr esto (logueado como socio en la PWA):
--   1. Con 1 disciplina activa: "Hoy Entrené" da +100 XP UNA vez, la segunda
--      vez el botón queda deshabilitado con "Ya registraste todos tus
--      entrenamientos de hoy".
--   2. Con 2 disciplinas activas (ej. CrossFit + Aparatos): se puede tocar
--      2 veces en el mismo día (+200 XP en total), la tercera vez ya no.
--   3. select event_type, xp_amount, discipline_id, event_date from xp_events
--      where user_id = '...' and event_date = current_date order by created_at;
--      -- confirma que cada click autoreportado quedó como su propia fila,
--      discipline_id null, sin pisar ni duplicar nada.
-- ============================================================
