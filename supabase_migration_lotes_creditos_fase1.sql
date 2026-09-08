-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- FASE 1 del rediseño de créditos por lotes -- SOLO los cimientos. NO se
-- conecta a book_class()/admin_book_class()/cancel_booking()/
-- admin_cancel_booking()/esta_habilitado_para_disciplina()/
-- registrar_hoy_entrene() ni a admin_revertir_comprobante() en este script
-- -- esas siguen leyendo "la fila más reciente" exactamente como hoy, y
-- van a seguir funcionando (sin aprovechar los lotes todavía) hasta las
-- fases siguientes. El único cambio de comportamiento real de este script
-- es CÓMO se acreditan créditos nuevos -- no cómo se leen ni se gastan.
--
-- Requiere tener aplicado (en este orden): acreditar_pack (Fase 1 vieja) +
-- el hotfix del loop + conectar_acreditar_pack (Fase 2) +
-- auto_acreditar_y_revertir_comprobante (Fase 3, admin_revertir_comprobante
-- y la columna detalle_acreditacion) -- este script reemplaza funciones que
-- ya están vigentes por esas fases anteriores.
--
-- Decisiones de negocio YA CONFIRMADAS (no se vuelven a evaluar acá):
--   - Cada acreditación de créditos es un lote independiente -- nunca se
--     suma sobre el balance existente de otra fecha.
--   - Excepción: si ya existe un lote ACTIVO (remaining_credits > 0, sin
--     importar si venció) para la misma disciplina+socio cuyo
--     expires_at::date coincide EXACTO (mismo día calendario) con la fecha
--     que le tocaría al lote nuevo, se fusionan (se suma sobre esa fila).
--   - Aparatos NO cambia -- sigue siendo una sola fecha que se extiende
--     (greatest(vigente, hoy) + dias_vigencia), sin lotes -- es una
--     membresía sin cantidad, no hay nada que "lotear".
--   - El espejo a `socios` (creditos/fecha_vencimiento) NO cambia -- sigue
--     sumando el total global, sin desglose por lote.

-- ============================================================
-- PASO 1 -- Columna de trazabilidad en bookings (para fases futuras, NO SE
-- USA todavía en esta -- book_class() no la toca en este script).
-- ============================================================
alter table public.bookings
  add column if not exists credit_lote_id uuid references public.user_credits(id);

comment on column public.bookings.credit_lote_id is
  'De qué lote de user_credits salió el crédito de esta reserva -- null para reservas de Aparatos (no tiene lotes) y para reservas ya existentes antes de este cambio (no hay forma honesta de reconstruirlo retroactivamente). Se completa recién cuando book_class()/admin_book_class() se migren al modelo de lotes (fase siguiente) -- hasta entonces queda null para TODA reserva nueva también.';

-- ============================================================
-- PASO 2 -- acreditar_pack(): créditos reales por lote.
--
-- Cambia el RETURN TYPE (se agrega creditos_lotes) -- Postgres no permite
-- `create or replace` cuando cambian las columnas de un `returns table`,
-- hace falta dropear primero. Mismo nombre y mismos 4 parámetros de
-- entrada -- ningún caller necesita cambiar su firma de llamada.
-- ============================================================

drop function if exists public.acreditar_pack(uuid, uuid, text, text);

create or replace function public.acreditar_pack(
  p_user_id uuid,
  p_pack_id uuid,
  p_origen text,
  p_referencia_externa text default null
)
returns table (
  creditos_otorgados int,
  aparatos_extendido boolean,
  nueva_fecha_vencimiento_aparatos date,
  -- NUEVO -- [{"discipline_id","credits_otorgados","lote_id"}, ...] -- una
  -- entrada por disciplina de créditos del pack, con el id REAL de la fila
  -- de user_credits que se tocó (nueva o fusionada). El caller lo necesita
  -- para poder guardar en detalle_acreditacion cuál lote exacto revertir
  -- después (ver PASO 3) -- sin esto, el caller no tiene forma de saberlo,
  -- porque la decisión de fusionar o crear un lote nuevo es interna acá.
  creditos_lotes jsonb
)
language plpgsql
security definer
as $$
declare
  v_creditos jsonb;
  v_incluye_aparatos boolean;
  v_dias_vigencia int;
  v_aparatos_discipline_id uuid;
  v_credito jsonb;
  v_discipline_id uuid;
  v_credits int;
  v_discipline_ids_vistos uuid[] := '{}';
  v_total_creditos int := 0;
  v_dni text;
  v_nueva_fecha_vencimiento timestamptz;
  v_aparatos_extendido boolean := false;
  v_fecha_nuevo_lote timestamptz;
  v_lote_id uuid;
  v_creditos_lotes jsonb := '[]'::jsonb;
