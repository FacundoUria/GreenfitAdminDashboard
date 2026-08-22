-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor) CUANDO SE
-- QUIERA activar: +100 XP al reservar una clase, -100 XP (reversión) al
-- cancelarla. Mismo proyecto de Supabase que usa la PWA -- xp_events,
-- bookings, classes, book_class/cancel_booking/admin_book_class/
-- admin_cancel_booking ya existen ahí (ver backend/supabase-schema.sql y
-- supabase_migration_admin_auth_rls.sql). No se ejecuta automáticamente:
-- es un cambio de schema sobre producción.
--
-- REGLAS VIGENTES DE XP (actualizado -- ver supabase_migration_xp.sql y
-- supabase_migration_xp_disciplina.sql para el historial completo):
--   1) Reservar una clase                                    -> +100 XP (NUEVO, este archivo)
--   2) Cancelar esa reserva                                  -> -100 XP (reversión, NUEVO, este archivo)
--   3) Asistencia (clase confirmada por el Admin, o Check-in
--      Rápido de Musculación)                                -> +100 XP (YA EXISTÍA, sin cambios)
--
-- Esto NO reabre el autoreporte que se cerró en
-- supabase_migration_xp_solo_asistencia.sql -- publicar en la Comunidad,
-- superar un PR y completar una Meta siguen sin otorgar XP. "Reservar" es
-- una excepción puntual y controlada aprobada explícitamente por Seba: se
-- acepta que un socio que reserva y nunca cancela ni asiste se quede con
-- los +100 XP (no hay hoy un concepto de "no-show" que lo revierta) --
-- decisión consciente, no un descuido.
--
-- Montos como literales dentro de cada función (mismo criterio que ya usan
-- el resto de las reglas de este archivo) -- para cambiar la economía del
-- juego más adelante, se edita el número en book_class/admin_book_class
-- (otorga) y en cancel_booking/admin_cancel_booking (revierte, tiene que
-- quedar en espejo del monto que se otorgó).

-- ============================================================
-- 1) xp_events: nuevo event_type 'reserva' + índice único defensivo (mismo
--    patrón que ya protege 'asistencia' contra un otorgamiento duplicado
--    para la misma referencia).
-- ============================================================

alter table xp_events drop constraint if exists xp_events_event_type_check;
alter table xp_events add constraint xp_events_event_type_check
  check (event_type in ('asistencia', 'pr', 'meta', 'post', 'reversion', 'reserva'));

create unique index if not exists idx_xp_events_reserva_unica
  on xp_events(reference_id) where event_type = 'reserva';

-- ============================================================
-- 2) book_class (PWA, el propio socio reserva) -- +100 XP al reservar.
--    Mismo cuerpo que backend/supabase-schema.sql, con el insert de
--    xp_events agregado justo después de crear la reserva. Todo dentro de
--    la misma función = misma transacción: si algo de acá para abajo
--    fallara, Postgres revierte TODO junto, incluida esta fila.
-- ============================================================

create or replace function public.book_class(p_class_id uuid, p_booking_date date)
returns uuid
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_capacity int;
  v_discipline_id uuid;
  v_days_of_week integer[];
  v_booked_count int;
  v_credit_id uuid;
  v_remaining int;
  v_booking_id uuid;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  select capacity, discipline_id, days_of_week into v_capacity, v_discipline_id, v_days_of_week
  from classes where id = p_class_id for update;
  if v_capacity is null then
    raise exception 'La clase no existe';
  end if;

  if not (extract(dow from p_booking_date)::int = any(v_days_of_week)) then
    raise exception 'Esta clase no se dicta ese día.';
  end if;

  -- El cupo se cuenta por ocurrencia puntual (class_id + booking_date), no
  -- para toda la vida de la plantilla recurrente.
  select count(*) into v_booked_count
  from bookings where class_id = p_class_id and booking_date = p_booking_date;
  if v_booked_count >= v_capacity then
    raise exception 'Sin cupo';
  end if;

  -- El balance de créditos es por disciplina: reservar Boxeo descuenta del
  -- pack de Boxeo, no del de Kickboxing aunque el socio tenga los dos.
  select id, remaining_credits into v_credit_id, v_remaining
  from user_credits
  where user_id = v_user_id and discipline_id = v_discipline_id
  order by created_at desc
  limit 1
  for update;

  if v_credit_id is null or coalesce(v_remaining, 0) <= 0 then
    raise exception 'Sin créditos disponibles para esta disciplina';
  end if;

  insert into bookings (user_id, class_id, booking_date) values (v_user_id, p_class_id, p_booking_date)
  returning id into v_booking_id;

  update user_credits set remaining_credits = remaining_credits - 1 where id = v_credit_id;

  -- +100 XP por reservar (regla de Seba, ver header de arriba).
  insert into xp_events (user_id, event_type, xp_amount, reference_id, discipline_id, created_by)
  values (v_user_id, 'reserva', 100, v_booking_id, v_discipline_id, v_user_id)
  on conflict do nothing;

  return v_booking_id;
end;
$$;

