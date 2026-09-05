-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA -- NI SIQUIERA EL PASO 0 (que es de solo lectura).
--
-- FASE B -- máxima cautela: esto toca book_class()/admin_book_class(), la
-- función que usa CADA reserva real de CADA socio, todos los días. A
-- diferencia de la Fase A (esta_habilitado_para_disciplina.sql, ya
-- validada contra 4 casos reales), acá SÍ se conecta el chequeo a un path
-- de escritura real.
--
-- ORDEN OBLIGATORIO -- no saltear pasos:
--   PASO 0 (solo lectura, ejecutar PRIMERO, HOY MISMO, sin tocar nada más):
--     mide cuántas reservas reales de los próximos 7 días quedarían
--     bloqueadas si el PASO 1 ya estuviera activo. esta_habilitado_para_
--     disciplina() ya está en producción (Fase A) -- este paso no necesita
--     que se aplique nada más para correr.
--   PASO 1 (escritura -- NO CORRER hasta revisar el resultado del PASO 0
--     con Facundo/Seba): reemplaza book_class()/admin_book_class() para
--     agregar el chequeo.
--   PASO 2: verificación manual después de aplicar el PASO 1.
--
-- Si el PASO 0 devuelve algún socio afectado, NO se aplica el PASO 1 sin
-- antes decidir qué hacer con esos casos puntuales (¿son de verdad
-- vencidos y corresponde bloquearlos, o son otro síntoma del bug de
-- desincronización de la fase de investigación que hay que corregir en los
-- DATOS antes de activar el gate?).

-- ============================================================
-- PASO 0 -- Query de impacto (SOLO LECTURA, no modifica nada).
-- Corré esto ANTES de tocar cualquier otra cosa de este archivo.
-- ============================================================

-- 0.a) El número que pediste: cuántos socios (y cuántas reservas puntuales)
--      con una reserva activa HOY o en los próximos 7 días quedarían
--      bloqueados si esta_habilitado_para_disciplina() ya estuviera
--      conectada a book_class(). Una reserva por booking+disciplina --si
--      el mismo socio tiene 2 reservas de la misma disciplina vencida en
--      la semana, cuenta como 1 socio pero 2 reservas.
select
  count(distinct b.user_id) as socios_afectados,
  count(*) as reservas_afectadas
from bookings b
join classes c on c.id = b.class_id
where b.booking_date between current_date and current_date + interval '7 days'
  and not public.esta_habilitado_para_disciplina(b.user_id, c.discipline_id);

-- 0.b) Si el número de arriba NO es cero, el detalle -- nombre, DNI,
--      disciplina y fecha de la reserva puntual que quedaría bloqueada,
--      para poder decidir caso por caso antes de aplicar nada.
select
  p.full_name,
  p.dni,
  d.name as disciplina,
  d.kind,
  c.title as clase,
  b.booking_date,
  b.id as booking_id
from bookings b
join classes c on c.id = b.class_id
join disciplines d on d.id = c.discipline_id
join profiles p on p.id = b.user_id
where b.booking_date between current_date and current_date + interval '7 days'
  and not public.esta_habilitado_para_disciplina(b.user_id, c.discipline_id)
order by b.booking_date, p.full_name;

-- ============================================================
-- PASO 1 -- Conectar el chequeo a book_class()/admin_book_class().
-- NO CORRER todavía -- solo después de revisar el resultado del PASO 0.
--
-- Único cambio real respecto de la versión vigente
-- (supabase_migration_xp_reserva_configurable.sql): una llamada nueva a
-- esta_habilitado_para_disciplina(), agregada INMEDIATAMENTE DESPUÉS de
-- resolver v_discipline_id (ya sabemos qué clase es y de qué disciplina),
-- y ANTES de cualquier otra cosa -- antes del chequeo de día de la semana,
-- antes del chequeo de cupo, antes de tocar bookings o user_credits para
-- nada. El resto de la función (locking con `for update`, chequeo de
-- cupo, chequeo de créditos actual, XP configurable) queda IDÉNTICO, no se
-- reordena ni se toca nada más -- esto es un chequeo ADICIONAL, no un
-- reemplazo del que ya existe.
-- ============================================================