begin
  if p_origen not in ('manual', 'mercado_pago', 'transferencia_comprobante') then
    raise exception 'p_origen inválido: "%". Tiene que ser uno de: manual, mercado_pago, transferencia_comprobante.', p_origen;
  end if;

  select creditos, incluye_aparatos, dias_vigencia
    into v_creditos, v_incluye_aparatos, v_dias_vigencia
  from packs where id = p_pack_id;

  if not found then
    raise exception 'El pack % no existe.', p_pack_id;
  end if;

  if v_incluye_aparatos then
    select id into v_aparatos_discipline_id from disciplines where kind = 'membership' limit 1;
  end if;

  -- ── Loop de créditos por disciplina -- MODELO DE LOTES. Las validaciones
  -- de entrada mal formada/duplicada (hotfix anterior) quedan IGUAL, sin
  -- tocar. Lo que cambia es qué se hace con cada entrada válida. ─────────
  for v_credito in select * from jsonb_array_elements(coalesce(v_creditos, '[]'::jsonb))
  loop
    v_discipline_id := (v_credito->>'discipline_id')::uuid;
    v_credits := (v_credito->>'credits')::int;

    if v_discipline_id is null then
      raise exception 'El pack % tiene una entrada de créditos sin discipline_id válido: %', p_pack_id, v_credito;
    end if;
    if v_credits is null or v_credits <= 0 then
      raise exception 'El pack % tiene una entrada de créditos inválida para la disciplina % (credits=%)', p_pack_id, v_discipline_id, v_credito->>'credits';
    end if;
    if v_discipline_id = any(v_discipline_ids_vistos) then
      raise exception 'El pack % repite la disciplina % más de una vez en su lista de créditos -- corregí el pack antes de acreditar.', p_pack_id, v_discipline_id;
    end if;
    v_discipline_ids_vistos := array_append(v_discipline_ids_vistos, v_discipline_id);

    -- La fecha que le correspondería a este lote SI fuera nuevo -- se
    -- calcula ANTES de buscar, para comparar con el mismo criterio (día
    -- calendario) contra los lotes que ya existen. `now()` es estable
    -- dentro de toda la transacción -- da igual en qué punto del loop se
    -- evalúe.
    v_fecha_nuevo_lote := now() + interval '30 days';

    -- ¿Ya hay un lote ACTIVO (remaining_credits > 0 -- la fusión es por
    -- fecha, no por vigencia: un lote vencido con saldo igual cuenta) para
    -- esta disciplina+socio que vence el MISMO día calendario? `for update`
    -- lo bloquea antes de decidir -- evita que dos acreditaciones casi
    -- simultáneas (dos comprobantes aprobados a la vez) fusionen sobre la
    -- misma fila sin verse una a la otra.
    select id into v_lote_id
    from user_credits
    where user_id = p_user_id
      and discipline_id = v_discipline_id
      and remaining_credits > 0
      and expires_at::date = v_fecha_nuevo_lote::date
    order by created_at desc
    limit 1
    for update;

    if v_lote_id is not null then
      -- Fusión -- mismo día calendario que un lote con saldo. Se suma
      -- sobre ESA fila puntual; su expires_at no se toca (ya coincide, por
      -- la propia condición de la búsqueda de arriba).
      update user_credits
      set remaining_credits = remaining_credits + v_credits
      where id = v_lote_id;
    else
      -- Lote nuevo e independiente -- NUNCA suma sobre el balance de otra
      -- fecha, ni de la misma disciplina. remaining_credits arranca
      -- exactamente en lo que trae ESTE pack, no en "lo anterior + esto".
      insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
      values (p_user_id, p_pack_id, v_discipline_id, v_credits, v_fecha_nuevo_lote)
      returning id into v_lote_id;
    end if;

    v_total_creditos := v_total_creditos + v_credits;
    v_creditos_lotes := v_creditos_lotes || jsonb_build_array(
      jsonb_build_object('discipline_id', v_discipline_id, 'credits_otorgados', v_credits, 'lote_id', v_lote_id)
    );
  end loop;

  -- ── Extensión de Aparatos -- SIN CAMBIOS. Aparatos no tiene lotes: es
  -- una membresía sin cantidad, una sola fecha que se extiende. ─────────
  if v_incluye_aparatos and v_aparatos_discipline_id is not null and v_dias_vigencia is not null and v_dias_vigencia > 0 then
    v_nueva_fecha_vencimiento := greatest(
      coalesce(
        (select expires_at from user_credits
         where user_id = p_user_id and discipline_id = v_aparatos_discipline_id
         order by created_at desc limit 1),
        now()
      ),
      now()
    ) + (v_dias_vigencia || ' days')::interval;

    insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
    values (p_user_id, p_pack_id, v_aparatos_discipline_id, null, v_nueva_fecha_vencimiento);

    v_aparatos_extendido := true;
  end if;

  -- ── Espejo en socios -- SIN CAMBIOS. ────────────────────────────────────
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    update socios
    set creditos = coalesce(creditos, 0) + v_total_creditos,
        fecha_vencimiento = coalesce(
          (v_nueva_fecha_vencimiento at time zone 'America/Argentina/Mendoza')::date,
          fecha_vencimiento
        )
    where dni = v_dni;
  end if;

  return query select
    v_total_creditos,
    v_aparatos_extendido,
    (v_nueva_fecha_vencimiento at time zone 'America/Argentina/Mendoza')::date,
    v_creditos_lotes;
