-- =====================================================================================
-- ROLLBACK de supabase_migration_cancelacion_gimnasio_reintegro.sql. NO SE CORRIÓ.
--
-- Deja admin_cancel_booking y admin_cancelar_clase_dia EXACTAMENTE como están hoy en
-- producción (copiadas de GREENFIT/q0a_definiciones_produccion.sql, exportado el 07/10/2026)
-- y borra las 3 funciones nuevas. Solo funciones: ningún UPDATE/DELETE/INSERT de datos.
--
-- ORDEN: primero volver el Admin a la versión anterior (llama a admin_quitar_de_clase y
-- admin_cancelar_clase_dia_v2, que este script borra); después correr este script.
-- Los créditos que se hayan devuelto mientras estuvo la versión nueva NO se deshacen.
-- =====================================================================================

begin;

-- 1) Versiones de producción (sin dependencias de las funciones nuevas).
CREATE OR REPLACE FUNCTION public.admin_cancel_booking(p_user_id uuid, p_class_id uuid, p_booking_date date, p_reason text DEFAULT NULL::text, p_forzar_reintegro boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_discipline_id uuid;
  v_start_time time;
  v_booking_id uuid;
  v_credit_lote_id uuid;
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

  -- Se lee credit_lote_id ANTES de borrar la reserva (una vez borrada, ese
  -- dato ya no está en ningún lado). `for update` evita que un doble
  -- cancel casi simultáneo lea la misma fila dos veces.
  select id, credit_lote_id into v_booking_id, v_credit_lote_id
  from bookings
  where user_id = p_user_id and class_id = p_class_id and booking_date = p_booking_date
  for update;

  if v_booking_id is null then
    raise exception 'Ese socio no tenía una reserva en esta clase';
  end if;

  delete from bookings where id = v_booking_id;

  insert into booking_cancellations (user_id, class_id, booking_date, reason)
  values (p_user_id, p_class_id, p_booking_date, nullif(trim(p_reason), ''));

  if v_dentro_del_limite or p_forzar_reintegro then
    if v_credit_lote_id is not null then
      -- Reintegro preciso -- SOLO si el lote de origen sigue vigente. Un
      -- único UPDATE atómico (expires_at>now() y el +1 en la misma
      -- sentencia): si el lote ya venció no matchea ninguna fila y no se
      -- reintegra NADA, ni acá ni en otro lote, forzado o no.
      update user_credits
      set remaining_credits = remaining_credits + 1
      where id = v_credit_lote_id and expires_at > now();
    else
      -- Fallback -- reserva sin credit_lote_id (anterior al modelo de
      -- lotes): el lote VIGENTE que vence más pronto (FIFO).
      select id into v_credit_id
      from user_credits
      where user_id = p_user_id and discipline_id = v_discipline_id
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
$function$;

grant execute on function public.admin_cancel_booking(uuid, uuid, date, text, boolean) to authenticated;

CREATE OR REPLACE FUNCTION public.admin_cancelar_clase_dia(p_class_id uuid, p_occurrence_date date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_admin_id uuid := auth.uid();
  v_titulo_clase text;
  v_hora_inicio time;
  v_user_ids uuid[];
  v_user_id uuid;
  v_cancelados int := 0;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select title, start_time into v_titulo_clase, v_hora_inicio
  from classes where id = p_class_id;
  if v_titulo_clase is null then
    raise exception 'No existe esa clase.';
  end if;

  -- Idempotente -- si ya estaba cancelada (ej. doble click, o el admin la
  -- vuelve a tocar por error), no rompe -- solo actualiza quién la tocó.
  -- Para ese momento ya no debería haber bookings que cancelar (el loop de
  -- abajo simplemente no encuentra nada), así que reintentar es inofensivo.
  insert into class_occurrence_cancellations (class_id, occurrence_date, cancelled_by)
  values (p_class_id, p_occurrence_date, v_admin_id)
  on conflict (class_id, occurrence_date) do update
    set cancelled_by = excluded.cancelled_by;

  -- Materializado en un array ANTES de cancelar -- admin_cancel_booking()
  -- borra de `bookings` en cada vuelta del loop; re-consultar la tabla
  -- mientras se está vaciando (en vez de un array fijo de antemano) es
  -- justo el tipo de bug sutil que ya pasó una vez en este proyecto (ver
  -- supabase_migration_fix_admin_cancel_booking_lote_exacto.sql).
  select array_agg(user_id) into v_user_ids
  from bookings
  where class_id = p_class_id and booking_date = p_occurrence_date;

  if v_user_ids is not null then
    foreach v_user_id in array v_user_ids loop
      -- Mismo criterio que "Quitar de la clase" (InscriptosModal.jsx): es
      -- el gimnasio el que cancela, no el socio -- reintegro incondicional,
      -- sin importar el tiempo de gracia.
      perform public.admin_cancel_booking(
        v_user_id, p_class_id, p_occurrence_date, 'Clase cancelada por el gimnasio', true
      );
      v_cancelados := v_cancelados + 1;

      -- Notificación INDIVIDUAL por socio afectado -- a propósito NO
      -- audience_type='class' (eso resuelve destinatarios por bookings.
      -- class_id SIN filtrar por fecha, ver send-push/resolveUserIds --
      -- notificaría a cualquiera que alguna vez se anotó a esta clase
      -- recurrente, no solo a los de hoy). 'user' + target_user_id es el
      -- mismo patrón exacto que ya usa Anunciar.jsx para un socio puntual,
      -- solo que automatizado acá.
      insert into notifications (sender_id, audience_type, target_user_id, title, body)
      values (
        v_admin_id,
        'user',
        v_user_id,
        'Clase cancelada',
        format(
          '%s de las %s del %s fue cancelada por el gimnasio. Ya te reintegramos el crédito.',
          v_titulo_clase,
          to_char(v_hora_inicio, 'HH24:MI'),
          to_char(p_occurrence_date, 'DD/MM/YYYY')
        )
      );
    end loop;
  end if;

  return v_cancelados;
end;
$function$;

grant execute on function public.admin_cancelar_clase_dia(uuid, date) to authenticated;

-- 2) Las nuevas (ya nadie las llama).
drop function if exists public.admin_cancelar_clase_dia_v2(uuid, date);
drop function if exists public.admin_quitar_de_clase(uuid, uuid, date, text);
drop function if exists public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text);

commit;

-- Verificación (solo lectura): tienen que quedar las 2 de producción y ninguna nueva.
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc
-- where proname in ('admin_cancel_booking', 'admin_cancelar_clase_dia', 'admin_cancelar_clase_dia_v2',
--                   'admin_quitar_de_clase', '_cancelar_reserva_por_gimnasio') order by 1;