-- ============================================================
-- 3) cancel_booking (PWA) -- revierte el XP de la reserva, SIEMPRE que se
--    cancele (no depende de la ventana de 2hs, que es solo para el
--    reintegro de crédito -- son dos cosas independientes). Nunca se borra
--    el evento original: se compensa con una fila 'reversion' negativa,
--    mismo criterio que admin_revertir_xp_evento.
-- ============================================================

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
  v_booking_id uuid;
  v_reserva_xp_id uuid;
  v_reserva_xp_amount int;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  select discipline_id, start_time into v_discipline_id, v_start_time
  from classes where id = p_class_id;

  v_class_start := (p_booking_date::text || ' ' || v_start_time::text)::timestamp
    at time zone 'America/Argentina/Mendoza';
  v_dentro_del_limite := now() <= (v_class_start - interval '2 hours');

  delete from bookings
  where user_id = v_user_id and class_id = p_class_id and booking_date = p_booking_date
  returning id into v_booking_id;
  if not found then
    raise exception 'No tenías una reserva en esta clase';
  end if;

  insert into booking_cancellations (user_id, class_id, booking_date, reason)
  values (v_user_id, p_class_id, p_booking_date, nullif(trim(p_reason), ''));

  select id, xp_amount into v_reserva_xp_id, v_reserva_xp_amount
  from xp_events
  where reference_id = v_booking_id and event_type = 'reserva';
  if v_reserva_xp_id is not null then
    insert into xp_events (user_id, event_type, xp_amount, reference_id, discipline_id, created_by)
    values (v_user_id, 'reversion', -v_reserva_xp_amount, v_reserva_xp_id, v_discipline_id, v_user_id);
  end if;

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

grant execute on function public.book_class(uuid, date) to authenticated;
grant execute on function public.cancel_booking(uuid, date, text) to authenticated;

-- ============================================================
-- 4) admin_book_class / admin_cancel_booking -- mismo criterio, para
--    cuando el Admin reserva/cancela EN NOMBRE de un socio desde el panel
--    (Clases.jsx). Mismo comportamiento sin importar quién dispara la
--    reserva -- confirmado con Facundo. `created_by` acá es el Admin
--    (auth.uid()), no el socio -- mismo criterio que
--    admin_otorgar_checkin_musculacion/admin_revertir_xp_evento.
-- ============================================================

create or replace function public.admin_book_class(p_user_id uuid, p_class_id uuid, p_booking_date date)
returns uuid
language plpgsql
security definer
as $$
declare
  v_capacity int;
  v_discipline_id uuid;
  v_days_of_week integer[];
  v_booked_count int;
  v_credit_id uuid;
  v_remaining int;
  v_booking_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select capacity, discipline_id, days_of_week into v_capacity, v_discipline_id, v_days_of_week
  from classes where id = p_class_id for update;
  if v_capacity is null then
    raise exception 'La clase no existe';
  end if;

  if not (extract(dow from p_booking_date)::int = any(v_days_of_week)) then
    raise exception 'Esta clase no se dicta ese día.';
  end if;

  select count(*) into v_booked_count
  from bookings where class_id = p_class_id and booking_date = p_booking_date;
  if v_booked_count >= v_capacity then
    raise exception 'Sin cupo';
  end if;

  select id, remaining_credits into v_credit_id, v_remaining
  from user_credits
  where user_id = p_user_id and discipline_id = v_discipline_id
  order by created_at desc
  limit 1
  for update;

  if v_credit_id is null or coalesce(v_remaining, 0) <= 0 then
    raise exception 'El socio no tiene créditos disponibles para esta disciplina';
  end if;

  insert into bookings (user_id, class_id, booking_date) values (p_user_id, p_class_id, p_booking_date)
  returning id into v_booking_id;

  update user_credits set remaining_credits = remaining_credits - 1 where id = v_credit_id;

  insert into xp_events (user_id, event_type, xp_amount, reference_id, discipline_id, created_by)
  values (p_user_id, 'reserva', 100, v_booking_id, v_discipline_id, auth.uid())
  on conflict do nothing;

  return v_booking_id;
end;
$$;

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
  v_booking_id uuid;
  v_reserva_xp_id uuid;
  v_reserva_xp_amount int;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select discipline_id, start_time into v_discipline_id, v_start_time
  from classes where id = p_class_id;

  v_class_start := (p_booking_date::text || ' ' || v_start_time::text)::timestamp
    at time zone 'America/Argentina/Mendoza';
  v_dentro_del_limite := now() <= (v_class_start - interval '2 hours');

  delete from bookings
  where user_id = p_user_id and class_id = p_class_id and booking_date = p_booking_date
  returning id into v_booking_id;
  if not found then
    raise exception 'Ese socio no tenía una reserva en esta clase';
  end if;

  insert into booking_cancellations (user_id, class_id, booking_date, reason)
  values (p_user_id, p_class_id, p_booking_date, nullif(trim(p_reason), ''));

  select id, xp_amount into v_reserva_xp_id, v_reserva_xp_amount
  from xp_events
  where reference_id = v_booking_id and event_type = 'reserva';
  if v_reserva_xp_id is not null then
    insert into xp_events (user_id, event_type, xp_amount, reference_id, discipline_id, created_by)
    values (p_user_id, 'reversion', -v_reserva_xp_amount, v_reserva_xp_id, v_discipline_id, auth.uid());
  end if;

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

grant execute on function public.admin_book_class(uuid, uuid, date) to authenticated;
grant execute on function public.admin_cancel_booking(uuid, uuid, date, text) to authenticated;

-- ============================================================
-- Verificación rápida después de correr esto (logueado como socio en la PWA):
--   1. Reservar una clase -> Mi Perfil / Inicio deben reflejar +100 XP al instante.
--   2. Cancelarla -> el XP vuelve a bajar 100 (verificar sumando xp_events
--      del socio: select sum(xp_amount) from xp_events where user_id = '...').
--   3. Reservar y dejar que el Admin marque "Presente" -> +100 XP ADICIONALES
--      de asistencia (evento distinto, 'asistencia', no se pisan entre sí).
-- ============================================================
