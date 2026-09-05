-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- FASE 2 -- máxima cautela: admin_aprobar_comprobante() es un camino
-- ACTIVO hoy (Seba lo usa todos los días en Pagos). mp_process_payment()
-- ya no tiene UI que la dispare (se sacó Mercado Pago de "Elegí tu pack"),
-- pero sigue viva por si llega una notificación vieja/tardía del webhook
-- de MP -- se trata con el mismo cuidado.
--
-- QUÉ CAMBIA Y QUÉ NO:
--   Se reemplaza, en las DOS funciones, el bloque de "loop de créditos +
--   extensión de Aparatos + espejo a socios" por UNA llamada a
--   acreditar_pack() (Fase 1, supabase_migration_acreditar_pack.sql, ya
--   validada en producción contra 4 casos reales). Nada más se toca:
--     - admin_aprobar_comprobante(): is_admin(), el lock `for update` +
--       chequeo de idempotencia por `reviewed_at`, el `raise exception` si
--       falta pack_id, el UPDATE de pagos_socio (estado/reviewed_by/
--       reviewed_at) y la notificación quedan EXACTAMENTE igual.
--     - mp_process_payment(): la firma (10 parámetros, sin cambios -- el
--       webhook los sigue llamando igual), el cálculo de v_estado, el
--       `insert ... on conflict do nothing` + `for update` + el UPDATE de
--       estado sobre una notificación repetida (idempotencia por
--       mercado_pago_payment_id) quedan EXACTAMENTE igual.
--
-- Efecto observable idéntico -- misma firma, mismo retorno, mismos
-- side-effects -- para AMBAS funciones. Es una refactorización interna.
--
-- Nota sobre mp_process_payment: p_creditos y p_aparatos_discipline_id
-- quedan en la firma (no se puede tocar sin romper al caller real,
-- greenfit-app/supabase/functions/mp-webhook/index.ts) pero DEJAN DE
-- USARSE -- acreditar_pack() resuelve packs.creditos/incluye_aparatos/
-- dias_vigencia y el discipline_id de Aparatos por sí misma, en vivo, a
-- partir de p_pack_id (mismo criterio que ya usa admin_aprobar_comprobante
-- para lo mismo). p_incluye_aparatos y p_dias_vigencia SÍ se siguen
-- usando, sin cambios, para calcular periodo_desde/periodo_hasta del
-- registro en pagos_socio -- eso no forma parte de la acreditación que se
-- extrajo, así que no se tocó.
--
-- Matiz real a tener presente (no es un bug de este cambio, es un efecto
-- de diseño ya decidido en la Fase 1): si en el rarísimo caso de una
-- notificación de MP muy demorada el pack se hubiera editado entre que se
-- generó la preferencia de pago y llegó la aprobación, antes se acreditaba
-- con la foto del pack tomada al crear la preferencia (p_creditos venía
-- pre-resuelto); ahora se acredita con el pack tal cual está AHORA en la
-- base. Con Mercado Pago ya sin UI que lo dispare, el riesgo real de este
-- caso es mínimo -- se documenta para que quede explícito, no para
-- resolverlo acá.

-- ============================================================
-- 1) admin_aprobar_comprobante()
-- ============================================================
create or replace function public.admin_aprobar_comprobante(p_pagos_socio_id uuid)
returns table (credito_otorgado boolean)
language plpgsql
security definer
as $$
declare
  v_row public.pagos_socio%rowtype;
  v_creditos_otorgados int;
  v_aparatos_extendido boolean;
  v_nueva_fecha_vencimiento_aparatos date;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select * into v_row from public.pagos_socio where id = p_pagos_socio_id for update;
  if not found then
    raise exception 'No existe ningún comprobante con id %.', p_pagos_socio_id;
  end if;

  -- Ya se revisó antes (aprobado o rechazado) -- no vuelve a acreditar.
  if v_row.reviewed_at is not null then
    return query select false;
    return;
  end if;

  if v_row.pack_id is null then
    raise exception 'Este comprobante no tiene pack_id asociado -- no se puede saber qué acreditar.';
  end if;

  -- Acreditación real -- ANTES era un loop de créditos + extensión de
  -- Aparatos + espejo a socios, duplicado acá Y en mp_process_payment
  -- (exactamente el patrón que generó el bug de Emilio Camargo). Ahora es
  -- una sola llamada a la función centralizada (Fase 1). Los 3 valores se
  -- capturan por si hace falta usarlos en el futuro (ej. loguear el detalle
  -- en la notificación) -- hoy no cambian el comportamiento de esta
  -- función, que sigue devolviendo solo credito_otorgado.
  select creditos_otorgados, aparatos_extendido, nueva_fecha_vencimiento_aparatos
    into v_creditos_otorgados, v_aparatos_extendido, v_nueva_fecha_vencimiento_aparatos
  from public.acreditar_pack(v_row.user_id, v_row.pack_id, 'transferencia_comprobante', null);

  update public.pagos_socio
  set estado = 'pagado',
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = p_pagos_socio_id;

  -- Notificación real al socio -- mismo mecanismo que ya usa
  -- NotificationsScreen.tsx (audience_type='user' + target_user_id).
  insert into notifications (sender_id, audience_type, target_user_id, title, body)
  values (
    auth.uid(),
    'user',
    v_row.user_id,
    '¡Tu comprobante fue aprobado!',
    'Ya acreditamos tu pago -- revisá tu saldo actualizado en Inicio.'
  );

  return query select true;
