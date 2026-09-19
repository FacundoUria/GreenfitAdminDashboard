-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- !! SUPERADA por supabase_migration_fix_admin_cancel_booking_lote_exacto.sql !!
-- Este archivo se escribió sobre la versión de admin_cancel_booking() del 2/9
-- (pre-lotes): su bloque de reintegro usa "created_at desc" sin filtrar
-- vigencia. NO volver a correrlo -- la versión correcta (con credit_lote_id
-- y p_forzar_reintegro) es la del archivo de fix.
--
-- CONTEXTO: "Quitar de la clase" (InscriptosModal.jsx, botón UserMinus, ya
-- en producción) llama a admin_cancel_booking() -- que hasta ahora
-- reintegraba el crédito con el MISMO criterio que cancel_booking() (la que
-- usa el socio al cancelarse solo desde la PWA): solo si quedaba tiempo
-- suficiente según `configuracion.limite_cancelacion_minutos` (tiempo de
-- gracia, ver supabase_migration_cancel_booking_configurable.sql). Eso está
-- bien cuando el socio cancela tarde por su cuenta, pero no tiene sentido
-- cuando es Seba quien saca a alguien desde el Admin por cualquier otro
-- motivo (error de anotación, corrección de cupo, etc.) -- ahí el socio no
-- debería perder el crédito solo porque faltaba poco para la clase.
--
-- CAMBIO: admin_cancel_booking() suma un parámetro
-- `p_forzar_reintegro boolean default false`. Si es true, reintegra el
-- crédito SIEMPRE, sin mirar el tiempo de gracia -- pero sigue devolviendo
-- `v_dentro_del_limite` igual (por si el frontend lo usa para otra cosa,
-- ej. un mensaje distinto). El default `false` preserva el comportamiento
-- actual para cualquier otro caller que no pase el parámetro.
--
-- NO se toca cancel_booking() (la que usa el socio desde la PWA) -- sigue
-- exactamente igual, con el tiempo de gracia normal. El resto del body de
-- admin_cancel_booking() (validar admin, borrar booking, loguear en
-- booking_cancellations, lectura de configuracion con fallback a 120 min)
-- tampoco cambia -- único agregado es la condición del reintegro.

drop function if exists public.admin_cancel_booking(uuid, uuid, date, text);

create or replace function public.admin_cancel_booking(
  p_user_id uuid,
  p_class_id uuid,
  p_booking_date date,
  p_reason text default null,
  p_forzar_reintegro boolean default false
)
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
  -- defensivo a 120 minutos si algo de esta lectura falla por cualquier
  -- motivo. Se sigue calculando siempre (no solo si p_forzar_reintegro es
  -- false) porque `v_dentro_del_limite` se devuelve igual en los dos casos.
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

  -- Único cambio real: con p_forzar_reintegro=true el reintegro no depende
  -- de v_dentro_del_limite -- se hace siempre que haya un lote real al que
  -- devolverle el crédito.
  if v_dentro_del_limite or p_forzar_reintegro then
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

grant execute on function public.admin_cancel_booking(uuid, uuid, date, text, boolean) to authenticated;

-- ── Verificación (opcional, después de correr lo de arriba) ────────────────
-- 1) Confirmar que cancel_booking() (la de la PWA) NO cambió -- ni firma ni
-- comportamiento:
--    select pg_get_functiondef(oid) from pg_proc where proname = 'cancel_booking';
--    -- tiene que seguir siendo (uuid, date, text), sin p_forzar_reintegro.
--
-- 2) Caso real del ticket -- reserva de prueba cuya clase arranque en 10
-- minutos, con el tiempo de gracia en 120 (o cualquier valor > 10):
--    select admin_cancel_booking('<USER_ID_PRUEBA>', '<CLASS_ID_PRUEBA>', '<FECHA>', 'prueba', true);
--    -- esperado: devuelve `false` (v_dentro_del_limite, porque 10 min <
--    -- tiempo de gracia) PERO el crédito SÍ se reintegra (a diferencia de
--    -- antes, donde con `false` no reintegraba nada).
--    select remaining_credits from user_credits where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID_PRUEBA>';
--
-- 3) Mismo caso pero SIN pasar p_forzar_reintegro (o pasando false
-- explícito) -- confirma que el comportamiento viejo sigue disponible para
-- cualquier otro caller futuro:
--    select admin_cancel_booking('<USER_ID_PRUEBA_2>', '<CLASS_ID_PRUEBA>', '<FECHA>', 'prueba', false);
--    -- esperado: devuelve `false` y NO reintegra (igual que antes de este
--    -- cambio).
