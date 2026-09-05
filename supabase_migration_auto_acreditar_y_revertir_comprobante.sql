-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- FASE 3 -- máxima cautela: cambia el flujo de negocio de comprobantes de
-- transferencia. Antes: el socio sube -> queda 'pendiente' -> Seba revisa y
-- aprueba/descarta (control PREVENTIVO). Ahora: se acredita automático al
-- subirse -> el control es REACTIVO (Seba revierte después si corresponde).
-- Decisión de negocio ya tomada -- no se vuelve a evaluar acá.
--
-- REQUIERE que ya estén aplicadas, en este orden:
--   1. supabase_migration_acreditar_pack.sql (Fase 1)
--   2. supabase_migration_fix_acreditar_pack_credito_perdido.sql (hotfix del
--      loop de créditos -- CRÍTICO tenerlo antes de este archivo: sin él,
--      un pack con una entrada de créditos rota podría auto-acreditarse
--      parcialmente en silencio, ahora SIN que ningún admin lo revise antes)
--   3. supabase_migration_conectar_acreditar_pack.sql (Fase 2, opcional para
--      este archivo en sí, pero recomendado: deja admin_aprobar_comprobante
--      funcionando con la lógica corregida para drenar cualquier comprobante
--      'pendiente' que haya quedado de ANTES del corte a este flujo nuevo)
--
-- Qué NO se toca en este archivo: acreditar_pack() en sí (Fase 1 + hotfix),
-- admin_aprobar_comprobante()/admin_rechazar_comprobante() (Fase 2) -- esas
-- dos quedan vivas a propósito, ver nota al final de este header.
--
-- ============================================================
-- POR QUÉ admin_aprobar_comprobante()/admin_rechazar_comprobante() NO SE
-- BORRAN EN ESTE CAMBIO
-- ============================================================
-- Al momento del corte a este flujo nuevo, puede haber comprobantes
-- 'pendiente' YA subidos por socios reales esperando revisión manual (el
-- flujo viejo). Esas filas necesitan poder aprobarse/descartarse una última
-- vez con las funciones viejas -- si se borraran ya, esos comprobantes
-- quedarían huérfanos para siempre (ni el admin ni ningún camino nuevo
-- sabe qué hacer con un pagos_socio en estado 'pendiente', porque el nuevo
-- flujo nunca vuelve a producir ese estado). Una vez confirmado que no
-- queda ningún 'pendiente' real (query de verificación al final), recién
-- ahí es seguro dropearlas en una migración de limpieza aparte -- mismo
-- criterio que ya se usó con la firma vieja de mp_process_payment
-- (supabase_migration_drop_mp_process_payment_vieja.sql).
--
-- ============================================================
-- DECISIÓN DE DISEÑO A CONFIRMAR (no es 100% mecánica, marcada a propósito)
-- ============================================================
-- detalle_acreditacion.creditos sale de leer packs.creditos DENTRO de
-- crear_pago_pendiente_transferencia() -- NO de un valor devuelto por
-- acreditar_pack() (esa función solo devuelve el TOTAL agregado, no el
-- desglose por disciplina). Esto es seguro porque acreditar_pack() (con el
-- hotfix aplicado) acredita el pack COMPLETO o tira excepción -- nunca una
-- fracción -- así que packs.creditos describe con exactitud lo que se
-- otorgó. Alternativa que NO elegí: cambiar la firma de retorno de
-- acreditar_pack() para que devuelva el desglose ella misma -- la descarté
-- para no volver a tocar una función que ya está validada en producción por
-- un cambio que no la necesita tocar. Avisame si preferís esa otra opción.

-- ============================================================
-- PASO 1 -- Columna nueva en pagos_socio.
-- ============================================================
alter table public.pagos_socio
  add column if not exists detalle_acreditacion jsonb;

comment on column public.pagos_socio.detalle_acreditacion is
  'Snapshot de qué se otorgó exactamente al acreditar este pago -- {"creditos": [{"discipline_id","credits_otorgados"}, ...], "aparatos": {"discipline_id","fecha_vencimiento_antes","fecha_vencimiento_despues"} | ausente}. Única fuente para poder revertir con precisión (admin_revertir_comprobante) -- sin esto, revertir significaría recalcular a ciegas.';