end;
$$;

grant execute on function public.admin_aprobar_comprobante(uuid) to authenticated;

-- ============================================================
-- 2) mp_process_payment()
-- ============================================================
create or replace function public.mp_process_payment(
  p_user_id uuid,
  p_pack_id uuid,
  p_creditos jsonb,               -- ya NO se usa -- ver nota en el header
  p_incluye_aparatos boolean,     -- SÍ se sigue usando (periodo_desde/hasta de pagos_socio)
  p_dias_vigencia int,            -- SÍ se sigue usando (idem)
  p_aparatos_discipline_id uuid,  -- ya NO se usa -- ver nota en el header
  p_amount numeric,
  p_paquete text,
  p_mp_payment_id text,
  p_mp_status text
)
returns table (credito_otorgado boolean)
language plpgsql
security definer
as $$
declare
  v_estado text;
  v_estado_previo text;
  v_otorgar boolean := false;
  v_creditos_otorgados int;
  v_aparatos_extendido boolean;
  v_nueva_fecha_vencimiento_aparatos date;
begin
  v_estado := case
    when p_mp_status = 'approved' then 'pagado'
    when p_mp_status in ('pending', 'in_process', 'authorized') then 'pendiente'
    else 'anulado'
  end;

  insert into pagos_socio (
    user_id, paquete, monto, metodo_pago, estado, origen, mercado_pago_payment_id,
    periodo_desde, periodo_hasta
  )
  values (
    p_user_id, p_paquete, p_amount, 'mercado_pago', v_estado, 'mercado_pago', p_mp_payment_id,
    case when p_incluye_aparatos then current_date else null end,
    case when p_incluye_aparatos then current_date + (coalesce(p_dias_vigencia, 0) || ' days')::interval else null end
  )
  on conflict (mercado_pago_payment_id) do nothing;

  if found then
    -- Fila nueva -- MP puede notificar directo en 'approved' sin pasar
    -- antes por 'pending' (pago con tarjeta, aprobación instantánea).
    v_otorgar := (v_estado = 'pagado');
  else
    -- Ya existía una notificación previa para este payment_id -- se
    -- bloquea ESA fila puntual antes de decidir (serializa a cualquier
    -- otra llamada concurrente para el mismo pago).
    select estado into v_estado_previo from pagos_socio where mercado_pago_payment_id = p_mp_payment_id for update;

    if v_estado_previo is distinct from 'pagado' then
      update pagos_socio set estado = v_estado where mercado_pago_payment_id = p_mp_payment_id;
    end if;

    v_otorgar := (v_estado = 'pagado') and (v_estado_previo is distinct from 'pagado');
  end if;

  if v_otorgar then
    -- Acreditación real -- misma extracción que en admin_aprobar_comprobante.
    select creditos_otorgados, aparatos_extendido, nueva_fecha_vencimiento_aparatos
      into v_creditos_otorgados, v_aparatos_extendido, v_nueva_fecha_vencimiento_aparatos
    from public.acreditar_pack(p_user_id, p_pack_id, 'mercado_pago', p_mp_payment_id);
  end if;

  return query select v_otorgar;
end;
$$;

grant execute on function public.mp_process_payment(uuid, uuid, jsonb, boolean, int, uuid, numeric, text, text, text) to authenticated;

