-- =====================================================================================
-- T4 -- cancelar una reserva dice la verdad sobre el crédito. NO SE CORRIÓ TODAVÍA.
-- ESTAMOS EN PRODUCCIÓN.
--
-- "Lote del plan": un lote vigente cuyo día en Argentina (ultimo_dia_plan) es el mismo que el
-- de fecha_plan_socio (T2). Un lote de otra fecha cuenta como "de un plan anterior" (D-T4a: no
-- se devuelve).
--
-- 1) _lote_de_pago_anulado(user, lote) -- NUEVA, interna. La misma condición de la tanda 2
--    (regla F: filas_vencidas; reversiones anteriores: creditos[].lote_id).
-- 2) _lote_del_plan(user, disciplina) -- NUEVA, interna. El lote del plan de esa disciplina
--    (aunque esté en 0), sin lotes de pagos anulados; mismo orden que T3 (con saldo primero,
--    después el más nuevo). null si no hay plan o el plan no tiene esa disciplina.
-- 3) cancel_booking_detalle(clase, fecha, motivo) -- NUEVA, la usa la PWA (C2 + P1).
--    Mismo límite de minutos y mismos errores que cancel_booking. Devuelve jsonb:
--      reintegrado, motivo, vence (YYYY-MM-DD o null), lote_id, mensaje (texto para el socio).
--    motivo: reintegrado            (lote de la reserva, del plan: +1)
--            reintegrado_plan       (reserva vieja sin lote: +1 al lote del plan de la disciplina)
--            pago_anulado           (lote de un pago anulado: no se devuelve)
--            lote_vencido           (venció o lo venció un pago nuevo: no se devuelve)
--            lote_de_otro_plan      (vigente pero de otra fecha que el plan: no se devuelve)
--            sin_plan_disciplina    (sin lote y el plan no tiene esa disciplina: no se devuelve)
--            aparatos_sin_creditos  (no usa créditos: nada que devolver)
-- 4) cancel_booking -- MISMA firma (PWA viejas en caché), MISMOS permisos. Ahora es un
--    envoltorio de cancel_booking_detalle y devuelve `reintegrado`: deja de decir true cuando
--    no devolvió nada. Se le agrega search_path (D-T4e).
-- 5) _cancelar_reserva_por_gimnasio -- MISMA firma, MISMAS claves de jsonb y MISMOS motivos
--    (el Admin no cambia). O1: el +1 va al lote de la reserva solo si es del plan; si no, al
--    lote del plan de esa disciplina (aunque esté en 0); si el plan no tiene esa disciplina, no
--    se devuelve y el aviso lo dice. Pagos anulados y Aparatos, igual que hoy.
--
-- Concurrencia: las dos cancelaciones bloquean los lotes del socio ANTES que la reserva (como
-- T3), así no se cruzan con un cobro, una reserva u otra cancelación del mismo socio.
--
-- Solo crea o reemplaza funciones. Ningún UPDATE/DELETE/INSERT sobre datos existentes. La
-- tabla temporal de abajo es solo para comparar permisos y se borra sola al terminar.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) Huellas EXACTAS de producción (confirmadas el 03/11):
--        cancel_booking                  = afcc5c25de7f16c3f5a657254c9937ba
--        _cancelar_reserva_por_gimnasio  = 1b65c0846ca5dbc9c7f6b684d880530b
--      y T2 aplicada (huellas sin espacios): fecha_plan_socio 7e82d5f0a2a13790b2bbfc64e765aac5,
--      ultimo_dia_plan 1682ea09613a4e9fd86f0101dca063a7.
--   2) Permisos de producción (03/11) y EXACTAMENTE iguales después (create or replace los
--      conserva; no hay grant para ellas):
--        cancel_booking                  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--        _cancelar_reserva_por_gimnasio  {postgres=X/postgres,service_role=X/postgres}
--   3) Los nombres nuevos no existen todavía.
--   4) DESPUÉS: huellas sin espacios de las 5 funciones = las de abajo; cancel_booking_detalle
--      ejecutable por authenticated y no por anon ni public; las internas, por ninguno de los 3.
--
-- Huellas T4 sin espacios (md5(regexp_replace(pg_get_functiondef(...), '\s+', '', 'g'))),
-- calculadas sobre el texto de este archivo:
--   _lote_de_pago_anulado            927ed872bffbd4adedb853870948c69e
--   _lote_del_plan                   3bc31ce02fde1172c747f12a9185ef7c
--   cancel_booking_detalle           10de28ae892d8f6cf0745bf997357ef6
--   cancel_booking                   3556a21005291ce2a12693f4c0d2d72a
--   _cancelar_reserva_por_gimnasio   aeb58ac99ab1806c6709eba0abf75abb
--
-- Prueba: prueba_t4.sql (se corre DESPUÉS de esta migración: todo OK).
-- Rollback: rollback_t4.sql. Orden: 1) esta migración, 2) la PWA. Rollback: 1) PWA, 2) SQL
-- (la PWA nueva igual sobrevive al rollback: si cancel_booking_detalle no existe, usa
-- cancel_booking con un texto neutro).
-- =====================================================================================