-- ============================================================
-- PASO 2 -- Auto-acreditación al subir el comprobante.
--
-- Mismo nombre de función (crear_pago_pendiente_transferencia) a propósito
-- -- así NO hace falta tocar el caller real (greenfit-app/src/lib/
-- comprobanteApi.ts, que ya la llama por nombre). El nombre queda
-- desactualizado (ya no crea nada "pendiente") -- se documenta acá, un
-- rename es un cambio de código en dos repos a la vez y no es necesario
-- para que esto funcione; se puede hacer aparte, sin apuro, más adelante.
-- ============================================================

create or replace function public.crear_pago_pendiente_transferencia(
  p_pack_id uuid,
  p_comprobante_url text,
  p_monto numeric
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_pack_name text;
  v_incluye_aparatos boolean;
  v_creditos jsonb;
  v_aparatos_discipline_id uuid;
  v_fecha_vencimiento_antes timestamptz;
  v_id uuid;
  v_creditos_otorgados int;
  v_aparatos_extendido boolean;
  v_nueva_fecha_vencimiento_aparatos date;
  v_detalle jsonb;
  v_detalle_creditos jsonb;
begin
  if not public.is_active_socio() then
    raise exception 'Esta acción requiere una cuenta de socio activa.';
  end if;

  if p_comprobante_url is null or length(trim(p_comprobante_url)) = 0 then
    raise exception 'Falta el comprobante.';
  end if;

  select name, incluye_aparatos, creditos
    into v_pack_name, v_incluye_aparatos, v_creditos
  from packs where id = p_pack_id and is_active = true;
  if v_pack_name is null then
    raise exception 'El pack indicado no existe o ya no está disponible.';
  end if;

  -- Snapshot del vencimiento de Aparatos ANTES de acreditar -- se necesita
  -- para poder revertir con precisión (ver admin_revertir_comprobante). Se
  -- lee ACÁ, antes de llamar a acreditar_pack(), porque esa función ya
  -- pisa la fila -- después de llamarla, "antes" ya no se puede recuperar.
  -- Mismo criterio de resolución de la disciplina de Aparatos que usa
  -- acreditar_pack() (kind='membership', asumida única -- misma limitación
  -- ya existente, no nueva acá).
  if v_incluye_aparatos then
    select id into v_aparatos_discipline_id from disciplines where kind = 'membership' limit 1;
    if v_aparatos_discipline_id is not null then
      select expires_at into v_fecha_vencimiento_antes
      from user_credits
      where user_id = auth.uid() and discipline_id = v_aparatos_discipline_id
      order by created_at desc
      limit 1;
    end if;
  end if;

  -- El estado queda 'pagado' DIRECTO -- ya no existe 'pendiente' en este
  -- flujo. reviewed_at/reviewed_by quedan NULL acá: pasan a significar "un
  -- admin lo revirtió", no "alguien lo aprobó" -- coherente con que ya no
  -- hay aprobación manual que registrar.
  insert into public.pagos_socio (
    user_id, paquete, monto, metodo_pago, estado, origen, pack_id, comprobante_url, created_by
  ) values (
    auth.uid(), v_pack_name, p_monto, 'transferencia', 'pagado', 'transferencia_comprobante',
    p_pack_id, p_comprobante_url, auth.uid()
  )
  returning id into v_id;

  -- Acreditación real, MISMA transacción -- si el pack estuviera roto (ver
  -- el hotfix de acreditar_pack()), esto tira una excepción y TODO se
  -- deshace: nunca queda una fila 'pagado' sin sus créditos reales, ni un
  -- comprobante "fantasma" acreditado a medias sin que nadie lo revise (ya
  -- no hay quién lo revise antes -- por eso este comportamiento importa
  -- más ahora que con el flujo viejo).
  select creditos_otorgados, aparatos_extendido, nueva_fecha_vencimiento_aparatos
    into v_creditos_otorgados, v_aparatos_extendido, v_nueva_fecha_vencimiento_aparatos
  from public.acreditar_pack(auth.uid(), p_pack_id, 'transferencia_comprobante', v_id::text);

  -- Detalle de qué se otorgó -- ver decisión de diseño en el header.
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'discipline_id', c->>'discipline_id',
             'credits_otorgados', (c->>'credits')::int
           )),
           '[]'::jsonb
         )
    into v_detalle_creditos
  from jsonb_array_elements(coalesce(v_creditos, '[]'::jsonb)) c;

  v_detalle := jsonb_build_object('creditos', v_detalle_creditos);
  if v_aparatos_extendido then
    v_detalle := v_detalle || jsonb_build_object(
      'aparatos', jsonb_build_object(
        'discipline_id', v_aparatos_discipline_id,
        'fecha_vencimiento_antes', v_fecha_vencimiento_antes,
        'fecha_vencimiento_despues', v_nueva_fecha_vencimiento_aparatos
      )
    );
  end if;

  update public.pagos_socio set detalle_acreditacion = v_detalle where id = v_id;

  -- Notificación real al socio -- mismo mecanismo de siempre, texto
  -- ajustado (ya no lo "aprueba" un admin, se acredita solo).
  insert into notifications (sender_id, audience_type, target_user_id, title, body)
  values (
    auth.uid(), 'user', auth.uid(),
    '¡Recibimos tu comprobante!',
    'Ya acreditamos tu pago -- revisá tu saldo actualizado en Inicio.'
  );

  return v_id;
