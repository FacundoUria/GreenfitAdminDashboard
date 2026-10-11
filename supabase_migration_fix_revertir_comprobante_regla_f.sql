-- =====================================================================================
-- admin_revertir_comprobante -- regla F.
--
-- Revertir un comprobante deja al socio SIN los créditos y SIN el vencimiento que dio
-- ese pago, y NO restaura nada del plan anterior (ni créditos ni Aparatos).
--
-- Qué cambia respecto de la versión de producción (fix_revertir_comprobante_lote_exacto):
--   * Las filas del pago se identifican por IDENTIDAD, no por fecha: son las filas de
--     user_credits del socio con el MISMO created_at que la fila de pagos_socio.
--     crear_pago_pendiente_transferencia inserta el pago y llama a acreditar_pack en la
--     misma transacción, y now() es constante dentro de una transacción. Se cruzan contra
--     detalle_acreditacion (lote_id de cada crédito y la presencia de 'aparatos').
--   * Cada fila del pago queda vencida YA (expires_at = now(), o la que tenía si ya era
--     anterior) y los créditos en 0. Nunca se inserta una fila nueva.
--   * No se restaura nada anterior: desaparece el INSERT con fecha_vencimiento_antes.
--   * Desaparece la comparación expires_at::date (UTC) contra fecha_vencimiento_despues
--     (Argentina), que fallaba con pagos posteriores a las 21:00 ART.
--   * La rama legacy (sin lote_id) ya no inserta: busca el lote que creó el pago por
--     identidad. Si algo de lo que dice el detalle no se puede identificar con certeza,
--     NO se cambia nada y se avisa con un error (no se adivina).
--   * Espejo en socios recalculado desde lo que queda vigente (no restando).
--   * Todo lo que Seba tiene que saber vuelve en el 2° campo (se mantiene el nombre
--     aparatos_advertencia para no cambiar la firma); la pantalla lo muestra en el banner.
--   * Se guarda en detalle_acreditacion->'reversion' qué se venció y con qué saldo.
--
-- Misma firma, SECURITY DEFINER, mismo chequeo de is_admin() y mismo grant. No revoca nada.
-- =====================================================================================

create or replace function public.admin_revertir_comprobante(p_pagos_socio_id uuid)
 returns table(reversion_ok boolean, aparatos_advertencia text)
 language plpgsql
 security definer