end;
$$;

grant execute on function public.acreditar_pack(uuid, uuid, text, text) to authenticated;

-- ============================================================
-- PASO 3a -- crear_pago_pendiente_transferencia(): guarda el lote_id real
-- en detalle_acreditacion.creditos (necesario para admin_revertir_
-- comprobante() en la fase siguiente -- NO se implementa esa parte acá,
-- solo se guarda el dato).
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
  v_aparatos_discipline_id uuid;
  v_fecha_vencimiento_antes timestamptz;
  v_id uuid;
  v_creditos_otorgados int;
  v_aparatos_extendido boolean;
  v_nueva_fecha_vencimiento_aparatos date;
  v_creditos_lotes jsonb;
  v_detalle jsonb;
begin
  if not public.is_active_socio() then
    raise exception 'Esta acción requiere una cuenta de socio activa.';
  end if;

  if p_comprobante_url is null or length(trim(p_comprobante_url)) = 0 then
    raise exception 'Falta el comprobante.';
  end if;

  select name, incluye_aparatos
    into v_pack_name, v_incluye_aparatos
  from packs where id = p_pack_id and is_active = true;
  if v_pack_name is null then
    raise exception 'El pack indicado no existe o ya no está disponible.';
  end if;

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

  insert into public.pagos_socio (
    user_id, paquete, monto, metodo_pago, estado, origen, pack_id, comprobante_url, created_by
  ) values (
    auth.uid(), v_pack_name, p_monto, 'transferencia', 'pagado', 'transferencia_comprobante',
    p_pack_id, p_comprobante_url, auth.uid()
  )
  returning id into v_id;

  -- Ya NO hace falta reconstruir el detalle de créditos leyendo
  -- packs.creditos por separado (como en la Fase 3 anterior) -- ahora
  -- acreditar_pack() devuelve directamente creditos_lotes con el lote_id
  -- real de cada disciplina.
  select creditos_otorgados, aparatos_extendido, nueva_fecha_vencimiento_aparatos, creditos_lotes
    into v_creditos_otorgados, v_aparatos_extendido, v_nueva_fecha_vencimiento_aparatos, v_creditos_lotes
  from public.acreditar_pack(auth.uid(), p_pack_id, 'transferencia_comprobante', v_id::text);

  v_detalle := jsonb_build_object('creditos', coalesce(v_creditos_lotes, '[]'::jsonb));
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
-- PASO 3b -- mp_process_payment(): agrega detalle_acreditacion.creditos con
-- el lote_id real -- ESTO NO EXISTÍA ANTES de este script (a diferencia de
-- crear_pago_pendiente_transferencia, esta función nunca había llegado a
-- grabar detalle_acreditacion en ninguna fase anterior). Alcance acotado a
-- propósito: SOLO se agrega la parte de `creditos` (lo que pediste
-- explícitamente) -- la parte de `aparatos` de detalle_acreditacion
-- (fecha_vencimiento_antes/despues) NO se agrega acá, porque hacerlo bien
-- requeriría el mismo snapshot "ANTES de acreditar" que sí tiene
-- crear_pago_pendiente_transferencia, y esta función nunca lo tuvo --
-- agregarlo a medias (ej. con fecha_vencimiento_antes en null) dejaría un
-- revert de Aparatos-vía-MP silenciosamente roto en la fase siguiente, que
-- es peor que dejarlo ausente con este comentario. Impacto real hoy: bajo
-- -- Mercado Pago ya no tiene UI que lo dispare, esta función solo sigue
-- viva por si llega una notificación vieja del webhook.
-- ============================================================

