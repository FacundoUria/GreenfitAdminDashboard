-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- FIX URGENTE -- bug real: admin_revertir_comprobante() (Fase 3, supabase_
-- migration_auto_acreditar_y_revertir_comprobante.sql) nunca se migró al
-- modelo de lotes (supabase_migration_lotes_creditos_fase1/2.sql). Seguía
-- revirtiendo créditos contra "la fila más reciente por disciplina" (`order
-- by created_at desc limit 1`) en vez de leer el `lote_id` exacto que
-- `detalle_acreditacion.creditos[]` ya guarda desde la Fase 1 -- la propia
-- Fase 1 lo había dejado documentado como pendiente ("esas siguen leyendo
-- 'la fila más reciente' ... hasta las fases siguientes") y nunca se
-- retomó ni en la Fase 2 ni después.
--
-- ESCENARIO DE FALLA REAL: un socio compra el Pack A (8 créditos CrossFit)
-- el lunes -> crea el lote L1. El miércoles compra el Pack B (4 créditos
-- CrossFit), que cae en un día distinto -> crea un lote L2 independiente
-- (no fusiona). Si Seba revierte el comprobante del Pack A (el lunes), la
-- función buscaba "la fila más reciente de CrossFit" -- L2, el del
-- miércoles -- y le restaba los 8 créditos a ESE lote (con el piso en 0),
-- dejándolo en 0. L1 (el que de verdad correspondía revertir) quedaba
-- intacto. El socio perdía créditos que pagó de más (los de L2) sin haber
-- hecho nada malo, y seguía teniendo los créditos que Seba quería quitarle.
--
-- FIX: para cada entrada de detalle_acreditacion.creditos[], si trae
-- `lote_id` (todo comprobante generado desde que existe el modelo de
-- lotes lo tiene -- ver acreditar_pack() en supabase_migration_lotes_
-- creditos_fase1.sql), se opera UPDATE directo sobre ESA fila puntual por
-- id -- mismo criterio que ya usan book_class()/cancel_booking() en la
-- Fase 2 de lotes (un lote es una fila persistente que se muta durante su
-- vida, no un evento de ledger append-only). El resto de la función
-- (Aparatos, notificación, idempotencia, "lo ya gastado, gastado queda")
-- NO cambia.
--
-- CASO BORDE -- comprobantes de ANTES de que detalle_acreditacion guardara
-- lote_id (aprobados por el flujo legacy admin_aprobar_comprobante, que
-- nunca lo grabó): sin lote_id no hay forma honesta de saber cuál era el
-- lote real -- se hace fallback al comportamiento de siempre ("la fila más
-- reciente", con el mismo riesgo que este fix soluciona para el resto),
-- pero AHORA se devuelve una advertencia explícita en vez de fallar en
-- silencio -- mismo canal que ya usaba la advertencia de Aparatos
-- (columna `aparatos_advertencia`, que pasa a ser de propósito general:
-- no se renombra a propósito, así el caller real -- greenfit-app/../
-- pagosSocio.js:revertirComprobante() -- no necesita ningún cambio).
--
-- Alcance: SOLO cambia la parte de reversión de créditos por disciplina y
-- el manejo de la advertencia (para no pisar la de Aparatos con la nueva).
-- Aparatos queda exactamente igual -- nunca dependió de lotes, no hace
-- falta tocarlo. Mismos 1 parámetro de entrada, mismo `returns table` --
-- no hace falta `drop function` primero, `create or replace` alcanza.

create or replace function public.admin_revertir_comprobante(p_pagos_socio_id uuid)
returns table (
  reversion_ok boolean,
  aparatos_advertencia text
)
language plpgsql
security definer
as $$
declare
  v_row public.pagos_socio%rowtype;
  v_detalle jsonb;
  v_credito jsonb;
  v_discipline_id uuid;
  v_credits_otorgados int;
  v_lote_id uuid;
  v_remaining_actual int;
  v_expires_at_actual timestamptz;
  v_aparatos jsonb;
  v_aparatos_discipline_id uuid;
  v_fecha_antes timestamptz;
  v_fecha_despues date;
  v_expires_at_aparatos_actual timestamptz;
  -- Separada de la de créditos a propósito -- el "espejo en socios" de más
  -- abajo decide si toca fecha_vencimiento SOLO en base a esta (Aparatos
  -- revertido limpio o no), no debe verse afectado por una advertencia de
  -- créditos que no tiene nada que ver con Aparatos.
  v_aparatos_advertencia text := null;
  -- Advertencias del lado de créditos (caso legacy sin lote_id, o un
  -- lote_id guardado que ya no existe -- no debería pasar nunca, user_credits
  -- no borra filas, pero se avisa en vez de adivinar si pasara).
  v_creditos_advertencia text := null;
  v_dni text;
  v_total_revertido int := 0;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select * into v_row from public.pagos_socio where id = p_pagos_socio_id for update;
  if not found then
    raise exception 'No existe ningún pago con id %.', p_pagos_socio_id;
  end if;

  -- Idempotente -- no revertir dos veces la misma fila. Mismo criterio de
  -- "false sin tirar error" que ya usa admin_aprobar_comprobante para su
  -- propia idempotencia (otra pestaña/otro admin se adelantó).
  if v_row.estado = 'anulado' then
    return query select false, null::text;
    return;
  end if;

  if v_row.estado <> 'pagado' then
    raise exception 'Solo se puede revertir un pago en estado "pagado" (estado actual: %).', v_row.estado;
  end if;

  v_detalle := v_row.detalle_acreditacion;
  if v_detalle is null then
    raise exception 'Este pago no tiene detalle_acreditacion guardado -- no se puede revertir con precisión (es de antes de este cambio, o de un camino que todavía no lo completa).';
  end if;

  -- ── Revertir créditos por disciplina -- "lo ya gastado, gastado queda":
  -- nunca resta por debajo de 0. ──────────────────────────────────────────
  for v_credito in select * from jsonb_array_elements(coalesce(v_detalle->'creditos', '[]'::jsonb))
  loop
    v_discipline_id := (v_credito->>'discipline_id')::uuid;
    v_credits_otorgados := (v_credito->>'credits_otorgados')::int;
    -- Ausente en comprobantes de antes de la Fase 1 de lotes -- nullif
    -- cubre tanto la clave ausente (->> ya da null) como una string vacía.
    v_lote_id := nullif(v_credito->>'lote_id', '')::uuid;

    if v_discipline_id is null or v_credits_otorgados is null then
      continue;
    end if;

    if v_lote_id is not null then
      -- Camino preciso -- el lote real que este comprobante puntual creó o
      -- tocó. UPDATE en el lugar (no INSERT de una fila nueva): un lote es
      -- una fila persistente que se muta durante su vida, mismo criterio
      -- que ya usan book_class()/cancel_booking() para consumir/reintegrar.
      select remaining_credits into v_remaining_actual
      from user_credits
      where id = v_lote_id
      for update;

      if v_remaining_actual is not null then
        update user_credits
        set remaining_credits = greatest(0, v_remaining_actual - v_credits_otorgados)
        where id = v_lote_id;
        -- Lo que de verdad se le "recuperó" al pozo global de socios no
        -- puede ser más que lo que quedaba disponible en ESE lote puntual.
        v_total_revertido := v_total_revertido + least(v_credits_otorgados, v_remaining_actual);
      else
        -- El lote_id guardado ya no existe -- user_credits no borra filas
        -- nunca, así que esto no debería pasar en la práctica. Mejor
        -- avisar que adivinar sobre qué otra fila actuar.
        v_creditos_advertencia := concat_ws(
          ' | ', v_creditos_advertencia,
          format('No se encontró el lote de créditos original (id=%s) -- no se pudo revertir ese crédito puntual. Revisá el balance a mano.', v_lote_id)
        );
      end if;
    else
      -- Fallback legacy -- comprobante de antes de que detalle_acreditacion
      -- guardara lote_id (aprobado por el flujo viejo admin_aprobar_
      -- comprobante). Mismo comportamiento de siempre: la fila más reciente
      -- de esa disciplina -- con el mismo riesgo que el resto de este fix
      -- soluciona (puede no ser el mismo lote que este comprobante creó, si
      -- el socio tiene 2+ lotes activos) -- por eso se avisa explícito.
      select remaining_credits, expires_at into v_remaining_actual, v_expires_at_actual
      from user_credits
      where user_id = v_row.user_id and discipline_id = v_discipline_id
      order by created_at desc
      limit 1
      for update;

      if v_remaining_actual is not null then
        insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
        values (
          v_row.user_id, v_row.pack_id, v_discipline_id,
          greatest(0, v_remaining_actual - v_credits_otorgados),
          v_expires_at_actual
        );
        v_total_revertido := v_total_revertido + least(v_credits_otorgados, v_remaining_actual);
      end if;

      v_creditos_advertencia := concat_ws(
        ' | ', v_creditos_advertencia,
        'Este comprobante es de antes de que se guardara el lote exacto -- se revirtió con el criterio anterior (el lote más reciente de esa disciplina), que puede no ser el mismo que este pago creó si el socio tiene más de un lote activo. Revisá el balance del socio a mano si hace falta.'
      );
    end if;
  end loop;

  -- ── Revertir Aparatos -- SIN CAMBIOS, sigue siendo SOLO si nadie más lo
  -- tocó desde que se otorgó esta acreditación puntual. Aparatos nunca tuvo
  -- lotes, no hace falta tocar nada acá. ──────────────────────────────────
  v_aparatos := v_detalle->'aparatos';
  if v_aparatos is not null then
    v_aparatos_discipline_id := (v_aparatos->>'discipline_id')::uuid;
    v_fecha_antes := (v_aparatos->>'fecha_vencimiento_antes')::timestamptz; -- puede ser NULL (no tenía vigencia previa)
    v_fecha_despues := (v_aparatos->>'fecha_vencimiento_despues')::date;

    select expires_at into v_expires_at_aparatos_actual
    from user_credits
    where user_id = v_row.user_id and discipline_id = v_aparatos_discipline_id
    order by created_at desc
    limit 1
    for update;

    if v_expires_at_aparatos_actual::date = v_fecha_despues then
      insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
      values (v_row.user_id, v_row.pack_id, v_aparatos_discipline_id, null, v_fecha_antes);
    else
      v_aparatos_advertencia := 'La fecha de vencimiento de Aparatos no se pudo revertir automáticamente -- cambió desde que se otorgó esta acreditación. Ajustala a mano en "Editar Socio".';
    end if;
  end if;

  -- ── Espejo en socios -- simétrico: restar creditos siempre; la fecha
  -- solo se toca si Aparatos se pudo revertir limpio (sin SU advertencia --
  -- una advertencia de créditos no relacionada con Aparatos no debe
  -- bloquear esto). ────────────────────────────────────────────────────────
  select dni into v_dni from profiles where id = v_row.user_id;
  if v_dni is not null then
    update socios
    set creditos = greatest(0, coalesce(creditos, 0) - v_total_revertido),
        fecha_vencimiento = case
          when v_aparatos is not null and v_aparatos_advertencia is null
            then (v_fecha_antes at time zone 'America/Argentina/Mendoza')::date
          else fecha_vencimiento
        end
    where dni = v_dni;
  end if;

  update public.pagos_socio
  set estado = 'anulado',
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = p_pagos_socio_id;

  insert into notifications (sender_id, audience_type, target_user_id, title, body)
  values (
    auth.uid(), 'user', v_row.user_id,
    'Se revirtió una acreditación',
    'Se revirtió la acreditación de tu comprobante del ' ||
      to_char(v_row.created_at at time zone 'America/Argentina/Mendoza', 'DD/MM/YYYY') ||
      '. Si creés que es un error, contactá al gimnasio.'
  );

  return query select true, concat_ws(' | ', v_creditos_advertencia, v_aparatos_advertencia);
end;
$$;

grant execute on function public.admin_revertir_comprobante(uuid) to authenticated;

-- ============================================================
-- Verificación (NO CONECTADA a la UI real todavía). Usá socios/packs/
-- comprobantes de PRUEBA, no reales -- esto escribe de verdad en
-- user_credits/socios/pagos_socio/notifications.
--
-- Los Casos A-F de supabase_migration_auto_acreditar_y_revertir_
-- comprobante.sql siguen siendo válidos tal cual (regresión: un socio con
-- un solo lote de por medio -- "la fila más reciente" y "el lote_id exacto"
-- son la MISMA fila, el resultado tiene que ser idéntico a antes). Acá van
-- los casos NUEVOS específicos de este fix.
-- ============================================================

-- ── Caso G: 2 lotes de la MISMA disciplina, revertir el MÁS VIEJO -- tiene
-- que restar EXACTO del lote correcto, el otro queda intacto. Este es el
-- escenario de falla real que este fix soluciona. ──────────────────────────
-- 1) Elegí un socio de prueba y un pack de una sola disciplina de créditos:
-- select p.id as user_id, p.dni from profiles p where p.dni = '<DNI DE PRUEBA>';
-- select id as pack_id, name, creditos from packs
-- where incluye_aparatos = false and jsonb_array_length(creditos) = 1 limit 5;
--
-- 2) Acreditá el primer pack (simula la PWA -- "Run as" con el JWT del socio,
--    o usá crear_pago_pendiente_transferencia autenticado como él):
-- select crear_pago_pendiente_transferencia('<PACK_ID>', 'comprobantes-pago/<USER_ID_PRUEBA>/test1.jpg', <MONTO>);
-- Guardá el id devuelto como PAGO_1.
-- select detalle_acreditacion->'creditos'->0->>'lote_id' as lote_1
-- from pagos_socio where id = '<PAGO_1>'; -- guardalo como LOTE_1
--
-- 3) Para forzar que el segundo pack NO fusione (necesita caer en un día
--    calendario Argentina distinto -- ver supabase_migration_fix_zona_
--    horaria_fusion_lotes.sql), movele la fecha a LOTE_1 hacia atrás:
-- update user_credits set expires_at = expires_at - interval '5 days' where id = '<LOTE_1>';
--
-- 4) Acreditá el segundo pack de la MISMA disciplina:
-- select crear_pago_pendiente_transferencia('<PACK_ID>', 'comprobantes-pago/<USER_ID_PRUEBA>/test2.jpg', <MONTO>);
-- Guardá el id como PAGO_2.
-- select detalle_acreditacion->'creditos'->0->>'lote_id' as lote_2
-- from pagos_socio where id = '<PAGO_2>'; -- guardalo como LOTE_2 -- tiene
-- que ser DISTINTO de LOTE_1.
--
-- 5) Confirmá el estado ANTES de revertir -- 2 filas separadas:
-- select id, remaining_credits, expires_at from user_credits
-- where id in ('<LOTE_1>', '<LOTE_2>');
--
-- 6) Revertí PAGO_1 -- EL MÁS VIEJO, no el más reciente:
-- select * from admin_revertir_comprobante('<PAGO_1>');
-- Tiene que devolver reversion_ok=true, aparatos_advertencia=null (sin
-- ningún texto de advertencia -- había lote_id, camino preciso).
--
-- 7) LA CONFIRMACIÓN CLAVE de este fix:
-- select id, remaining_credits from user_credits where id = '<LOTE_1>';
-- -- Tiene que dar 0 (o greatest(0, ...) si ya tenía menos por algún gasto).
-- select id, remaining_credits from user_credits where id = '<LOTE_2>';
-- -- Tiene que seguir con el mismo remaining_credits que tenía en el paso 5
-- -- SIN TOCAR. Antes de este fix, este era justo el que quedaba en 0 por
-- -- error (por ser "el más reciente"), mientras LOTE_1 quedaba intacto.
--
-- 8) select estado from pagos_socio where id = '<PAGO_1>'; -- 'anulado'.

