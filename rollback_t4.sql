-- =====================================================================================
-- ROLLBACK de supabase_migration_t4_cancel_booking_detalle.sql. NO SE CORRIÓ.
--
-- ORDEN: primero la PWA (o no: la PWA nueva sobrevive -- si cancel_booking_detalle no existe,
-- usa cancel_booking con un texto neutro), después este SQL.
--
-- 1) cancel_booking y _cancelar_reserva_por_gimnasio vuelven a sus definiciones de producción
--    (exportación del 23/10, funciones_user_credits_produccion_23-10.txt; para la del gimnasio
--    es la misma lógica que la tanda 2, con menos comentarios). La exportación no conserva los
--    espacios byte a byte, así que la verificación es con la huella SIN espacios, que sí tiene
--    que ser la de producción: cancel_booking c2e3ae0f1280ac3c35c5531f31af07e7 y
--    _cancelar_reserva_por_gimnasio bfa71503f73736dc13836e48132c06c3 (confirmadas el 03/11).
--    OJO: con esto cancel_booking vuelve a devolver true aunque no devuelva nada.
-- 2) cancel_booking_detalle, _lote_del_plan y _lote_de_pago_anulado se borran (las creó T4;
--    no guardan datos).
--
-- Solo funciones: ningún UPDATE/DELETE/INSERT de datos.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) ANTES: las 5 funciones con su huella T4 (sin espacios). Si alguien las cambió después
--      de T4, se frena: no se pisa un cambio que no conocemos.
--   2) DESPUÉS: huellas sin espacios = las de producción, cancel_booking sin search_path (como
--      antes), permisos EXACTAMENTE iguales, y las 3 funciones nuevas ya no existen.
-- =====================================================================================

begin;

do $guarda$
declare
  v_txt text;
begin
  select string_agg(x.funcion, ', ') into v_txt
  from (values
    ('public._lote_de_pago_anulado(uuid, uuid)', '927ed872bffbd4adedb853870948c69e'),
    ('public._lote_del_plan(uuid, uuid)', '3bc31ce02fde1172c747f12a9185ef7c'),
    ('public.cancel_booking_detalle(uuid, date, text)', '10de28ae892d8f6cf0745bf997357ef6'),
    ('public.cancel_booking(uuid, date, text)', '3556a21005291ce2a12693f4c0d2d72a'),
    ('public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)', 'aeb58ac99ab1806c6709eba0abf75abb')
  ) as x(funcion, esperada)
  where to_regprocedure(x.funcion) is null
     or md5(regexp_replace(pg_get_functiondef(to_regprocedure(x.funcion)), '\s+', '', 'g')) <> x.esperada;
  if v_txt is not null then
    raise exception 'Rollback T4: no son la versión T4 (o no existen): %. No se aplicó nada.', v_txt;
  end if;
end;
$guarda$;

create temp table _t4_rb_permisos_antes on commit drop as
select p.oid::regprocedure::text as funcion, coalesce(p.proacl::text, '(por defecto)') as permisos
from pg_proc p
where p.oid in ('public.cancel_booking(uuid, date, text)'::regprocedure,
                'public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)'::regprocedure);

-- ── cancel_booking (producción 23/10, textual) ──
CREATE OR REPLACE FUNCTION public.cancel_booking(p_class_id uuid, p_booking_date date, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$
;

-- ── _cancelar_reserva_por_gimnasio (producción, textual: la lógica de la tanda 2) ──
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
    if v_credit_lote_id is not null then
      update user_credits
      set remaining_credits = remaining_credits + 1
      where id = v_credit_lote_id and expires_at > now()
      returning id, expires_at into v_destino, v_vence;
    end if;

    if v_destino is not null then
      v_motivo := 'reintegrado';
    else
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
$function$
;

-- ── Las 3 funciones que creó T4 ──
drop function public.cancel_booking_detalle(uuid, date, text);
drop function public._lote_del_plan(uuid, uuid);
drop function public._lote_de_pago_anulado(uuid, uuid);

-- ── Verificación DESPUÉS ──
do $verifica$
declare
  v_txt text;
begin
  if md5(regexp_replace(pg_get_functiondef('public.cancel_booking(uuid, date, text)'::regprocedure), '\s+', '', 'g')) <> 'c2e3ae0f1280ac3c35c5531f31af07e7' then
    raise exception 'Rollback T4: cancel_booking no volvió a la versión de producción. No se aplicó nada.';
  end if;
  if md5(regexp_replace(pg_get_functiondef('public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)'::regprocedure), '\s+', '', 'g')) <> 'bfa71503f73736dc13836e48132c06c3' then
    raise exception 'Rollback T4: _cancelar_reserva_por_gimnasio no volvió a la versión de producción. No se aplicó nada.';
  end if;
  if (select proconfig from pg_proc where oid = 'public.cancel_booking(uuid, date, text)'::regprocedure) is not null then
    raise exception 'Rollback T4: cancel_booking quedó con search_path (antes no tenía). No se aplicó nada.';
  end if;

  select string_agg(a.funcion || ': antes ' || a.permisos || ' / ahora ' || coalesce(p.proacl::text, '(por defecto)'), ' | ') into v_txt
  from _t4_rb_permisos_antes a
  join pg_proc p on p.oid = a.funcion::regprocedure
  where coalesce(p.proacl::text, '(por defecto)') <> a.permisos;
  if v_txt is not null then
    raise exception 'Rollback T4: cambiaron permisos: %. No se aplicó nada.', v_txt;
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('cancel_booking_detalle', '_lote_de_pago_anulado', '_lote_del_plan')) then
    raise exception 'Rollback T4: quedó alguna de las funciones nuevas de T4. No se aplicó nada.';
  end if;

  raise notice 'Rollback T4 aplicado. Huellas exactas: cancel_booking % (producción afcc5c25de7f16c3f5a657254c9937ba), _cancelar_reserva_por_gimnasio % (producción 1b65c0846ca5dbc9c7f6b684d880530b). Pueden diferir solo en espacios.',
    md5(pg_get_functiondef('public.cancel_booking(uuid, date, text)'::regprocedure)),
    md5(pg_get_functiondef('public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)'::regprocedure));
end;
$verifica$;

commit;