create or replace function public.mp_process_payment(
  p_user_id uuid,
  p_pack_id uuid,
  p_creditos jsonb,
  p_incluye_aparatos boolean,
  p_dias_vigencia int,
  p_aparatos_discipline_id uuid,
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
  v_creditos_lotes jsonb;
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
    v_otorgar := (v_estado = 'pagado');
  else
    select estado into v_estado_previo from pagos_socio where mercado_pago_payment_id = p_mp_payment_id for update;

    if v_estado_previo is distinct from 'pagado' then
      update pagos_socio set estado = v_estado where mercado_pago_payment_id = p_mp_payment_id;
    end if;

    v_otorgar := (v_estado = 'pagado') and (v_estado_previo is distinct from 'pagado');
  end if;

  if v_otorgar then
    select creditos_otorgados, aparatos_extendido, nueva_fecha_vencimiento_aparatos, creditos_lotes
      into v_creditos_otorgados, v_aparatos_extendido, v_nueva_fecha_vencimiento_aparatos, v_creditos_lotes
    from public.acreditar_pack(p_user_id, p_pack_id, 'mercado_pago', p_mp_payment_id);

    update pagos_socio
    set detalle_acreditacion = jsonb_build_object('creditos', coalesce(v_creditos_lotes, '[]'::jsonb))
    where mercado_pago_payment_id = p_mp_payment_id;
  end if;

  return query select v_otorgar;
end;
$$;

grant execute on function public.mp_process_payment(uuid, uuid, jsonb, boolean, int, uuid, numeric, text, text, text) to authenticated;

-- ============================================================
-- Verificación (NO CONECTADA a book_class ni a nada que gaste créditos --
-- solo ejercita la acreditación). Usá un socio y un pack de PRUEBA, no
-- reales -- esto escribe de verdad en user_credits/socios/pagos_socio.
-- ============================================================

-- ── Caso A: 2 packs de la MISMA disciplina, en momentos que NO caen el
-- mismo día calendario -- tienen que quedar como 2 FILAS SEPARADAS. ───────
-- 1) Elegí un socio y un pack de una sola disciplina de créditos:
-- select p.id as user_id, p.dni from profiles p where p.dni = '<DNI DE PRUEBA>';
-- select id as pack_id, name, creditos from packs
-- where incluye_aparatos = false and jsonb_array_length(creditos) = 1 limit 5;
--
-- 2) Acreditá el primero:
-- select creditos_lotes from public.acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID>', 'manual');
--
-- 3) ANTES de acreditar el segundo, corré esto para simular que el primer
--    lote quedó con una fecha de un día distinto (si tu pack de prueba usa
--    siempre "hoy + 30 días", los dos van a caer el mismo día si los corrés
--    en la misma sesión -- para forzar el caso "días distintos" sin
--    esperar 30 días de verdad, corré este UPDATE sobre el lote recién
--    creado, moviéndole la fecha a mano SOLO para la prueba):
-- update user_credits set expires_at = expires_at - interval '5 days'
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID>'
-- order by created_at desc limit 1; -- (si tu Postgres no soporta UPDATE
-- con ORDER BY, hacelo por id puntual, tomado del select del paso 2)
--
-- 4) Acreditá el segundo pack (misma disciplina):
-- select creditos_lotes from public.acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID>', 'manual');
--
-- 5) Confirmá 2 FILAS separadas, cada una con SU propia cantidad y fecha
--    (ninguna suma sobre la otra):
-- select id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID>'
-- order by created_at desc;
-- Tiene que haber 2 filas, cada una con remaining_credits = lo que traía
-- CADA pack por separado (no la suma), y expires_at distinto entre ellas.