end;
$$;

grant execute on function public.crear_pago_pendiente_transferencia(uuid, text, numeric) to authenticated;

-- ============================================================
-- PASO 3 -- admin_revertir_comprobante(): deshace una acreditación ya hecha.
-- ============================================================

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
  v_remaining_actual int;
  v_expires_at_actual timestamptz;
  v_aparatos jsonb;
  v_aparatos_discipline_id uuid;
  v_fecha_antes timestamptz;
  v_fecha_despues date;
  v_expires_at_aparatos_actual timestamptz;
  v_advertencia text := null;
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
  -- nunca resta por debajo de 0. INSERT de una fila nueva (no UPDATE en el
  -- lugar) -- mismo criterio de ledger append-only que ya usa
  -- acreditar_pack()/sincronizarCreditosPwa para esta tabla: la fila vieja
  -- queda de historial real, "la más reciente por created_at" sigue siendo
  -- el balance vigente para todo el resto del sistema (book_class,
  -- esta_habilitado_para_disciplina, fetchUserBalances). expires_at se
  -- preserva tal cual estaba -- revertir créditos no toca su vigencia. ────
  for v_credito in select * from jsonb_array_elements(coalesce(v_detalle->'creditos', '[]'::jsonb))
  loop
    v_discipline_id := (v_credito->>'discipline_id')::uuid;
    v_credits_otorgados := (v_credito->>'credits_otorgados')::int;
    if v_discipline_id is null or v_credits_otorgados is null then
      continue;
    end if;

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
      -- Lo que de verdad se le "recuperó" al pozo global de socios no puede
      -- ser más que lo que quedaba disponible -- si ya había gastado más de
      -- lo otorgado en esta tanda puntual (mezclado con otras tandas), no
      -- se le resta de más al pozo total.
      v_total_revertido := v_total_revertido + least(v_credits_otorgados, v_remaining_actual);
    end if;
  end loop;

  -- ── Revertir Aparatos -- SOLO si nadie más lo tocó desde que se otorgó
  -- esta acreditación puntual. ────────────────────────────────────────────
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
      -- Coincide exacto con lo que esta acreditación puntual dejó -- nadie
      -- lo tocó después. Restaurar es seguro. Mismo criterio append-only:
      -- INSERT de una fila nueva con la fecha de antes (si "antes" era
      -- NULL -- el socio no tenía Aparatos todavía -- la fila nueva queda
      -- con expires_at NULL, que ya se interpreta como vencido/sin
      -- vigencia en todo el resto del sistema, exactamente lo que
      -- corresponde).
      insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
      values (v_row.user_id, v_row.pack_id, v_aparatos_discipline_id, null, v_fecha_antes);
    else
      -- Alguna acreditación posterior (otra compra, otra corrección) ya
      -- movió la fecha -- restaurar a ciegas la pisaría y perdería ese
      -- cambio real. NO se toca nada -- se avisa en el resultado.
      v_advertencia := 'La fecha de vencimiento de Aparatos no se pudo revertir automáticamente -- cambió desde que se otorgó esta acreditación. Ajustala a mano en "Editar Socio".';
    end if;
  end if;

  -- ── Espejo en socios -- simétrico: restar creditos siempre; la fecha
  -- solo se toca si Aparatos se pudo revertir limpio (sin advertencia). ──
  select dni into v_dni from profiles where id = v_row.user_id;
  if v_dni is not null then
    update socios
    set creditos = greatest(0, coalesce(creditos, 0) - v_total_revertido),
        fecha_vencimiento = case
          when v_aparatos is not null and v_advertencia is null
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

  -- Notificación real al socio -- texto exacto pedido, con la fecha del
  -- comprobante original en formato Argentina.
  insert into notifications (sender_id, audience_type, target_user_id, title, body)
  values (
    auth.uid(), 'user', v_row.user_id,
    'Se revirtió una acreditación',
    'Se revirtió la acreditación de tu comprobante del ' ||
      to_char(v_row.created_at at time zone 'America/Argentina/Mendoza', 'DD/MM/YYYY') ||
      '. Si creés que es un error, contactá al gimnasio.'
  );

  return query select true, v_advertencia;