begin;

-- ── Guardas 1, 2 y 3 ──────────────────────────────────────────────────────────────────
do $guarda$
begin
  if md5(pg_get_functiondef('public.cancel_booking(uuid, date, text)'::regprocedure)) <> 'afcc5c25de7f16c3f5a657254c9937ba' then
    raise exception 'T4: cancel_booking no es la versión de producción (cambió su huella). No se aplicó nada.';
  end if;
  if md5(pg_get_functiondef('public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)'::regprocedure)) <> '1b65c0846ca5dbc9c7f6b684d880530b' then
    raise exception 'T4: _cancelar_reserva_por_gimnasio no es la versión de producción (cambió su huella). No se aplicó nada.';
  end if;
  if md5(regexp_replace(pg_get_functiondef('public.fecha_plan_socio(uuid)'::regprocedure), '\s+', '', 'g')) <> '7e82d5f0a2a13790b2bbfc64e765aac5'
     or md5(regexp_replace(pg_get_functiondef('public.ultimo_dia_plan(timestamp with time zone)'::regprocedure), '\s+', '', 'g')) <> '1682ea09613a4e9fd86f0101dca063a7' then
    raise exception 'T4: fecha_plan_socio / ultimo_dia_plan no son las de T2. No se aplicó nada.';
  end if;

  if (select coalesce(proacl::text, '(por defecto)') from pg_proc where oid = 'public.cancel_booking(uuid, date, text)'::regprocedure)
     <> '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' then
    raise exception 'T4: los permisos de cancel_booking no son los de producción. No se aplicó nada.';
  end if;
  if (select coalesce(proacl::text, '(por defecto)') from pg_proc where oid = 'public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)'::regprocedure)
     <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception 'T4: los permisos de _cancelar_reserva_por_gimnasio no son los de producción. No se aplicó nada.';
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('cancel_booking_detalle', '_lote_de_pago_anulado', '_lote_del_plan')) then
    raise exception 'T4: ya existe una función con un nombre nuevo de T4 -- no se pisa nada desconocido. No se aplicó nada.';
  end if;
end;
$guarda$;

create temp table _t4_permisos_antes on commit drop as
select p.oid::regprocedure::text as funcion, coalesce(p.proacl::text, '(por defecto)') as permisos
from pg_proc p
where p.oid in ('public.cancel_booking(uuid, date, text)'::regprocedure,
                'public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)'::regprocedure);

