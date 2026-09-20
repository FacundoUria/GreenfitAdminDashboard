-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- CONTEXTO (confirmado con Seba): hoy cancel_booking() (la del socio, PWA)
-- permite cancelar SIEMPRE, a cualquier hora -- el tiempo de gracia
-- (configuracion.limite_cancelacion_minutos) solo decidía si se reintegraba
-- el crédito, nunca si se podía cancelar. El pedido real es que, DENTRO de
-- esa ventana de minutos antes de la clase, la cancelación se BLOQUEE del
-- todo: la reserva queda como está, no se libera el cupo, no hay ningún
-- reintegro porque no hay ninguna cancelación.
--
-- CAMBIO: se agrega el chequeo de tiempo AL PRINCIPIO, ANTES de tocar
-- `bookings` -- reusa EXACTAMENTE el mismo cálculo de v_class_start/
-- v_dentro_del_limite que ya existía (ver supabase_migration_lotes_
-- creditos_fase2.sql). Fuera de la ventana: cancela y reintegra tal cual ya
-- funcionaba, sin ningún otro cambio (el bloque de reintegro por lote no se
-- toca -- queda tautológicamente "siempre true" después de este guard,
-- pero se deja intacto a propósito, mismo criterio de "no tocar lo que ya
-- funciona" que pidió el ticket).
--
-- NO TOCA admin_cancel_booking() -- Seba sigue pudiendo sacar a cualquiera
-- sin ninguna restricción de tiempo, exactamente como está hoy (ver
-- supabase_migration_fix_admin_cancel_booking_lote_exacto.sql, sin
-- cambios). Tampoco toca acreditar_pack, admin_acreditar_creditos_manual,
-- ni ningún camino de otorgar créditos.

create or replace function public.cancel_booking(p_class_id uuid, p_booking_date date, p_reason text default null)
returns boolean
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_discipline_id uuid;
  v_start_time time;
  v_booking_id uuid;
  v_credit_lote_id uuid;
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

  -- NUEVO -- bloquea la cancelación ENTERA (no solo el reintegro) si faltan
  -- menos de v_limite_minutos para que arranque la clase. Va ANTES de tocar
  -- `bookings`: si esto revienta, la reserva queda exactamente como estaba,
  -- sin liberar el cupo ni tocar ningún crédito.
  if not v_dentro_del_limite then
    raise exception 'No podés cancelar esta reserva -- faltan menos de % minutos para que empiece la clase.', v_limite_minutos;
  end if;

  -- Se lee credit_lote_id ANTES de borrar la reserva (una vez borrada, ese
  -- dato ya no está en ningún lado). `for update` para que un doble-cancel
  -- casi simultáneo no lea la misma fila dos veces antes de que la primera
  -- termine de borrarla.
  select id, credit_lote_id into v_booking_id, v_credit_lote_id
  from bookings
  where user_id = v_user_id and class_id = p_class_id and booking_date = p_booking_date
  for update;

  if v_booking_id is null then
    raise exception 'No tenías una reserva en esta clase';
  end if;

  delete from bookings where id = v_booking_id;

  insert into booking_cancellations (user_id, class_id, booking_date, reason)
  values (v_user_id, p_class_id, p_booking_date, nullif(trim(p_reason), ''));

  if v_dentro_del_limite then
    if v_credit_lote_id is not null then
      -- Reintegro preciso -- SOLO si el lote de origen sigue vigente. Es
      -- un único UPDATE atómico (la condición expires_at>now() y el
      -- +1 pasan en la misma sentencia) -- si no matchea ninguna fila
      -- (el lote ya venció), no se reintegra NADA, ni acá ni en otro lote.
      update user_credits
      set remaining_credits = remaining_credits + 1
      where id = v_credit_lote_id and expires_at > now();
    else
      -- Fallback -- reserva sin credit_lote_id (de antes de esta fase, o
      -- de Aparatos si algún día llegara a reservarse). Mismo criterio
      -- FIFO que el resto de la fase (no el "created_at desc" que existía
      -- antes de este cambio, a pedido explícito) -- el lote VIGENTE que
      -- vence más pronto. Sin ningún lote vigente, no hay a dónde
      -- reintegrar -- v_credit_id queda null y el `if` de abajo no hace nada.
      select id into v_credit_id
      from user_credits
      where user_id = v_user_id and discipline_id = v_discipline_id
        and expires_at > now()
      order by expires_at asc
      limit 1
      for update;

      if v_credit_id is not null then
        update user_credits set remaining_credits = remaining_credits + 1 where id = v_credit_id;
      end if;
    end if;
  end if;

  return v_dentro_del_limite;
end;
$$;

grant execute on function public.cancel_booking(uuid, date, text) to authenticated;

-- ============================================================
-- VERIFICACIÓN -- correr a mano con una reserva de PRUEBA.
-- ============================================================

-- 0) Confirmar el límite configurado hoy (los casos de abajo asumen que
-- conocés este valor -- ajustá los horarios de la clase de prueba en
-- consecuencia):
-- select limite_cancelacion_minutos from configuracion where id = 1;

-- CASO 1 -- FUERA de la ventana (clase arranca en más minutos que el
-- límite configurado): cancela y reintegra exactamente como antes.
-- select b.id, b.credit_lote_id, uc.remaining_credits, uc.expires_at
-- from bookings b left join user_credits uc on uc.id = b.credit_lote_id
-- where b.user_id = '<USER_ID_PRUEBA>' and b.class_id = '<CLASS_ID_LEJOS>' and b.booking_date = '<FECHA>';
--
-- select cancel_booking('<CLASS_ID_LEJOS>', '<FECHA>', 'prueba');
-- -- esperado (con la sesión de ese socio -- auth.uid() la resuelve sola):
-- -- devuelve `true` (si había un lote vigente) sin ninguna excepción.
--
-- select * from bookings where user_id = '<USER_ID_PRUEBA>' and class_id = '<CLASS_ID_LEJOS>' and booking_date = '<FECHA>';
-- -- esperado: 0 filas (se borró).
-- select remaining_credits from user_credits where id = '<LOTE_ORIGEN>';
-- -- esperado: +1 respecto del valor de arriba.

-- CASO 2 -- DENTRO de la ventana (clase arranca en menos minutos que el
-- límite configurado): rechaza, NO cancela nada.
-- select cancel_booking('<CLASS_ID_PRONTO>', '<FECHA>', 'prueba');
-- -- esperado: excepción "No podés cancelar esta reserva -- faltan menos de
-- -- <N> minutos para que empiece la clase." (con el número real
-- -- configurado, no un valor fijo).
--
-- select * from bookings where user_id = '<USER_ID_PRUEBA>' and class_id = '<CLASS_ID_PRONTO>' and booking_date = '<FECHA>';
-- -- esperado: SIGUE existiendo la reserva (1 fila) -- no se liberó el cupo.
-- select remaining_credits from user_credits where user_id = '<USER_ID_PRUEBA>';
-- -- esperado: NINGÚN cambio en ningún lote.

-- CASO 3 -- confirmar que admin_cancel_booking() NO cambió:
-- select pg_get_functiondef(oid) from pg_proc where proname = 'admin_cancel_booking';
-- -- comparar a mano contra supabase_migration_fix_admin_cancel_booking_lote_exacto.sql
-- -- (la versión vigente) -- tiene que coincidir exacto, sin este bloqueo.
-- -- Confirmar además que Seba SIGUE pudiendo sacar a alguien desde el panel
-- -- Admin faltando menos del límite configurado (esto no debería cambiar).
