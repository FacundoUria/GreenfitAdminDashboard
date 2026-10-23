-- =====================================================================================
-- Tanda 2 -- Reintegro de créditos cuando CANCELA EL GIMNASIO ("Quitar de la clase" o
-- "Cancelar la clase del día"). NO SE CORRIÓ TODAVÍA. ESTAMOS EN PRODUCCIÓN.
--
-- Regla de oro: esta migración SOLO crea / reemplaza funciones. No hay ningún UPDATE,
-- DELETE ni INSERT sobre datos existentes. Aplica de acá en adelante.
--
-- NO se toca cancel_booking() (cuando cancela EL SOCIO desde la PWA). Su huella tiene que
-- seguir siendo la misma (ver verificación al final):
--   md5(pg_get_functiondef) = afcc5c25de7f16c3f5a657254c9937ba
--
-- Qué hace cuando cancela el gimnasio, por cada reserva (en este orden):
--   1) El lote de la reserva pertenece a un PAGO ANULADO -> NO se devuelve.
--      Se detecta por pagos_socio.estado = 'anulado' y
--        - detalle_acreditacion->'reversion'->'filas_vencidas'[].user_credit_id  (regla F), o
--        - detalle_acreditacion->'creditos'[].lote_id  (reversiones anteriores a la regla F,
--          que no vencían el lote: puede seguir "vigente").
--   2) El lote de la reserva está vigente (expires_at > now()) -> +1 a ese mismo lote.
--   3) El lote venció o lo reseteó un pago nuevo (no anulado) -> +1 al lote VIGENTE de esa
--      disciplina que vence antes (con su fecha), sin contar lotes de pagos anulados. Si no
--      hay ninguno vigente, no se devuelve. (Decisión D1 = O1.)
--   4) Reserva vieja sin credit_lote_id -> +1 al lote VIGENTE de esa disciplina que vence
--      antes, sin contar lotes de pagos anulados. Si no hay ninguno, no se devuelve.
--   0) (antes que todo) La clase es de Aparatos (disciplines.kind = 'membership') -> NO se
--      toca remaining_credits: Aparatos no usa créditos. Motivo aparatos_sin_creditos; el
--      aviso dice hasta cuándo sigue el acceso, o que no tiene acceso vigente.
--   Siempre, sin importar el límite de minutos. Nunca se crea una fila nueva de créditos.
--
-- Fecha "vence el" de los avisos: misma fórmula que la PWA (formatShortDate, dateFormat.ts):
-- el día calendario de expires_at en 'America/Argentina/Mendoza', como DD/MM/YYYY. Para
-- Aparatos, la fila vigente que vence más tarde (igual que fetchUserBalances en creditsApi.ts).
--
-- Las notificaciones al socio y los mensajes a Seba dicen SIEMPRE qué pasó con el crédito.
-- "Quitar de la clase" ahora también avisa al socio (decisión D2 = N2).
--
-- Funciones:
--   _cancelar_reserva_por_gimnasio  NUEVA, interna, sin EXECUTE para public/anon/authenticated.
--   admin_quitar_de_clase           NUEVA (la usa "Quitar de la clase"), authenticated.
--   admin_cancelar_clase_dia_v2     NUEVA (la usa "Cancelar clase", devuelve el resumen), authenticated.
--   admin_cancel_booking            MISMA firma y respuesta. Con p_forzar_reintegro=true usa
--                                   las reglas nuevas; con false queda EXACTAMENTE como hoy.
--   admin_cancelar_clase_dia        MISMA firma y respuesta (int). Pasa por la v2: una pestaña
--                                   vieja del Admin sigue andando y ya no le miente al socio.
-- Permisos: create or replace conserva los de las funciones existentes (no se toca anon).
-- A las NUEVAS públicas se les da EXECUTE a authenticated y se les saca a public y anon.
--
-- Rollback: rollback_cancelacion_gimnasio_reintegro.sql (versiones actuales de producción).
-- Orden de despliegue: 1) esta migración, 2) el Admin. Rollback: 1) Admin, 2) SQL.
-- =====================================================================================