-- ── 1) _lote_de_pago_anulado (NUEVA, interna) ─────────────────────────────────────────
-- security invoker a propósito (como fecha_plan_socio): solo la llaman funciones SECURITY
-- DEFINER; si alguna vez quedara expuesta, no se saltearía el RLS.
CREATE OR REPLACE FUNCTION public._lote_de_pago_anulado(p_user_id uuid, p_lote_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p_lote_id is not null and exists (
    select 1
    from pagos_socio p
    where p.estado = 'anulado'
      and p.user_id = p_user_id
      and (
        coalesce(p.detalle_acreditacion->'reversion'->'filas_vencidas', '[]'::jsonb)
          @> jsonb_build_array(jsonb_build_object('user_credit_id', p_lote_id::text))
        or coalesce(p.detalle_acreditacion->'creditos', '[]'::jsonb)
          @> jsonb_build_array(jsonb_build_object('lote_id', p_lote_id::text))
      )
  );
$function$
;

revoke all on function public._lote_de_pago_anulado(uuid, uuid) from public, anon, authenticated;

-- ── 2) _lote_del_plan (NUEVA, interna) ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._lote_del_plan(p_user_id uuid, p_discipline_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- El lote del plan de esa disciplina: vigente, el mismo día en Argentina que la fecha del
  -- plan (T2), aunque esté en 0, sin lotes de pagos anulados. Mismo orden que T3: primero el
  -- que tiene saldo, después el más nuevo. null si no hay plan o no tiene esa disciplina.
  select uc.id
  from user_credits uc
  where uc.user_id = p_user_id
    and uc.discipline_id = p_discipline_id
    and uc.expires_at > now()
    and public.ultimo_dia_plan(uc.expires_at) = public.ultimo_dia_plan(public.fecha_plan_socio(p_user_id))
    and not public._lote_de_pago_anulado(p_user_id, uc.id)
  order by (coalesce(uc.remaining_credits, 0) > 0) desc, uc.created_at desc, uc.expires_at desc
  limit 1;
$function$
;

revoke all on function public._lote_del_plan(uuid, uuid) from public, anon, authenticated;

-- ── 3) cancel_booking_detalle (NUEVA, la usa la PWA) ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_booking_detalle(p_class_id uuid, p_booking_date date, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  v_user_id uuid := auth.uid();
  v_discipline_id uuid;
  v_start_time time;
  v_disciplina text;
  v_kind text;
  v_booking_id uuid;
  v_credit_lote_id uuid;
  v_lote_vence timestamptz;
  v_fecha_plan timestamptz;
  v_class_start timestamptz;
  v_limite_minutos int;
  v_destino uuid;
  v_vence timestamptz;
  v_motivo text;
  v_mensaje text;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  select c.discipline_id, c.start_time, d.name, d.kind
    into v_discipline_id, v_start_time, v_disciplina, v_kind
  from classes c
  left join disciplines d on d.id = c.discipline_id
  where c.id = p_class_id;
  if not found then
    raise exception 'La clase no existe';
  end if;

  -- Límite de minutos: igual que hoy (Configuración, 120 por defecto) y con el mismo error.
  v_class_start := (p_booking_date::text || ' ' || v_start_time::text)::timestamp
    at time zone c_zona;

  begin
    select coalesce(limite_cancelacion_minutos, 120) into v_limite_minutos
    from configuracion where id = 1;
  exception when others then
    v_limite_minutos := null;
  end;
  if v_limite_minutos is null then
    v_limite_minutos := 120;
  end if;

  if not (now() <= (v_class_start - (v_limite_minutos || ' minutes')::interval)) then
    raise exception 'No podés cancelar esta reserva -- faltan menos de % minutos para que empiece la clase.', v_limite_minutos;
  end if;

  -- T4: serializa con un cobro, una reserva u otra cancelación del mismo socio (como T3).
  perform 1 from user_credits where user_id = v_user_id for update;

  -- Igual que hoy: credit_lote_id se lee ANTES de borrar la reserva.
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

  if v_kind = 'membership' then
    v_motivo := 'aparatos_sin_creditos';
  elsif v_credit_lote_id is not null then
    select expires_at into v_lote_vence from user_credits where id = v_credit_lote_id;
    v_fecha_plan := public.fecha_plan_socio(v_user_id);

    if public._lote_de_pago_anulado(v_user_id, v_credit_lote_id) then
      v_motivo := 'pago_anulado';
    elsif v_lote_vence is null or v_lote_vence <= now() then
      v_motivo := 'lote_vencido';
    elsif v_fecha_plan is null
          or public.ultimo_dia_plan(v_lote_vence) <> public.ultimo_dia_plan(v_fecha_plan) then
      v_motivo := 'lote_de_otro_plan';
    else
      update user_credits
      set remaining_credits = coalesce(remaining_credits, 0) + 1
      where id = v_credit_lote_id and expires_at > now()
      returning id, expires_at into v_destino, v_vence;
      v_motivo := case when v_destino is not null then 'reintegrado' else 'lote_vencido' end;
    end if;
  else
    -- Reserva vieja sin lote: solo al lote del plan de esa disciplina.
    v_destino := public._lote_del_plan(v_user_id, v_discipline_id);
    if v_destino is not null then
      update user_credits
      set remaining_credits = coalesce(remaining_credits, 0) + 1
      where id = v_destino and expires_at > now()
      returning expires_at into v_vence;
    end if;
    if v_vence is not null then
      v_motivo := 'reintegrado_plan';
    else
      v_destino := null;
      v_motivo := 'sin_plan_disciplina';
    end if;
  end if;

  v_mensaje := case v_motivo
    when 'reintegrado' then format('Te devolvimos el crédito (vence el %s).', to_char((v_vence at time zone c_zona)::date, 'DD/MM/YYYY'))
    when 'reintegrado_plan' then format('Te devolvimos el crédito (vence el %s).', to_char((v_vence at time zone c_zona)::date, 'DD/MM/YYYY'))
    when 'pago_anulado' then 'El crédito no se devolvió porque era de un pago anulado. Consultá con el gimnasio.'
    when 'lote_vencido' then 'El crédito no se devolvió porque era de un plan que ya venció o que reemplazó un pago nuevo.'
    when 'lote_de_otro_plan' then 'El crédito no se devolvió porque era de un plan anterior, no del que tenés vigente.'
    when 'sin_plan_disciplina' then format('El crédito no se devolvió porque tu plan actual no incluye %s. Consultá con el gimnasio.', coalesce(v_disciplina, 'esta disciplina'))
    else format('%s no usa créditos: no había nada que devolver.', coalesce(v_disciplina, 'Aparatos'))
  end;

  return jsonb_build_object(
    'reintegrado', v_motivo in ('reintegrado', 'reintegrado_plan'),
    'motivo', v_motivo,
    'vence', (v_vence at time zone c_zona)::date,
    'lote_id', v_destino,
    'mensaje', v_mensaje
  );
end;
$function$
;

revoke all on function public.cancel_booking_detalle(uuid, date, text) from public;
revoke all on function public.cancel_booking_detalle(uuid, date, text) from anon;
grant execute on function public.cancel_booking_detalle(uuid, date, text) to authenticated;
grant execute on function public.cancel_booking_detalle(uuid, date, text) to service_role;

-- ── 4) cancel_booking: envoltorio con la MISMA firma (PWA viejas en caché) ───────────
CREATE OR REPLACE FUNCTION public.cancel_booking(p_class_id uuid, p_booking_date date, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- T4: mismas reglas y mismos errores que cancel_booking_detalle. Devuelve si de verdad se
  -- devolvió el crédito (antes: true siempre que cancelaba, se hubiera devuelto o no).
  return (public.cancel_booking_detalle(p_class_id, p_booking_date, p_reason)->>'reintegrado')::boolean;
end;
$function$
;

-- ── 5) _cancelar_reserva_por_gimnasio: O1 (misma firma, mismas claves y motivos) ──────
CREATE OR REPLACE FUNCTION public._cancelar_reserva_por_gimnasio(p_user_id uuid, p_class_id uuid, p_booking_date date, p_reason text, p_contexto text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_dia_plan date;
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

  -- T4: serializa con un cobro, una reserva u otra cancelación del mismo socio (como T3).
  perform 1 from user_credits where user_id = p_user_id for update;

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
    v_motivo := 'aparatos_sin_creditos';
    select max(expires_at) into v_vence
    from user_credits
    where user_id = p_user_id and discipline_id = v_discipline_id and expires_at > now();
  elsif v_pago_anulado_fecha is not null then
    v_motivo := 'pago_anulado';
  else
    -- T4 (O1): el lote de la reserva, solo si es del plan (mismo día en Argentina que la
    -- fecha del plan).
    v_dia_plan := public.ultimo_dia_plan(public.fecha_plan_socio(p_user_id));
    if v_credit_lote_id is not null and v_dia_plan is not null then
      update user_credits
      set remaining_credits = coalesce(remaining_credits, 0) + 1
      where id = v_credit_lote_id
        and expires_at > now()
        and public.ultimo_dia_plan(expires_at) = v_dia_plan
      returning id, expires_at into v_destino, v_vence;
    end if;

    if v_destino is not null then
      v_motivo := 'reintegrado';
    else
      -- T4 (O1): si no, el lote del plan de esa disciplina (aunque esté en 0, sin pagos
      -- anulados). Si el plan no tiene esa disciplina, no se devuelve.
      v_destino := public._lote_del_plan(p_user_id, v_discipline_id);

      if v_destino is not null then
        update user_credits
        set remaining_credits = coalesce(remaining_credits, 0) + 1
        where id = v_destino and expires_at > now()
        returning expires_at into v_vence;
      end if;

      if v_vence is not null then
        v_motivo := case when v_credit_lote_id is null then 'reintegrado_fifo' else 'reintegrado_otro_lote' end;
      else
        v_destino := null;
        v_motivo := 'sin_lote_vigente';
      end if;
    end if;
  end if;

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
    v_mensaje_socio := format('%s Ese crédito no se reintegró porque tu plan actual no incluye créditos de %s. Consultá con el gimnasio.', v_inicio_socio, v_disciplina);
  end if;

  v_mensaje_admin := case v_motivo
    when 'aparatos_sin_creditos' then case
      when v_vence is not null then format('%s: %s no usa créditos, no había nada que devolver; su acceso sigue igual hasta el %s.', v_nombre, v_disciplina, v_vence_txt)
      else format('%s: %s no usa créditos, no había nada que devolver; no tiene acceso vigente a %s.', v_nombre, v_disciplina, v_disciplina)
    end
    when 'reintegrado' then format('%s: crédito devuelto (vence el %s).', v_nombre, v_vence_txt)
    when 'reintegrado_otro_lote' then format('%s: su lote original no era el del plan vigente (vencido, reemplazado por un pago o de otra fecha); el crédito se sumó al lote de su plan de %s (vence el %s).', v_nombre, v_disciplina, v_vence_txt)
    when 'reintegrado_fifo' then format('%s: crédito devuelto al lote de su plan de %s (vence el %s).', v_nombre, v_disciplina, v_vence_txt)
    when 'pago_anulado' then format('%s: NO se devolvió el crédito, era de un pago anulado (del %s). Si querés, cargáselo a mano con los créditos manuales.', v_nombre, to_char((v_pago_anulado_fecha at time zone c_zona)::date, 'DD/MM/YYYY'))
    else format('%s: NO se devolvió el crédito, su plan actual no incluye créditos de %s. Si querés, cargáselo a mano con los créditos manuales.', v_nombre, v_disciplina)
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
$function$
;

-- ── Guarda 4: verificación DESPUÉS ────────────────────────────────────────────────────
do $verifica$
declare
  v_txt text;
begin
  select string_agg(f.funcion || ' (' || f.real || ')', ', ') into v_txt
  from (
    select x.funcion, x.esperada,
           md5(regexp_replace(pg_get_functiondef(x.funcion::regprocedure), '\s+', '', 'g')) as real
    from (values
      ('public._lote_de_pago_anulado(uuid, uuid)', '927ed872bffbd4adedb853870948c69e'),
      ('public._lote_del_plan(uuid, uuid)', '3bc31ce02fde1172c747f12a9185ef7c'),
      ('public.cancel_booking_detalle(uuid, date, text)', '10de28ae892d8f6cf0745bf997357ef6'),
      ('public.cancel_booking(uuid, date, text)', '3556a21005291ce2a12693f4c0d2d72a'),
      ('public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)', 'aeb58ac99ab1806c6709eba0abf75abb')
    ) as x(funcion, esperada)
  ) f
  where f.real <> f.esperada;
  if v_txt is not null then
    raise exception 'T4: quedaron con otra huella (sin espacios): %. No se aplicó nada.', v_txt;
  end if;

  select string_agg(a.funcion || ': antes ' || a.permisos || ' / ahora ' || coalesce(p.proacl::text, '(por defecto)'), ' | ') into v_txt
  from _t4_permisos_antes a
  join pg_proc p on p.oid = a.funcion::regprocedure
  where coalesce(p.proacl::text, '(por defecto)') <> a.permisos;
  if v_txt is not null then
    raise exception 'T4: cambiaron permisos de funciones existentes: %. No se aplicó nada.', v_txt;
  end if;

  if has_function_privilege('anon', 'public.cancel_booking_detalle(uuid, date, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.cancel_booking_detalle(uuid, date, text)', 'execute')
     or exists (select 1 from pg_proc where oid = 'public.cancel_booking_detalle(uuid, date, text)'::regprocedure
                and coalesce(proacl::text, '') ~ '(^|[{,])=') then
    raise exception 'T4: permisos de cancel_booking_detalle incorrectos (%). No se aplicó nada.',
      (select proacl::text from pg_proc where oid = 'public.cancel_booking_detalle(uuid, date, text)'::regprocedure);
  end if;

  if has_function_privilege('anon', 'public._lote_de_pago_anulado(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._lote_de_pago_anulado(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public._lote_del_plan(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._lote_del_plan(uuid, uuid)', 'execute') then
    raise exception 'T4: las funciones internas quedaron ejecutables por anon o authenticated. No se aplicó nada.';
  end if;

  raise notice 'T4 aplicada. Huellas exactas nuevas: cancel_booking %, _cancelar_reserva_por_gimnasio %, cancel_booking_detalle %.',
    md5(pg_get_functiondef('public.cancel_booking(uuid, date, text)'::regprocedure)),
    md5(pg_get_functiondef('public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)'::regprocedure)),
    md5(pg_get_functiondef('public.cancel_booking_detalle(uuid, date, text)'::regprocedure));
end;
$verifica$;

commit;

-- Después de correrla (solo lectura): Q1 de investigacion_t4_cancel_booking.sql y la foto de
-- planes activos de PLAN_TANDAS.md (tiene que dar igual que antes).