end;
$$;

grant execute on function public.admin_revertir_comprobante(uuid) to authenticated;

-- ============================================================
-- Verificación (NO CONECTADA a la UI real todavía). Usá socios/comprobantes
-- de PRUEBA, no reales -- esto escribe de verdad en user_credits/socios/
-- pagos_socio/notifications.
-- ============================================================

-- ── Caso A: flujo completo de punta a punta -- subir simula lo que hace la
-- PWA, después revertir. ────────────────────────────────────────────────
-- 1) Logueado como socio de prueba (o "Run as" con su JWT):
-- select crear_pago_pendiente_transferencia('<PACK_ID>', 'comprobantes-pago/<USER_ID_PRUEBA>/test.jpg', <MONTO>);
-- Devuelve el id del pago -- guardalo.
-- 2) Confirmá que quedó 'pagado' directo (no 'pendiente') y con detalle:
-- select estado, detalle_acreditacion from pagos_socio where id = '<ID DEL PASO 1>';
-- select discipline_id, remaining_credits, expires_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' order by created_at desc limit 10;

-- ── Caso B: revertir sin uso previo -- tiene que quedar en 0 ────────────────
-- select * from admin_revertir_comprobante('<ID DEL PASO 1>'); -- reversion_ok=true, aparatos_advertencia=null (si el pack no incluía Aparatos)
-- select discipline_id, remaining_credits from user_credits
-- where user_id = '<USER_ID_PRUEBA>' order by created_at desc limit 5;
-- -- remaining_credits de esa disciplina tiene que dar 0.
-- select estado, reviewed_by, reviewed_at from pagos_socio where id = '<ID DEL PASO 1>'; -- 'anulado'
-- select id, title, body from notifications where target_user_id = '<USER_ID_PRUEBA>' order by created_at desc limit 1;

-- ── Caso C: idempotencia -- revertir la MISMA fila dos veces ────────────────
-- select * from admin_revertir_comprobante('<ID DEL PASO 1>'); -- de nuevo
-- Tiene que devolver reversion_ok=false, aparatos_advertencia=null, y
-- user_credits/socios NO deben haber cambiado respecto del Caso B.

