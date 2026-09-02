-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- Bug real (detectado en la auditoría): "+100 XP al reservar" estaba
-- hardcodeado como literal `100` dentro de las funciones SQL, en vez de
-- salir de `configuracion` (mismo criterio que B2 con el tiempo de
-- gracia de cancelación) -- para cambiar la economía del juego había que
-- editar el número a mano en SQL, repetido en más de un lugar.
--
-- Verificado ANTES de escribir esto (búsqueda real, no la suposición
-- original del ticket): el literal `100` para la regla "reserva" solo
-- aparece de verdad, hardcodeado, en DOS funciones -- book_class() y
-- admin_book_class() (supabase_migration_xp_reserva.sql). Las otras dos
-- funciones que participan de este mismo mecanismo -- cancel_booking() y
-- admin_cancel_booking() -- NO tienen ningún literal `100`: revierten
-- dinámicamente lo que sea que se haya otorgado en su momento
-- (`-v_reserva_xp_amount`, releído de la fila real de xp_events vía
-- reference_id), así que ya quedan correctas automáticamente sin tocarlas
-- -- si el monto de reserva cambia, la reversión al cancelar cambia sola
-- con él, porque lee el monto real que se otorgó, no un número fijo.
--
-- Fuera de alcance a propósito (no se toca en este script): existen OTROS
-- literales `100` de XP en el sistema, para reglas DISTINTAS de
-- "reservar" -- asistencia real (supabase_migration_xp_disciplina.sql),
-- Check-in Rápido de Aparatos, y "Hoy Entrené"
-- (supabase_migration_hoy_entrene.sql). Ninguna de esas se toca acá; si
-- se quiere el mismo tratamiento para ellas, es un cambio aparte.
--
-- Tampoco se toca la PWA: XpInfoModal.tsx ("¿Cómo ganar XP?") sigue
-- mostrando "+100 XP" como texto fijo -- si Seba cambia
-- xp_por_reserva desde Configuración, ese texto queda desactualizado
-- hasta que se haga un cambio aparte para que la PWA lo lea también. Se
-- deja documentado a propósito, no es un olvido.

-- 1) Columna nueva -- default 100 preserva el comportamiento actual
--    exacto (cero cambio de conducta hasta que alguien la edite desde
--    Configuración).
alter table public.configuracion
  add column if not exists xp_por_reserva integer not null default 100;

-- 2) book_class() -- el socio reserva para sí mismo.
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
  v_xp_reserva int;
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
  -- pack de Boxeo, no del de Kickstrike aunque el socio tenga los dos.
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

  -- XP por reservar (configurable, ver configuracion.xp_por_reserva) --
  -- con fallback defensivo a 100 (el valor que ya estaba hardcodeado) si
  -- algo falla al leerlo.
  begin
    select coalesce(xp_por_reserva, 100) into v_xp_reserva from configuracion where id = 1;
  exception when others then
    v_xp_reserva := null;
  end;
  if v_xp_reserva is null then
    v_xp_reserva := 100;
  end if;

  insert into xp_events (user_id, event_type, xp_amount, reference_id, discipline_id, created_by)
  values (v_user_id, 'reserva', v_xp_reserva, v_booking_id, v_discipline_id, v_user_id)
  on conflict do nothing;

  return v_booking_id;
end;
$$;

grant execute on function public.book_class(uuid, date) to authenticated;

-- 3) admin_book_class() -- el admin reserva en nombre de un socio.
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
  v_xp_reserva int;
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

  begin
    select coalesce(xp_por_reserva, 100) into v_xp_reserva from configuracion where id = 1;
  exception when others then
    v_xp_reserva := null;
  end;
  if v_xp_reserva is null then
    v_xp_reserva := 100;
  end if;

  insert into xp_events (user_id, event_type, xp_amount, reference_id, discipline_id, created_by)
  values (p_user_id, 'reserva', v_xp_reserva, v_booking_id, v_discipline_id, auth.uid())
  on conflict do nothing;

  return v_booking_id;
end;
$$;

grant execute on function public.admin_book_class(uuid, uuid, date) to authenticated;

-- ── Verificación (opcional, después de correr lo de arriba) ────────────────
-- select xp_por_reserva from configuracion where id = 1; -- 100 recién corrido esto
-- Cambiar "XP por reservar una clase" desde Configuración a, ej. 50, y
-- reservar una clase de prueba desde la PWA -- confirmar en xp_events:
-- select event_type, xp_amount from xp_events where reference_id = '<id de esa reserva>';
-- -- tiene que dar 50, no 100. Cancelar esa misma reserva a tiempo y
-- confirmar que la fila 'reversion' da -50 (no -100) -- se lee sola del
-- monto real otorgado, sin tocar cancel_booking().