-- ─────────────────────────────────────────────────────────────────────────────────────
-- 1) Interna: cancela UNA reserva por decisión del gimnasio y devuelve qué pasó.
--    p_contexto: 'quitar' (Quitar de la clase) | 'clase_cancelada' (Cancelar la clase del día)
--    Devuelve jsonb: user_id, nombre, reintegrado, motivo, lote_id, vence (YYYY-MM-DD),
--                    mensaje_socio, mensaje_admin.
--    motivo: reintegrado | reintegrado_otro_lote | reintegrado_fifo | pago_anulado | sin_lote_vigente
--            | aparatos_sin_creditos (no es un crédito: reintegrado = false)
-- ─────────────────────────────────────────────────────────────────────────────────────
create or replace function public._cancelar_reserva_por_gimnasio(
  p_user_id uuid,
  p_class_id uuid,
  p_booking_date date,
  p_reason text,
  p_contexto text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  v_titulo text;
  v_hora time;
  v_discipline_id uuid;
  v_disciplina text;
  v_kind text;
  v_nombre text;
  v_booking_id uuid;
  v_credit_lote_id uuid;
  v_pago_anulado_fecha timestamptz;
  v_destino uuid;
  v_vence timestamptz;
  v_motivo text;
  v_fecha_txt text;
  v_hora_txt text;
  v_vence_txt text;
  v_inicio_socio text;
  v_mensaje_socio text;
  v_mensaje_admin text;
begin
  if p_contexto not in ('quitar', 'clase_cancelada') then
    raise exception 'p_contexto inválido: %', p_contexto;
  end if;

  select c.title, c.start_time, c.discipline_id, d.name, d.kind
    into v_titulo, v_hora, v_discipline_id, v_disciplina, v_kind
  from classes c
  left join disciplines d on d.id = c.discipline_id
  where c.id = p_class_id;
  if v_titulo is null then
    raise exception 'No existe esa clase.';
  end if;

  select full_name into v_nombre from profiles where id = p_user_id;

  -- Mismo orden que hoy: se lee credit_lote_id ANTES de borrar la reserva.
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

  -- ── 1) ¿El lote es de un pago anulado? (regla F o anterior) ──
  if v_kind is distinct from 'membership' and v_credit_lote_id is not null then
    select p.created_at into v_pago_anulado_fecha
    from pagos_socio p
    where p.estado = 'anulado'
      and p.user_id = p_user_id
      and (
        coalesce(p.detalle_acreditacion->'reversion'->'filas_vencidas', '[]'::jsonb)
          @> jsonb_build_array(jsonb_build_object('user_credit_id', v_credit_lote_id::text))
        or coalesce(p.detalle_acreditacion->'creditos', '[]'::jsonb)
          @> jsonb_build_array(jsonb_build_object('lote_id', v_credit_lote_id::text))
      )
    order by p.created_at desc
    limit 1;
  end if;

  if v_kind = 'membership' then
    -- ── 0) Aparatos: no usa créditos, no se toca nada. Solo se averigua hasta cuándo
    -- sigue el acceso (la fila vigente que vence más tarde, igual que la PWA). ──
    v_motivo := 'aparatos_sin_creditos';
    select max(expires_at) into v_vence
    from user_credits
    where user_id = p_user_id and discipline_id = v_discipline_id and expires_at > now();
  elsif v_pago_anulado_fecha is not null then
    v_motivo := 'pago_anulado';
  else
    -- ── 2) Lote de la reserva vigente: +1 a ese mismo lote (un UPDATE atómico). ──
    if v_credit_lote_id is not null then
      update user_credits
      set remaining_credits = remaining_credits + 1
      where id = v_credit_lote_id and expires_at > now()
      returning id, expires_at into v_destino, v_vence;
    end if;

    if v_destino is not null then
      v_motivo := 'reintegrado';
    else
      -- ── 3) / 4) Lote vencido o reseteado, o reserva sin lote: el lote VIGENTE de esa
      -- disciplina que vence antes, sin contar lotes de pagos anulados. ──
      select uc.id into v_destino
      from user_credits uc
      where uc.user_id = p_user_id
        and uc.discipline_id = v_discipline_id
        and uc.expires_at > now()
        and not exists (
          select 1 from pagos_socio p
          where p.estado = 'anulado'
            and p.user_id = p_user_id
            and (
              coalesce(p.detalle_acreditacion->'reversion'->'filas_vencidas', '[]'::jsonb)
                @> jsonb_build_array(jsonb_build_object('user_credit_id', uc.id::text))
              or coalesce(p.detalle_acreditacion->'creditos', '[]'::jsonb)
                @> jsonb_build_array(jsonb_build_object('lote_id', uc.id::text))
            )
        )
      order by uc.expires_at asc
      limit 1
      for update of uc;

      if v_destino is not null then
        update user_credits
        set remaining_credits = remaining_credits + 1
        where id = v_destino
        returning expires_at into v_vence;
        v_motivo := case when v_credit_lote_id is null then 'reintegrado_fifo' else 'reintegrado_otro_lote' end;
      else
        v_motivo := 'sin_lote_vigente';
      end if;
    end if;
  end if;

  -- ── Mensajes: siempre la verdad sobre el crédito. ──
  v_fecha_txt := to_char(p_booking_date, 'DD/MM/YYYY');
  v_hora_txt := to_char(v_hora, 'HH24:MI');
  v_vence_txt := to_char((v_vence at time zone c_zona)::date, 'DD/MM/YYYY');
  v_disciplina := coalesce(v_disciplina, v_titulo);
  v_nombre := coalesce(v_nombre, 'Socio');

  v_inicio_socio := case p_contexto
    when 'quitar' then format('El gimnasio te quitó de %s de las %s del %s.', v_titulo, v_hora_txt, v_fecha_txt)
    else format('%s de las %s del %s fue cancelada por el gimnasio.', v_titulo, v_hora_txt, v_fecha_txt)
  end;

  if v_motivo = 'aparatos_sin_creditos' then
    v_mensaje_socio := case
      when v_vence is not null then format('%s %s no usa créditos: tu acceso sigue igual hasta el %s.', v_inicio_socio, v_disciplina, v_vence_txt)
      else format('%s %s no usa créditos y hoy no tenés acceso vigente a %s. Consultá con el gimnasio.', v_inicio_socio, v_disciplina, v_disciplina)
    end;
  elsif v_motivo in ('reintegrado', 'reintegrado_otro_lote', 'reintegrado_fifo') then
    v_mensaje_socio := format('%s Te devolvimos el crédito (vence el %s).', v_inicio_socio, v_vence_txt);
  elsif v_motivo = 'pago_anulado' then
    v_mensaje_socio := case p_contexto
      when 'quitar' then format('El gimnasio te quitó de la clase del %s. Ese crédito no se reintegró porque pertenecía a un pago anulado. Consultá con el gimnasio.', v_fecha_txt)
      else format('La clase del %s se canceló. Ese crédito no se reintegró porque pertenecía a un pago anulado. Consultá con el gimnasio.', v_fecha_txt)
    end;
  else
    v_mensaje_socio := format('%s Ese crédito no se reintegró porque no tenés créditos vigentes de %s. Consultá con el gimnasio.', v_inicio_socio, v_disciplina);
  end if;

  v_mensaje_admin := case v_motivo
    when 'aparatos_sin_creditos' then case
      when v_vence is not null then format('%s: %s no usa créditos, no había nada que devolver; su acceso sigue igual hasta el %s.', v_nombre, v_disciplina, v_vence_txt)
      else format('%s: %s no usa créditos, no había nada que devolver; no tiene acceso vigente a %s.', v_nombre, v_disciplina, v_disciplina)
    end
    when 'reintegrado' then format('%s: crédito devuelto (vence el %s).', v_nombre, v_vence_txt)
    when 'reintegrado_otro_lote' then format('%s: su lote original ya estaba vencido o lo reemplazó un pago posterior; el crédito se sumó a su lote vigente de %s (vence el %s).', v_nombre, v_disciplina, v_vence_txt)
    when 'reintegrado_fifo' then format('%s: crédito devuelto a su lote vigente de %s (vence el %s).', v_nombre, v_disciplina, v_vence_txt)
    when 'pago_anulado' then format('%s: NO se devolvió el crédito, era de un pago anulado (del %s). Si querés, cargáselo a mano con los créditos manuales.', v_nombre, to_char((v_pago_anulado_fecha at time zone c_zona)::date, 'DD/MM/YYYY'))
    else format('%s: NO se devolvió el crédito, no tiene créditos vigentes de %s. Si querés, cargáselo a mano con los créditos manuales.', v_nombre, v_disciplina)
  end;

  return jsonb_build_object(
    'user_id', p_user_id,
    'nombre', v_nombre,
    'reintegrado', v_motivo in ('reintegrado', 'reintegrado_otro_lote', 'reintegrado_fifo'),
    'motivo', v_motivo,
    'lote_id', v_destino,
    'vence', (v_vence at time zone c_zona)::date,
    'mensaje_socio', v_mensaje_socio,
    'mensaje_admin', v_mensaje_admin
  );
