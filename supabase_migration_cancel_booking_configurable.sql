-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- Bug real (detectado en la auditoría): cancel_booking() Y admin_cancel_booking()
-- tenían `interval '2 hours'` HARDCODEADO -- el campo "Tiempo de gracia" de
-- Configuracion.jsx (panel Admin) escribía a una columna que ninguna de las
-- dos RPCs leía. Seba podía creer que cambió la regla de reintegros y en
-- realidad no cambiaba nada -- ni cuando cancelaba el socio desde la PWA
-- (cancel_booking) ni cuando el propio Seba cancelaba en nombre de un
-- socio desde el panel (admin_cancel_booking).
--
-- Columna real confirmada (Configuracion.jsx:12,114 y
-- ConfiguracionContext.tsx en la PWA -- las dos leen/escriben esta misma):
--   configuracion.limite_cancelacion_minutos (integer, EN MINUTOS)
-- La columna `horas_limite_cancelacion` del CREATE TABLE original
-- (supabase_migration_configuracion.sql) nunca se usa en ningún código
-- vivo -- drift no rastreado, ver AUDITORIA_GREENFIT.md.
--
-- Alcance: las dos funciones quedan con EXACTAMENTE el mismo cambio --
-- solo la lectura del tiempo de gracia, nada de locking/borrado/logging
-- se toca en ninguna de las dos (cancel_booking se corrigió primero, en
-- un cambio separado; admin_cancel_booking se agregó acá después con el
-- mismo alcance mínimo, a pedido explícito, una vez confirmado que el
-- primer fix funcionaba bien).
--
-- Seguridad ("no romper nada"): en las DOS funciones, la lectura de
-- `configuracion` está envuelta en su propio bloque BEGIN/EXCEPTION -- si
-- la columna no existiera en este ambiente, la fila no existiera, o
-- cualquier otra falla de lectura, cae al mismo valor que ya estaba
-- hardcodeado (120 minutos = 2 horas) en vez de romper la función
-- completa (que dejaría a socios, o al admin actuando en su nombre, sin
-- poder cancelar una reserva).

drop function if exists public.cancel_booking(uuid, date, text);

create or replace function public.cancel_booking(p_class_id uuid, p_booking_date date, p_reason text default null)
returns boolean
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_discipline_id uuid;
  v_start_time time;
  v_credit_id uuid;
  v_class_start timestamptz;
  v_dentro_del_limite boolean;
  v_limite_minutos int;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  select discipline_id, start_time into v_discipline_id, v_start_time
  from classes where id = p_class_id;

  v_class_start := (p_booking_date::text || ' ' || v_start_time::text)::timestamp
    at time zone 'America/Argentina/Mendoza';

  -- Tiempo de gracia real, configurado por el admin -- con fallback
  -- defensivo a 120 minutos (el valor que ya estaba hardcodeado) si algo
  -- de esta lectura falla por cualquier motivo.
  begin
    select coalesce(limite_cancelacion_minutos, 120) into v_limite_minutos
    from configuracion where id = 1;
  exception when others then
    v_limite_minutos := null;
  end;
  if v_limite_minutos is null then
    v_limite_minutos := 120;
  end if;

  v_dentro_del_limite := now() <= (v_class_start - (v_limite_minutos || ' minutes')::interval);

  delete from bookings
  where user_id = v_user_id and class_id = p_class_id and booking_date = p_booking_date;
  if not found then
    raise exception 'No tenías una reserva en esta clase';
  end if;

  insert into booking_cancellations (user_id, class_id, booking_date, reason)
  values (v_user_id, p_class_id, p_booking_date, nullif(trim(p_reason), ''));

  if v_dentro_del_limite then
    select id into v_credit_id
    from user_credits
    where user_id = v_user_id and discipline_id = v_discipline_id
    order by created_at desc
    limit 1
    for update;

    if v_credit_id is not null then
      update user_credits set remaining_credits = remaining_credits + 1 where id = v_credit_id;
    end if;
  end if;

  return v_dentro_del_limite;