-- ============================================================
-- Verificación (NO CONECTADA a la UI real todavía en el sentido de que
-- nada del frontend cambió -- pero estas SÍ son las funciones que la UI ya
-- llama, así que correr esto con datos de prueba escribe de verdad en
-- user_credits/socios/pagos_socio. Usá un socio y un comprobante de
-- PRUEBA, no reales.
-- ============================================================

-- ── Caso 1: admin_aprobar_comprobante() de punta a punta ────────────────────
-- 1) Elegí un socio de prueba y un pack real, y anotá el ANTES:
-- select p.id as user_id, p.dni from profiles p where p.dni = '<DNI DE PRUEBA>';
-- select id as pack_id, name, creditos, incluye_aparatos, dias_vigencia from packs where is_active = true limit 5;
-- select discipline_id, remaining_credits, expires_at from user_credits where user_id = '<USER_ID_PRUEBA>' order by created_at desc limit 10;
-- select creditos, fecha_vencimiento from socios where dni = '<DNI DE PRUEBA>';
--
-- 2) Insertá un comprobante de prueba PENDIENTE (simula lo que sube el
--    socio desde la PWA -- comprobante_url puede ser cualquier string, la
--    pantalla de Pagos muestra "Sin imagen disponible" si no resuelve una
--    URL firmada real, no rompe nada):
-- insert into pagos_socio (user_id, paquete, monto, metodo_pago, estado, origen, pack_id, comprobante_url)
-- values ('<USER_ID_PRUEBA>', '<NOMBRE DEL PACK>', <MONTO>, 'transferencia', 'pendiente', 'transferencia_comprobante', '<PACK_ID>', 'comprobantes-pago/<USER_ID_PRUEBA>/prueba-fase2.jpg')
-- returning id; -- guardate este id
--
-- 3) Aprobalo (logueado como admin real, o "Run as" con su JWT):
-- select * from admin_aprobar_comprobante('<ID DEL PASO 2>');
-- Tiene que devolver credito_otorgado = true.
--
-- 4) Confirmá el DESPUÉS -- tiene que ser IDÉNTICO a lo que ya viste al
--    validar acreditar_pack() sola en la Fase 1 para el mismo tipo de pack:
-- select discipline_id, remaining_credits, expires_at, created_at from user_credits where user_id = '<USER_ID_PRUEBA>' order by created_at desc limit 10;
-- select creditos, fecha_vencimiento from socios where dni = '<DNI DE PRUEBA>';
-- select estado, reviewed_by, reviewed_at from pagos_socio where id = '<ID DEL PASO 2>'; -- 'pagado', con reviewed_by/reviewed_at cargados
-- select id, title, body from notifications where target_user_id = '<USER_ID_PRUEBA>' order by created_at desc limit 1;

-- ── Caso 2: idempotencia -- aprobar la MISMA fila dos veces ─────────────────
-- select * from admin_aprobar_comprobante('<ID DEL PASO 2>'); -- de nuevo
-- Tiene que devolver credito_otorgado = false esta vez, y user_credits/
-- socios NO deben haber cambiado respecto del paso 4 de arriba (repetí las
-- mismas 2 selects y compará a mano).

-- ── Caso 3: mp_process_payment() de punta a punta (simulado, sin pegarle
-- a la API real de Mercado Pago) ────────────────────────────────────────────
-- 1) Mismo socio/pack de prueba, o uno nuevo -- anotá el ANTES igual que
--    en el Caso 1.
-- 2) Llamada directa (simula lo que hace mp-webhook/index.ts después de
--    confirmar el pago contra la API real de MP):
-- select * from mp_process_payment(
--   '<USER_ID_PRUEBA>', '<PACK_ID>',
--   (select creditos from packs where id = '<PACK_ID>'),
--   (select incluye_aparatos from packs where id = '<PACK_ID>'),
--   (select dias_vigencia from packs where id = '<PACK_ID>'),
--   (select id from disciplines where kind = 'membership' limit 1),
--   <MONTO>, '<NOMBRE DEL PACK>', 'test-mp-payment-fase2-001', 'approved'
-- );
-- Tiene que devolver credito_otorgado = true.
-- 3) Confirmá el DESPUÉS -- mismas 2 selects que en el Caso 1, paso 4.
-- 4) Idempotencia -- llamalo de nuevo con el MISMO 'test-mp-payment-fase2-001':
-- select * from mp_process_payment(... mismos params ..., 'test-mp-payment-fase2-001', 'approved');
-- Tiene que devolver credito_otorgado = false, sin acreditar una segunda vez.

-- ── Limpieza opcional de los datos de prueba insertados en este archivo ────
-- delete from pagos_socio where id = '<ID DEL PASO 2>';
-- delete from pagos_socio where mercado_pago_payment_id = 'test-mp-payment-fase2-001';
-- (revertir a mano cualquier fila de user_credits/socios que hayas tocado,
-- si el socio de prueba no debía quedar con ese balance)