end;
$function$;

revoke all on function public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text) from public;
revoke all on function public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text) from anon;
revoke all on function public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text) from authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────
-- 2) NUEVA: "Quitar de la clase". Avisa SIEMPRE al socio con el texto de su caso.
-- ─────────────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_quitar_de_clase(
  p_user_id uuid,
  p_class_id uuid,
  p_booking_date date,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_resultado jsonb;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  v_resultado := public._cancelar_reserva_por_gimnasio(p_user_id, p_class_id, p_booking_date, p_reason, 'quitar');

  insert into notifications (sender_id, audience_type, target_user_id, title, body)
  values (auth.uid(), 'user', p_user_id, 'Cambio en tu reserva', v_resultado->>'mensaje_socio');

  return v_resultado;
end;
$function$;

revoke all on function public.admin_quitar_de_clase(uuid, uuid, date, text) from public;
revoke all on function public.admin_quitar_de_clase(uuid, uuid, date, text) from anon;
grant execute on function public.admin_quitar_de_clase(uuid, uuid, date, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────
-- 3) NUEVA: "Cancelar la clase del día", con resumen para Seba.
--    Devuelve jsonb: cancelados, reintegrados, no_reintegrados (array), aparatos (array),
--                    detalle (array, uno por socio).
-- ─────────────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_cancelar_clase_dia_v2(
  p_class_id uuid,
  p_occurrence_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_admin_id uuid := auth.uid();
  v_user_ids uuid[];
  v_user_id uuid;
  v_resultado jsonb;
  v_detalle jsonb := '[]'::jsonb;
  v_cancelados int := 0;
  v_reintegrados int := 0;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  if not exists (select 1 from classes where id = p_class_id) then
    raise exception 'No existe esa clase.';
  end if;

  -- Igual que hoy: idempotente, marca la ocurrencia como cancelada.
  insert into class_occurrence_cancellations (class_id, occurrence_date, cancelled_by)
  values (p_class_id, p_occurrence_date, v_admin_id)
  on conflict (class_id, occurrence_date) do update
    set cancelled_by = excluded.cancelled_by;

  -- Igual que hoy: materializado ANTES de cancelar.
  select array_agg(user_id) into v_user_ids
  from bookings
  where class_id = p_class_id and booking_date = p_occurrence_date;

  if v_user_ids is not null then
    foreach v_user_id in array v_user_ids loop
      v_resultado := public._cancelar_reserva_por_gimnasio(
        v_user_id, p_class_id, p_occurrence_date, 'Clase cancelada por el gimnasio', 'clase_cancelada'
      );
      v_cancelados := v_cancelados + 1;
      if (v_resultado->>'reintegrado')::boolean then
        v_reintegrados := v_reintegrados + 1;
      end if;
      v_detalle := v_detalle || jsonb_build_array(v_resultado);

      -- Notificación INDIVIDUAL, con el texto de SU caso (antes: "Ya te reintegramos el
      -- crédito" a todos, se hubiera devuelto o no).
      insert into notifications (sender_id, audience_type, target_user_id, title, body)
      values (v_admin_id, 'user', v_user_id, 'Clase cancelada', v_resultado->>'mensaje_socio');
    end loop;
  end if;

  return jsonb_build_object(
    'cancelados', v_cancelados,
    'reintegrados', v_reintegrados,
    -- Créditos que NO se devolvieron (Aparatos va aparte: no usa créditos).
    'no_reintegrados', coalesce(
      (select jsonb_agg(e) from jsonb_array_elements(v_detalle) e
       where not (e->>'reintegrado')::boolean and e->>'motivo' <> 'aparatos_sin_creditos'),
      '[]'::jsonb
    ),
    'aparatos', coalesce(
      (select jsonb_agg(e) from jsonb_array_elements(v_detalle) e where e->>'motivo' = 'aparatos_sin_creditos'),
      '[]'::jsonb
    ),
    'detalle', v_detalle
  );
end;
$function$;

revoke all on function public.admin_cancelar_clase_dia_v2(uuid, date) from public;
revoke all on function public.admin_cancelar_clase_dia_v2(uuid, date) from anon;
grant execute on function public.admin_cancelar_clase_dia_v2(uuid, date) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────
-- 4) EXISTENTE, misma firma y respuesta. Con p_forzar_reintegro = true (lo que usa el
--    gimnasio) aplica las reglas nuevas; con false, el código de producción tal cual.
--    No notifica (igual que hoy): la notificación la deja admin_quitar_de_clase.
-- ─────────────────────────────────────────────────────────────────────────────────────
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
as $function$
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

  -- NUEVO: cancela el gimnasio -> reglas de reintegro de la tanda 2.
  if p_forzar_reintegro then
    perform public._cancelar_reserva_por_gimnasio(p_user_id, p_class_id, p_booking_date, p_reason, 'quitar');
    return v_dentro_del_limite;
  end if;

  -- Sin forzar: EXACTAMENTE el código de producción (nadie lo llama así hoy).
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
      update user_credits
      set remaining_credits = remaining_credits + 1
      where id = v_credit_lote_id and expires_at > now();
    else
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

-- ─────────────────────────────────────────────────────────────────────────────────────
-- 5) EXISTENTE, misma firma y respuesta (int = cantidad de reservas canceladas).
-- ─────────────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_cancelar_clase_dia(p_class_id uuid, p_occurrence_date date)
returns integer
language plpgsql
security definer
as $function$
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  return (public.admin_cancelar_clase_dia_v2(p_class_id, p_occurrence_date)->>'cancelados')::int;
end;
$function$;

grant execute on function public.admin_cancelar_clase_dia(uuid, date) to authenticated;

-- =====================================================================================
-- VERIFICACIÓN después de correrla (solo lectura). Con datos: prueba_cancelacion_gimnasio.sql
-- =====================================================================================
-- a) cancel_booking NO cambió (tiene que dar afcc5c25de7f16c3f5a657254c9937ba):
-- select md5(pg_get_functiondef(oid)) from pg_proc where proname = 'cancel_booking';
--
-- b) Permisos:
-- select p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'execute') as puede
-- from pg_proc p cross join pg_roles r
-- where p.proname in ('_cancelar_reserva_por_gimnasio', 'admin_quitar_de_clase', 'admin_cancelar_clase_dia_v2',
--                     'admin_cancel_booking', 'admin_cancelar_clase_dia', 'cancel_booking')
--   and r.rolname in ('anon', 'authenticated')
-- order by 1, 2;
-- -- esperado: _cancelar_reserva_por_gimnasio false/false; las admin_* nuevas: anon false,
-- -- authenticated true; las existentes: igual que antes de la migración.