-- ── Caso D: créditos PARCIALMENTE gastados -- revierte solo lo que queda ──
-- 1) Repetí el Caso A con un socio/pack nuevo -- créditos otorgados = N.
-- 2) Gastá algunos ANTES de revertir (reservá M clases reales de esa
--    disciplina con ese socio desde la PWA, o simulá el gasto):
-- update user_credits set remaining_credits = remaining_credits - <M>
-- where user_id = '<USER_ID_PRUEBA_2>' and discipline_id = '<DISCIPLINE_ID>'
-- order by created_at desc limit 1; -- (ajustá si tu Postgres no soporta
-- UPDATE con ORDER BY -- hacelo por id puntual)
-- 3) select * from admin_revertir_comprobante('<ID DEL PAGO DEL PASO 1>');
-- 4) Confirmá: remaining_credits queda en greatest(0, (N - M) - N) = 0 si M < N,
--    o en (N-M)-N si de algún modo quedaba más de lo otorgado (no debería
--    pasar en este caso, pero greatest(0, ...) lo protege igual). Y
--    socios.creditos se descontó en min(N, N-M) = N-M, no en N completo.

-- ── Caso E: Aparatos revertido LIMPIO -- nadie lo tocó después ──────────────
-- 1) Repetí el Caso A con un pack que incluya Aparatos, socio de prueba
--    nuevo. Anotá el expires_at resultante.
-- 2) select * from admin_revertir_comprobante('<ID DE ESE PAGO>');
-- Tiene que devolver aparatos_advertencia = null.
-- 3) Confirmá que expires_at de Aparatos volvió EXACTO al valor de ANTES
--    de esa acreditación (null si el socio nunca había tenido Aparatos):
-- select expires_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = (select id from disciplines where kind='membership' limit 1)
-- order by created_at desc limit 1;
-- select fecha_vencimiento from socios where dni = (select dni from profiles where id = '<USER_ID_PRUEBA>');

-- ── Caso F: Aparatos con una acreditación POSTERIOR en el medio -- tiene
-- que avisar, NO corromper la fecha ──────────────────────────────────────
-- 1) Repetí el Caso A con un pack de Aparatos, socio de prueba nuevo --
--    guardá el ID de este primer pago (PAGO_1).
-- 2) Antes de revertir PAGO_1, otorgale OTRA acreditación de Aparatos al
--    mismo socio (simula un segundo pago real en el medio):
-- select crear_pago_pendiente_transferencia('<OTRO_PACK_CON_APARATOS>', 'comprobantes-pago/<USER_ID_PRUEBA>/test2.jpg', <MONTO>);
-- 3) select * from admin_revertir_comprobante('<ID DE PAGO_1>');
-- Tiene que devolver reversion_ok=true, PERO aparatos_advertencia CON el
-- texto de advertencia (no null).
-- 4) Confirmá que expires_at de Aparatos NO CAMBIÓ respecto de lo que dejó
--    el segundo pago (paso 2) -- la reversión de créditos (si el pack de
--    PAGO_1 también tenía créditos) sí se aplicó igual, solo Aparatos quedó
--    intacto:
-- select expires_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = (select id from disciplines where kind='membership' limit 1)
-- order by created_at desc limit 1;
-- -- Tiene que coincidir con lo que dejó el paso 2, NO con "antes" de PAGO_1.
-- select estado from pagos_socio where id = '<ID DE PAGO_1>'; -- 'anulado' igual -- la advertencia no bloquea la reversión de lo demás.

-- ── Limpieza opcional de los datos de prueba ────────────────────────────────
-- delete from pagos_socio where id in ('<ID DEL PASO 1>', ...);
-- (revertir a mano cualquier fila de user_credits/socios que corresponda a
-- los socios de prueba usados acá)

-- ============================================================
-- Verificación de que ya no queda ningún 'pendiente' del flujo viejo antes
-- de considerar dropear admin_aprobar_comprobante/admin_rechazar_comprobante
-- en una migración de limpieza aparte:
-- select count(*) from pagos_socio where estado = 'pendiente' and origen = 'transferencia_comprobante';
-- Tiene que dar 0 antes de esa limpieza.
-- ============================================================