-- ── Caso H: comprobante SIN lote_id (legacy) -- fallback al criterio viejo
-- Y advertencia nueva explícita. ────────────────────────────────────────────
-- 1) Repetí el Caso A de la migración anterior (un socio de prueba nuevo,
--    un pack simple) -- guardá el id como PAGO_3.
-- 2) Simulá un comprobante viejo, de antes de que existiera lote_id --
--    borrale ese campo a mano del detalle guardado (esto reproduce
--    exactamente el shape que dejaba el flujo legacy admin_aprobar_
--    comprobante, que nunca lo grabó):
-- update pagos_socio
-- set detalle_acreditacion = jsonb_set(
--   detalle_acreditacion,
--   '{creditos}',
--   (select jsonb_agg(c - 'lote_id') from jsonb_array_elements(detalle_acreditacion->'creditos') c)
-- )
-- where id = '<PAGO_3>';
-- select detalle_acreditacion from pagos_socio where id = '<PAGO_3>'; -- confirmá que "lote_id" ya no aparece en ninguna entrada de creditos[].
--
-- 3) select * from admin_revertir_comprobante('<PAGO_3>');
-- Tiene que devolver reversion_ok=true, Y aparatos_advertencia CON texto
-- (el de "Este comprobante es de antes de que se guardara el lote exacto...").
--
-- 4) Confirmá que igual revirtió (con el criterio viejo, "la fila más
--    reciente" de esa disciplina para ese socio):
-- select discipline_id, remaining_credits from user_credits
-- where user_id = '<USER_ID_PRUEBA_3>' order by created_at desc limit 5;
-- select estado from pagos_socio where id = '<PAGO_3>'; -- 'anulado' igual --
-- la advertencia no bloquea la reversión, mismo criterio que la de Aparatos.

-- ── Limpieza opcional de los datos de prueba ────────────────────────────────
-- delete from pagos_socio where id in ('<PAGO_1>', '<PAGO_2>', '<PAGO_3>');
-- (revertir a mano cualquier fila de user_credits/socios que corresponda a
-- los socios de prueba usados acá)