-- 1) book_class() -- el socio reserva para sí mismo.
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

  -- NUEVO -- chequeo de vencimiento centralizado (ver
  -- supabase_migration_esta_habilitado_para_disciplina.sql). Va acá,
  -- apenas se conoce v_discipline_id y ANTES de tocar bookings/
  -- user_credits para nada -- ni el cupo ni el crédito importan si el
  -- socio está vencido para esta disciplina.
  if not public.esta_habilitado_para_disciplina(v_user_id, v_discipline_id) then
    raise exception 'Tu plan/créditos para esta disciplina están vencidos. No podés reservar hasta regularizar tu situación.';
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

-- 2) admin_book_class() -- el admin reserva en nombre de un socio.
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

  -- NUEVO -- mismo chequeo que book_class(), con p_user_id (el socio en
  -- cuyo nombre reserva el admin) en vez de v_user_id.
  if not public.esta_habilitado_para_disciplina(p_user_id, v_discipline_id) then
    raise exception 'Tu plan/créditos para esta disciplina están vencidos. No podés reservar hasta regularizar tu situación.';
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

-- ============================================================
-- PASO 2 -- Verificación manual después de aplicar el PASO 1.
-- ============================================================

-- 2.a) Camino feliz -- un socio AL DÍA (mismo que usaste para validar
--      esta_habilitado_para_disciplina en la Fase A) tiene que poder
--      seguir reservando exactamente igual que hoy, sin ningún cambio de
--      comportamiento. Probar de punta a punta desde la PWA real (no solo
--      SQL): loguearse como ese socio, reservar una clase de una
--      disciplina donde esté al día, confirmar que la reserva se crea, el
--      crédito se descuenta y el XP se otorga como siempre.

-- 2.b) Camino bloqueado -- con un socio vencido (Emilio Camargo, o el
--      socio de prueba de créditos vencidos de la Fase A), intentar
--      reservar una clase de esa disciplina puntual DEBE fallar con
--      exactamente este mensaje (probar desde la PWA -- confirmar que se
--      ve tal cual en el modal de error, no un mensaje técnico de
--      Postgres):
--      "Tu plan/créditos para esta disciplina están vencidos. No podés
--      reservar hasta regularizar tu situación."
--      Confirmar en la base que NO se creó la reserva, NO se descontó
--      crédito y NO se otorgó XP:
-- select * from bookings where user_id = '<USER_ID_VENCIDO>' and booking_date = '<FECHA DE PRUEBA>';
--      -- tiene que devolver 0 filas.
-- select remaining_credits from user_credits where user_id = '<USER_ID_VENCIDO>' and discipline_id = '<DISCIPLINE_ID>' order by created_at desc limit 1;
--      -- tiene que ser el mismo valor de ANTES del intento (no bajó).
-- select * from xp_events where user_id = '<USER_ID_VENCIDO>' and event_type = 'reserva' order by created_at desc limit 1;
--      -- no tiene que aparecer un evento nuevo por este intento.

-- 2.c) admin_book_class() -- repetir 2.a y 2.b pero reservando DESDE EL
--      PANEL ADMIN en nombre de esos mismos dos socios (al día / vencido),
--      confirmando el mismo comportamiento en ambos sentidos.

-- 2.d) Regresión rápida de lo que NO debería haber cambiado: cupo lleno
--      sigue dando "Sin cupo", día que no corresponde sigue dando "Esta
--      clase no se dicta ese día.", créditos en 0 (pero no vencidos) sigue
--      dando "Sin créditos disponibles para esta disciplina" -- los 3
--      mensajes y el orden de prioridad entre ellos no cambiaron.