-- ── Caso B: 2 packs de la MISMA disciplina, el MISMO día calendario --
-- tienen que FUSIONARSE en una sola fila con la suma. ──────────────────────
-- 1) Con un socio de prueba NUEVO (sin créditos previos en esa disciplina),
--    acreditá el primer pack:
-- select creditos_lotes from public.acreditar_pack('<USER_ID_PRUEBA_2>', '<PACK_ID>', 'manual');
-- Anotá el lote_id que devuelve.
--
-- 2) Acreditá el segundo pack de la MISMA disciplina, EN LA MISMA SESIÓN
--    (sin tocarle la fecha a mano esta vez -- los dos van a caer en
--    "hoy + 30 días", mismo día calendario):
-- select creditos_lotes from public.acreditar_pack('<USER_ID_PRUEBA_2>', '<PACK_ID>', 'manual');
-- El lote_id que devuelve tiene que ser EL MISMO que en el paso 1 -- eso
-- confirma que fusionó en vez de crear uno nuevo.
--
-- 3) Confirmá UNA SOLA FILA con la SUMA de ambos packs:
-- select id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA_2>' and discipline_id = '<DISCIPLINE_ID>'
-- order by created_at desc;
-- Tiene que haber 1 sola fila, con remaining_credits = suma de los 2 packs,
-- y solo 1 created_at (la del primer insert -- la fusión hace UPDATE, no
-- inserta una fila nueva).

-- ── Caso C: combo con Aparatos -- confirmar que Aparatos NO cambió nada. ──
-- select * from public.acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID_CON_APARATOS>', 'manual');
-- aparatos_extendido tiene que dar true, nueva_fecha_vencimiento_aparatos
-- la fecha esperada -- mismo comportamiento exacto que antes de este
-- script (greatest(vigente,hoy)+dias_vigencia, una sola fila, sin lotes).

-- ── Caso D: confirmar que detalle_acreditacion ahora trae el lote_id ──────
-- 1) select crear_pago_pendiente_transferencia('<PACK_ID>', 'comprobantes-pago/<USER_ID_PRUEBA>/test.jpg', <MONTO>);
-- 2) select detalle_acreditacion from pagos_socio where id = '<ID DEL PASO 1>';
-- Tiene que verse algo como:
-- {"creditos": [{"discipline_id": "...", "credits_otorgados": N, "lote_id": "..."}]}
-- Confirmá que ese "lote_id" es un id REAL de user_credits:
-- select * from user_credits where id = '<LOTE_ID DEL JSON DE ARRIBA>';

-- ── Regresión -- los 4 casos ya validados en la Fase 1 vieja de
-- acreditar_pack (pack simple, combo con Aparatos, origen inválido, pack
-- inexistente) y los 4 del hotfix (combo 2 créditos sin Aparatos, entrada
-- rota, credits inválido, disciplina duplicada) siguen dando el mismo
-- resultado -- repetilos tal cual están en los archivos de esas fases,
-- ahora vas a ver además el campo creditos_lotes nuevo en cada resultado.

-- ============================================================
-- IMPORTANTE -- confirmado en esta fase, NO se toca todavía (es la fase de
-- UI, aparte):
-- ============================================================
-- fetchUserBalances() (greenfit-app/src/lib/creditsApi.ts:134-139) y
-- fetchCreditosPorDisciplina() (PAGINA SUPABASE/src/utils/fichaSocioPwa.js:
-- 119-138) siguen asumiendo "la fila más reciente por disciplina gana".
-- Después de este script, un socio con 2+ lotes activos de la misma
-- disciplina (Caso A de arriba) va a ver en la PWA y en el Admin SOLO el
-- lote más nuevo -- el otro lote sigue existiendo y sigue siendo válido
-- (nada se perdió en la base), pero la PWA/Admin le van a mostrar un
-- número de créditos INCOMPLETO (le falta sumar el otro lote) hasta que
-- esas dos funciones se actualicen para sumar/listar TODOS los lotes
-- activos en vez de quedarse con uno solo. Confirmalo vos mismo antes de
-- avisarle a ningún socio real que ya puede tener packs de la misma
-- disciplina con vencimientos distintos -- hasta la fase de UI, el número
-- que ve en pantalla puede ser menor al que realmente tiene disponible.