as $function$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  v_row public.pagos_socio%rowtype;
  v_detalle jsonb;
  v_credito jsonb;
  v_discipline_id uuid;
  v_lote_id uuid;
  v_cantidad int;
  v_ids_pago uuid[];
  v_fila record;
  v_fecha_despues date;
  v_avisos text[] := '{}';
  v_revertidas jsonb := '[]'::jsonb;
  v_reservas_futuras int := 0;
  v_reservas_texto text;
  v_sigue_vigente text;
  v_hoy date := (now() at time zone c_zona)::date;
  v_dni text;
  v_total int;
  v_fecha_vigente timestamptz;
  v_socios_actualizados int := 0;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select * into v_row from public.pagos_socio where id = p_pagos_socio_id for update;
  if not found then
    raise exception 'No existe ningún pago con id %.', p_pagos_socio_id;
  end if;

  -- Idempotente: otra pestaña u otro admin ya lo revirtió.
  if v_row.estado = 'anulado' then
    return query select false, 'Este pago ya estaba revertido: no se cambió nada.'::text;
    return;
  end if;

  if v_row.estado <> 'pagado' then
    raise exception 'Solo se puede revertir un pago en estado "pagado" (estado actual: %).', v_row.estado;
  end if;

  v_detalle := v_row.detalle_acreditacion;
  if v_detalle is null then
    raise exception 'Este pago no tiene detalle_acreditacion guardado -- no se puede saber qué otorgó. No se cambió nada: corregí el plan del socio a mano desde Socios.';
  end if;

  -- ── Filas que creó ESTE pago (misma transacción => mismo created_at) ──
  perform 1 from public.user_credits
  where user_id = v_row.user_id and created_at = v_row.created_at
  for update;

  select coalesce(array_agg(id), '{}') into v_ids_pago
  from public.user_credits
  where user_id = v_row.user_id and created_at = v_row.created_at;

  -- ── Se cruza contra el detalle. Si algo no cierra, no se toca nada. ──
  for v_credito in select * from jsonb_array_elements(coalesce(v_detalle->'creditos', '[]'::jsonb))
  loop
    v_discipline_id := (v_credito->>'discipline_id')::uuid;
    v_lote_id := nullif(v_credito->>'lote_id', '')::uuid;

    if v_lote_id is not null then
      if not (v_lote_id = any (v_ids_pago))
         or not exists (select 1 from public.user_credits where id = v_lote_id and discipline_id = v_discipline_id) then
        raise exception 'No se pudo revertir: el lote de créditos de % que figura en este pago no lo creó este pago (puede ser un comprobante de antes del 10/09, cuando los créditos se sumaban a un lote existente). No se cambió nada: corregí los créditos a mano desde Socios.',
          coalesce((select name from public.disciplines where id = v_discipline_id), v_discipline_id::text);
      end if;
    else
      select count(*) into v_cantidad
      from public.user_credits uc
      join public.disciplines d on d.id = uc.discipline_id and d.kind = 'credits'
      where uc.id = any (v_ids_pago) and uc.discipline_id = v_discipline_id;

      if v_cantidad <> 1 then
        raise exception 'No se pudo revertir: no se encontró el lote de créditos de % que creó este pago. No se cambió nada: corregí los créditos a mano desde Socios.',
          coalesce((select name from public.disciplines where id = v_discipline_id), coalesce(v_discipline_id::text, '(sin disciplina)'));
      end if;
    end if;
  end loop;

  if v_detalle ? 'aparatos' then
    select count(*) into v_cantidad
    from public.user_credits uc
    join public.disciplines d on d.id = uc.discipline_id and d.kind = 'membership'
    where uc.id = any (v_ids_pago);

    if v_cantidad <> 1 then
      raise exception 'No se pudo revertir: no se encontró el Aparatos que creó este pago. No se cambió nada: corregí Aparatos a mano desde Socios.';
    end if;
  end if;

  if cardinality(v_ids_pago) = 0 then
    raise exception 'No se pudo revertir: no se encontró nada de lo que acreditó este pago. No se cambió nada: corregí el plan del socio a mano desde Socios.';
  end if;

  -- ── Vencer YA todo lo del pago. Sin INSERT, sin restaurar nada. ──
  v_fecha_despues := (v_detalle->'aparatos'->>'fecha_vencimiento_despues')::date;

  for v_fila in
    select uc.id, uc.remaining_credits, uc.expires_at, d.name, d.kind
    from public.user_credits uc
    join public.disciplines d on d.id = uc.discipline_id
    where uc.id = any (v_ids_pago)
    order by d.kind desc, d.name
  loop
    if v_fila.expires_at is null or v_fila.expires_at <= now() then
      v_avisos := array_append(v_avisos, case when v_fila.kind = 'membership'
        then 'El Aparatos de este pago ya estaba vencido (venció, lo reemplazó otro cobro o se quitó a mano): no había nada para quitar.'
        else format('Los créditos de %s de este pago ya estaban vencidos (vencieron o los reemplazó otro cobro): no había nada para quitar.', v_fila.name)
      end);
    elsif v_fila.kind = 'membership' and v_fecha_despues is not null
          and (v_fila.expires_at at time zone c_zona)::date <> v_fecha_despues then
      v_avisos := array_append(v_avisos, format(
        'El Aparatos de este pago tenía la fecha cambiada a mano (vencía el %s): igual se le venció.',
        to_char((v_fila.expires_at at time zone c_zona)::date, 'DD/MM/YYYY')));
    end if;

    v_revertidas := v_revertidas || jsonb_build_array(jsonb_build_object(
      'user_credit_id', v_fila.id,
      'disciplina', v_fila.name,
      'saldo_que_tenia', v_fila.remaining_credits,
      'vencia', v_fila.expires_at
    ));

    update public.user_credits
    set remaining_credits = case when v_fila.kind = 'credits' then 0 else remaining_credits end,
        expires_at = least(coalesce(expires_at, now()), now())
    where id = v_fila.id;
  end loop;

  -- ── Reservas futuras pagadas con créditos de este pago: no se cancelan, se avisa. ──
  select count(*),
         string_agg(format('%s del %s', coalesce(c.title, 'clase'), to_char(b.booking_date, 'DD/MM')), ', '
                    order by b.booking_date)
    into v_reservas_futuras, v_reservas_texto
  from public.bookings b
  left join public.classes c on c.id = b.class_id
  where b.credit_lote_id = any (v_ids_pago)
    and b.booking_date >= v_hoy;

  if v_reservas_futuras > 0 then
    v_avisos := array_append(v_avisos, format(
      'Tiene %s reserva(s) futura(s) pagada(s) con créditos de este pago (%s): no se cancelaron. Si se cancelan, el crédito no vuelve porque el lote quedó vencido.',
      v_reservas_futuras, v_reservas_texto));
  end if;

  -- ── Lo que sigue vigente (no es de este pago, no se tocó). ──
  select string_agg(
           d.name
           || case when d.kind = 'credits' then format(' (%s créditos)', uc.remaining_credits) else '' end
           || ' hasta el ' || to_char((uc.expires_at at time zone c_zona)::date, 'DD/MM/YYYY'),
           ', ' order by d.name)
    into v_sigue_vigente
  from public.user_credits uc
  join public.disciplines d on d.id = uc.discipline_id
  where uc.user_id = v_row.user_id
    and uc.expires_at > now()
    and (d.kind = 'membership' or uc.remaining_credits > 0);

  if v_sigue_vigente is not null then
    v_avisos := array_append(v_avisos, ('Sigue vigente (no es de este pago, no se tocó): ' || v_sigue_vigente || '.'));
  end if;

  -- ── Espejo en socios: recalculado desde lo que queda vigente. ──
  select coalesce(sum(uc.remaining_credits) filter (where d.kind = 'credits'), 0), max(uc.expires_at)
    into v_total, v_fecha_vigente
  from public.user_credits uc
  join public.disciplines d on d.id = uc.discipline_id
  where uc.user_id = v_row.user_id
    and uc.expires_at > now()
    and (d.kind = 'membership' or uc.remaining_credits > 0);

  select dni into v_dni from public.profiles where id = v_row.user_id;
  if v_dni is not null then
    update public.socios
    set creditos = v_total,
        -- Sin nada vigente: ayer (Argentina) o la que ya tenía si era anterior, para que el
        -- Admin lo muestre vencido desde ya. Nunca se restaura la fecha del plan anterior.
        fecha_vencimiento = coalesce(
          (v_fecha_vigente at time zone c_zona)::date,
          least(fecha_vencimiento, v_hoy - 1)
        )
    where dni = v_dni;
    get diagnostics v_socios_actualizados = row_count;
  end if;

  if v_socios_actualizados = 0 then
    v_avisos := array_append(v_avisos, 'El socio no tiene ficha en Socios vinculada por DNI: la app quedó corregida pero la ficha del Admin no se actualizó.');
  end if;

  update public.pagos_socio
  set estado = 'anulado',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      detalle_acreditacion = v_detalle || jsonb_build_object('reversion', jsonb_build_object(
        'revertido_en', now(),
        'filas_vencidas', v_revertidas,
        'reservas_futuras', v_reservas_futuras
      ))
  where id = p_pagos_socio_id;

  insert into notifications (sender_id, audience_type, target_user_id, title, body)
  values (
    auth.uid(), 'user', v_row.user_id,
    'Se revirtió una acreditación',
    'Se revirtió la acreditación de tu comprobante del ' ||
      to_char(v_row.created_at at time zone c_zona, 'DD/MM/YYYY') ||
      '. Si creés que es un error, contactá al gimnasio.'
  );

  return query select true, nullif(array_to_string(v_avisos, ' | '), '');
end;
$function$;

grant execute on function public.admin_revertir_comprobante(uuid) to authenticated;