end;
$$;

grant execute on function public.cancel_booking(uuid, date, text) to authenticated;

-- ============================================================
-- admin_cancel_booking() -- mismo fix, mismo alcance mínimo. La única
-- diferencia real con cancel_booking() es que actúa sobre un p_user_id
-- elegido por el admin en vez de auth.uid(), y el mensaje de excepción
-- ("Ese socio no tenía...", en tercera persona) -- eso no se toca.
-- ============================================================

drop function if exists public.admin_cancel_booking(uuid, uuid, date, text);

create or replace function public.admin_cancel_booking(p_user_id uuid, p_class_id uuid, p_booking_date date, p_reason text default null)
returns boolean
language plpgsql
security definer
as $$
declare
  v_discipline_id uuid;
  v_start_time time;
  v_credit_id uuid;
  v_class_start timestamptz;
  v_dentro_del_limite boolean;
  v_limite_minutos int;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select discipline_id, start_time into v_discipline_id, v_start_time
  from classes where id = p_class_id;

  v_class_start := (p_booking_date::text || ' ' || v_start_time::text)::timestamp
    at time zone 'America/Argentina/Mendoza';

  -- Tiempo de gracia real, configurado por el admin -- con fallback
  -- defensivo a 120 minutos (el valor que ya estaba hardcodeado) si algo
  -- de esta lectura falla por cualquier motivo.
  begin
    select coalesce(limite_cancelacion_minutos, 120) into v_limite_minutos
    from configuracion where id = 1;
  exception when others then
    v_limite_minutos := null;
  end;
  if v_limite_minutos is null then
    v_limite_minutos := 120;
  end if;

  v_dentro_del_limite := now() <= (v_class_start - (v_limite_minutos || ' minutes')::interval);

  delete from bookings
  where user_id = p_user_id and class_id = p_class_id and booking_date = p_booking_date;
  if not found then
    raise exception 'Ese socio no tenía una reserva en esta clase';
  end if;

  insert into booking_cancellations (user_id, class_id, booking_date, reason)
  values (p_user_id, p_class_id, p_booking_date, nullif(trim(p_reason), ''));

  if v_dentro_del_limite then
    select id into v_credit_id
    from user_credits
    where user_id = p_user_id and discipline_id = v_discipline_id
    order by created_at desc
    limit 1
    for update;

    if v_credit_id is not null then
      update user_credits set remaining_credits = remaining_credits + 1 where id = v_credit_id;
    end if;
  end if;

  return v_dentro_del_limite;
end;
$$;

grant execute on function public.admin_cancel_booking(uuid, uuid, date, text) to authenticated;

-- ── Verificación (opcional, después de correr lo de arriba) ────────────────
-- 1) Confirmar el valor configurado hoy:
--    select limite_cancelacion_minutos from configuracion where id = 1;
-- 2) Cambiar "Tiempo de gracia" desde Configuración (panel Admin) a un
--    valor de prueba (ej. 10 minutos) y confirmar que se guardó:
--    select limite_cancelacion_minutos from configuracion where id = 1;
-- 3) Con una reserva de prueba cuya clase arranque en, digamos, 15 minutos,
--    cancelarla desde la PWA -- con el límite en 10 minutos, tiene que
--    reintegrar el crédito (todavía faltan más de 10 min). Bajar el
--    límite a 20 minutos y repetir -- ahí NO tendría que reintegrar
--    (faltan menos de 20 min).
-- 4) Repetir el mismo par de pruebas del punto 3, pero cancelando esa
--    reserva desde el panel Admin (en nombre del socio) en vez de la PWA
--    -- confirma que admin_cancel_booking() responde igual que
--    cancel_booking() con el mismo límite configurado.
-- 5) Volver a dejar el valor real de producción en Configuración al
--    terminar de probar.
