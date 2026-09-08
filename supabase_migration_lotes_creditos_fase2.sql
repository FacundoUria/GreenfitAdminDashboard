-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- FASE 2 del rediseño de créditos por lotes -- MÁXIMA CAUTELA: esto toca
-- las funciones que usa CADA reserva y CADA cancelación real, todos los
-- días (mismo nivel de cuidado que cuando conectamos el chequeo de
-- vencimiento a book_class). Requiere la Fase 1 (acreditar_pack con lotes
-- reales + bookings.credit_lote_id) ya aplicada.
--
-- QUÉ CAMBIA: las funciones que LEEN y GASTAN los lotes que ya se vienen
-- creando bien desde la Fase 1. Hoy todas asumen "una sola fila = el
-- balance total" (el patrón `order by created_at desc limit 1`) -- pasan a
-- elegir el lote correcto entre varios posibles.
--
-- Regla de negocio YA CONFIRMADA (no se vuelve a evaluar acá):
--   - Reservar descuenta del lote ACTIVO (remaining_credits>0,
--     expires_at>now()) que vence MÁS PRONTO -- FIFO por expires_at
--     ascendente, no por antigüedad de creación.
--   - Cancelar reintegra al lote EXACTO del que se descontó
--     (bookings.credit_lote_id) -- si ese lote específico ya venció para
--     el momento de cancelar, NO se reintegra nada (ni ahí ni en otro
--     lado). Si sigue vigente, se reintegra ahí.
--   - Fallback para reservas SIN credit_lote_id (de antes de este cambio,
--     o cualquier caso sin el dato): mismo criterio FIFO que el resto de
--     esta fase -- reintegra al lote VIGENTE (expires_at>now()) que vence
--     MÁS PRONTO, no al más reciente por creación (a diferencia del
--     comportamiento que existía antes de esta fase -- ajustado a pedido
--     explícito, para que todo el archivo use el mismo criterio). Si no
--     hay ningún lote vigente, no se reintegra nada (mismo espíritu que el
--     camino con credit_lote_id: sin destino vigente, no hay reintegro).
--
-- Aparatos: en la práctica, book_class()/admin_book_class() nunca llegan a
-- reservar Aparatos con éxito (sus filas en user_credits tienen
-- remaining_credits=null siempre, así que el chequeo de créditos las
-- rechaza -- comportamiento que YA existía antes de esta fase, no se
-- toca). Por eso el fallback de cancel_booking() para Aparatos es en
-- gran medida teórico -- lo dejo igual por las dudas, sin cambiar nada de
-- lo que ya hacía.

-- ============================================================
-- PASO 1 -- esta_habilitado_para_disciplina(): créditos = "¿existe algún
-- lote vigente con saldo?", ya no "¿la fila más reciente tiene saldo?".
-- Aparatos: SIN CAMBIOS.
-- ============================================================

create or replace function public.esta_habilitado_para_disciplina(p_user_id uuid, p_discipline_id uuid)
returns boolean
language plpgsql
security definer
stable
as $$
declare
  v_kind text;
  v_fecha_vencimiento date;
  v_activo boolean;
begin
  select kind into v_kind from disciplines where id = p_discipline_id;
  if v_kind is null then
    return false;
  end if;

  if v_kind = 'membership' then
    -- SIN CAMBIOS -- Aparatos sigue siendo socios.fecha_vencimiento en
    -- vivo + activo, no lotes.
    select s.fecha_vencimiento, s.activo into v_fecha_vencimiento, v_activo
    from public.profiles p
    join public.socios s on s.dni = p.dni
    where p.id = p_user_id
    limit 1;

    if v_fecha_vencimiento is null then
      return false;
    end if;

    return coalesce(v_activo, false) and v_fecha_vencimiento >= current_date;
  end if;

  if v_kind = 'credits' then
    -- NUEVO -- alcanza con que UN lote esté vigente con saldo, sin
    -- importar si es el más nuevo, el más viejo, o si hay otros lotes ya
    -- vencidos o agotados para la misma disciplina. Esto además corrige un
    -- caso que el código anterior fallaba: un socio con el lote más
    -- reciente vencido pero uno más viejo todavía vigente con saldo
    -- (fecha "de creación" y fecha "de vencimiento" no siempre van en el
    -- mismo orden).
    return exists (
      select 1 from public.user_credits
      where user_id = p_user_id and discipline_id = p_discipline_id
        and remaining_credits > 0
        and expires_at > now()
    );
  end if;

  return false;
end;
$$;

grant execute on function public.esta_habilitado_para_disciplina(uuid, uuid) to authenticated;

-- ============================================================
-- PASO 2 -- book_class() / admin_book_class(): FIFO por expires_at
-- ascendente + guardar credit_lote_id en la reserva.
-- ============================================================

-- 2a) book_class() -- el socio reserva para sí mismo.
create or replace function public.book_class(p_class_id uuid, p_booking_date date)
returns uuid
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_capacity int;
  v_discipline_id uuid;
  v_days_of_week integer[];
  v_booked_count int;
  v_credit_id uuid;
  v_booking_id uuid;
  v_xp_reserva int;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  select capacity, discipline_id, days_of_week into v_capacity, v_discipline_id, v_days_of_week
  from classes where id = p_class_id for update;
  if v_capacity is null then
    raise exception 'La clase no existe';
  end if;

  if not public.esta_habilitado_para_disciplina(v_user_id, v_discipline_id) then
    raise exception 'Tu plan/créditos para esta disciplina están vencidos. No podés reservar hasta regularizar tu situación.';
  end if;

  if not (extract(dow from p_booking_date)::int = any(v_days_of_week)) then
    raise exception 'Esta clase no se dicta ese día.';
  end if;

  select count(*) into v_booked_count
  from bookings where class_id = p_class_id and booking_date = p_booking_date;
  if v_booked_count >= v_capacity then
    raise exception 'Sin cupo';
  end if;

  -- NUEVO -- FIFO por expires_at ascendente: el lote que vence MÁS PRONTO
  -- entre los que todavía tienen saldo Y no vencieron. Antes: "la fila más
  -- reciente por created_at", sin mirar cuál vencía antes.
  select id into v_credit_id
  from user_credits
  where user_id = v_user_id and discipline_id = v_discipline_id
    and remaining_credits > 0
    and expires_at > now()
  order by expires_at asc
  limit 1
  for update;

  if v_credit_id is null then
    raise exception 'Sin créditos disponibles para esta disciplina';
  end if;

  -- NUEVO -- credit_lote_id: de qué lote salió este descuento, para poder
  -- reintegrarlo EXACTO ahí si se cancela (ver cancel_booking() más abajo).
  insert into bookings (user_id, class_id, booking_date, credit_lote_id)
  values (v_user_id, p_class_id, p_booking_date, v_credit_id)
  returning id into v_booking_id;

  update user_credits set remaining_credits = remaining_credits - 1 where id = v_credit_id;

  begin
    select coalesce(xp_por_reserva, 100) into v_xp_reserva from configuracion where id = 1;
  exception when others then
    v_xp_reserva := null;
  end;
  if v_xp_reserva is null then
    v_xp_reserva := 100;
  end if;

  insert into xp_events (user_id, event_type, xp_amount, reference_id, discipline_id, created_by)
  values (v_user_id, 'reserva', v_xp_reserva, v_booking_id, v_discipline_id, v_user_id)
  on conflict do nothing;

  return v_booking_id;
end;
$$;

grant execute on function public.book_class(uuid, date) to authenticated;

-- 2b) admin_book_class() -- el admin reserva en nombre de un socio. Mismo
-- cambio exacto, con p_user_id en vez de v_user_id.
create or replace function public.admin_book_class(p_user_id uuid, p_class_id uuid, p_booking_date date)
returns uuid
language plpgsql
security definer
as $$
declare
  v_capacity int;
  v_discipline_id uuid;
  v_days_of_week integer[];
  v_booked_count int;
  v_credit_id uuid;
  v_booking_id uuid;
  v_xp_reserva int;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select capacity, discipline_id, days_of_week into v_capacity, v_discipline_id, v_days_of_week
  from classes where id = p_class_id for update;
  if v_capacity is null then
    raise exception 'La clase no existe';
  end if;

  if not public.esta_habilitado_para_disciplina(p_user_id, v_discipline_id) then
    raise exception 'Tu plan/créditos para esta disciplina están vencidos. No podés reservar hasta regularizar tu situación.';
  end if;

  if not (extract(dow from p_booking_date)::int = any(v_days_of_week)) then
    raise exception 'Esta clase no se dicta ese día.';
  end if;

  select count(*) into v_booked_count
  from bookings where class_id = p_class_id and booking_date = p_booking_date;
  if v_booked_count >= v_capacity then
    raise exception 'Sin cupo';
  end if;

  select id into v_credit_id
  from user_credits
  where user_id = p_user_id and discipline_id = v_discipline_id
    and remaining_credits > 0
    and expires_at > now()
  order by expires_at asc
  limit 1
  for update;

  if v_credit_id is null then
    raise exception 'El socio no tiene créditos disponibles para esta disciplina';
  end if;

  insert into bookings (user_id, class_id, booking_date, credit_lote_id)
  values (p_user_id, p_class_id, p_booking_date, v_credit_id)
  returning id into v_booking_id;

  update user_credits set remaining_credits = remaining_credits - 1 where id = v_credit_id;

  begin
    select coalesce(xp_por_reserva, 100) into v_xp_reserva from configuracion where id = 1;
  exception when others then
    v_xp_reserva := null;
  end;
  if v_xp_reserva is null then
    v_xp_reserva := 100;
  end if;

  insert into xp_events (user_id, event_type, xp_amount, reference_id, discipline_id, created_by)
  values (p_user_id, 'reserva', v_xp_reserva, v_booking_id, v_discipline_id, auth.uid())
  on conflict do nothing;

  return v_booking_id;
end;
$$;

grant execute on function public.admin_book_class(uuid, uuid, date) to authenticated;

-- ============================================================
-- PASO 3 -- cancel_booking() / admin_cancel_booking(): reintegro preciso al
-- lote de origen, o nada si ese lote ya venció.
-- ============================================================

-- 3a) cancel_booking() -- el socio cancela su propia reserva.
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

  -- NUEVO -- se lee credit_lote_id ANTES de borrar la reserva (una vez
  -- borrada, ese dato ya no está en ningún lado). `for update` para que un
  -- doble-cancel casi simultáneo no lea la misma fila dos veces antes de
  -- que la primera termine de borrarla.
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

-- 3b) admin_cancel_booking() -- mismo cambio exacto, con p_user_id.
create or replace function public.admin_cancel_booking(p_user_id uuid, p_class_id uuid, p_booking_date date, p_reason text default null)
returns boolean
language plpgsql
security definer
as $$
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

  if v_dentro_del_limite then
    if v_credit_lote_id is not null then
      update user_credits
      set remaining_credits = remaining_credits + 1
      where id = v_credit_lote_id and expires_at > now();
    else
      -- Fallback -- mismo criterio FIFO que el resto de la fase (ver
      -- cancel_booking() más arriba para el razonamiento completo).
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
$$;

grant execute on function public.admin_cancel_booking(uuid, uuid, date, text) to authenticated;

-- ============================================================
-- PASO 4 -- registrar_hoy_entrene(): créditos = "¿existe al menos un lote
-- vigente con saldo?" por disciplina. Aparatos: SIN CAMBIOS (ya estaba
-- bien, según la investigación de vencimientos).
-- ============================================================

create or replace function public.registrar_hoy_entrene()
returns table (
  otorgado boolean,
  xp_otorgado int,
  entrenamientos_hoy int,
  entrenamientos_maximos int
)
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_disciplinas_activas int;
  v_ya_hoy int;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text || ':hoy_entrene'));

  -- NUEVO -- créditos: existe AL MENOS UN lote vigente con saldo para la
  -- disciplina (antes: solo se miraba si la fila MÁS RECIENTE tenía saldo
  -- y no había vencido -- fallaba si esa fila puntual estaba vencida
  -- aunque una más vieja siguiera con saldo vigente). Membership: SIN
  -- CAMBIOS -- sigue siendo la fila más reciente (Aparatos no tiene
  -- lotes), reescrito como subquery escalar para poder convivir con el
  -- exists() de créditos en el mismo where.
  select count(*) into v_disciplinas_activas
  from disciplines d
  where
    (
      d.kind = 'credits'
      and exists (
        select 1 from user_credits uc
        where uc.user_id = v_user_id and uc.discipline_id = d.id
          and uc.remaining_credits > 0 and uc.expires_at > now()
      )
    )
    or (
      d.kind = 'membership'
      and (
        select uc.expires_at from user_credits uc
        where uc.user_id = v_user_id and uc.discipline_id = d.id
        order by uc.created_at desc limit 1
      ) > now()
    );

  if v_disciplinas_activas <= 0 then
    raise exception 'Todavía no tenés ninguna disciplina activa -- no hay ningún entrenamiento que registrar hoy.';
  end if;

  select count(*) into v_ya_hoy
  from xp_events
  where user_id = v_user_id
    and event_type = 'asistencia'
    and discipline_id is null
    and event_date = current_date;

  if v_ya_hoy >= v_disciplinas_activas then
    return query select false, 0, v_ya_hoy, v_disciplinas_activas;
    return;
  end if;

  insert into xp_events (user_id, event_type, xp_amount, event_date, created_by)
  values (v_user_id, 'asistencia', 100, current_date, v_user_id);

  return query select true, 100, v_ya_hoy + 1, v_disciplinas_activas;
end;
$$;

grant execute on function public.registrar_hoy_entrene() to authenticated;

-- ============================================================
-- Verificación (NO ejecutada -- correr a mano con socios/packs de PRUEBA).
-- Todo esto escribe de verdad en bookings/user_credits/xp_events -- no usar
-- socios reales.
-- ============================================================

-- ── Preparación común -- socio de prueba con 2 lotes de la MISMA
-- disciplina, fechas distintas, ambos vigentes (usá acreditar_pack de la
-- Fase 1, dos veces, moviendo la fecha del primero para que no se fusione
-- -- ver el Caso A de supabase_migration_lotes_creditos_fase1.sql). Anotá:
-- - LOTE_VIEJO: vence primero (ej. en 5 días)
-- - LOTE_NUEVO: vence después (ej. en 30 días)
-- select id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID>'
-- order by expires_at asc;

-- ── Caso 1: reservar descuenta del lote que vence ANTES, no del más nuevo ──
-- select book_class('<CLASS_ID_DE_ESA_DISCIPLINA>', '<FECHA_DE_LA_CLASE>');
-- select id, credit_lote_id from bookings
-- where user_id = '<USER_ID_PRUEBA>' and class_id = '<CLASS_ID>' and booking_date = '<FECHA_DE_LA_CLASE>';
-- credit_lote_id tiene que ser el id de LOTE_VIEJO, no LOTE_NUEVO.
-- select id, remaining_credits from user_credits where id = '<LOTE_VIEJO>';
-- Tiene que haber bajado en 1 -- LOTE_NUEVO tiene que seguir intacto:
-- select id, remaining_credits from user_credits where id = '<LOTE_NUEVO>';

-- ── Caso 2: cancelar esa reserva reintegra EXACTO a LOTE_VIEJO ─────────────
-- select cancel_booking('<CLASS_ID>', '<FECHA_DE_LA_CLASE>', null);
-- select id, remaining_credits from user_credits where id = '<LOTE_VIEJO>';
-- Tiene que haber vuelto al valor de antes del Caso 1. LOTE_NUEVO sigue
-- intacto (no se tocó en ningún momento).

-- ── Caso 3: el lote de origen vence ENTRE que se reserva y se cancela --
-- cancelar NO tiene que reintegrar nada ────────────────────────────────────
-- 1) Repetí el Caso 1 (reserva nueva, va a salir de LOTE_VIEJO de nuevo).
-- 2) Simulá que LOTE_VIEJO venció mientras tanto (solo para la prueba):
-- update user_credits set expires_at = now() - interval '1 hour' where id = '<LOTE_VIEJO>';
-- 3) select cancel_booking('<CLASS_ID>', '<FECHA_DE_LA_CLASE>', null);
-- Tiene que devolver true (sigue estando dentro del límite de gracia).
-- 4) Confirmá que NO se reintegró nada -- ni a LOTE_VIEJO (sigue con el
--    mismo remaining_credits de después de reservar, no +1):
-- select remaining_credits from user_credits where id = '<LOTE_VIEJO>';
-- ni a LOTE_NUEVO ni a ningún otro lote de esa disciplina:
-- select id, remaining_credits from user_credits
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID>';
-- (comparar contra los valores de ANTES de este paso -- ninguno debe subir).

-- ── Caso 4: esta_habilitado_para_disciplina() con el lote más nuevo
-- vencido pero uno más viejo vigente con saldo -- tiene que dar TRUE
-- (fallaba con el código anterior a esta fase) ─────────────────────────────
-- 1) Socio de prueba con 2 lotes: uno viejo (por fecha de creación) que
--    vence en el FUTURO con saldo, y uno más nuevo (creado después) que ya
--    venció:
-- update user_credits set expires_at = now() - interval '1 day'
-- where id = '<LOTE_CREADO_DESPUES_PERO_YA_VENCIDO>';
-- 2) select public.esta_habilitado_para_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID>');
-- Tiene que dar TRUE -- el lote viejo (por creación) todavía vigente con
-- saldo alcanza, sin importar que el "más reciente" ya venció.

-- ── Caso 5: registrar_hoy_entrene() con el mismo escenario del Caso 4 ─────
-- select * from public.registrar_hoy_entrene();
-- Esa disciplina tiene que contar en entrenamientos_maximos, aunque su
-- lote más reciente esté vencido.

-- ── Regresión completa -- Fase B de vencimientos (Emilio Camargo, créditos
-- vencidos con saldo, socio al día, baja administrativa) -- tienen que
-- seguir dando EXACTAMENTE el mismo resultado que antes de esta fase.
-- Repetí tal cual los 4 casos de supabase_migration_conectar_vencimiento_
-- book_class.sql (la query de impacto + los 4 escenarios de
-- esta_habilitado_para_disciplina). Como la firma y el contrato de
-- esta_habilitado_para_disciplina() no cambiaron (solo la implementación
-- interna de la rama créditos), estos 4 casos tendrían que dar lo mismo
-- sin ningún ajuste.

-- ── Regresión -- reserva/cancelación con UN SOLO lote (el caso normal de
-- todos los días, sin múltiples tandas) -- tiene que seguir funcionando
-- idéntico a como funciona hoy en producción:
-- 1) Socio de prueba con un solo lote vigente de una disciplina.
-- 2) select book_class(...) -- confirmar que descuenta ese único lote y
--    guarda su id en credit_lote_id.
-- 3) select cancel_booking(...) -- confirmar que reintegra exacto ahí.

-- ── Caso 6 (fallback actualizado): cancelar una reserva SIN credit_lote_id
-- (simula una reserva de antes de la Fase 2) reintegra al lote VIGENTE que
-- vence MÁS PRONTO, no al más reciente por creación ────────────────────────
-- 1) Con el mismo socio de LOTE_VIEJO/LOTE_NUEVO de la preparación común,
--    insertá una reserva de prueba a mano, SIN credit_lote_id (simulando
--    una reserva vieja):
-- insert into bookings (user_id, class_id, booking_date)
-- values ('<USER_ID_PRUEBA>', '<CLASS_ID_DE_ESA_DISCIPLINA>', '<FECHA_DE_PRUEBA>')
-- returning id;
-- 2) select cancel_booking('<CLASS_ID>', '<FECHA_DE_PRUEBA>', null);
-- 3) Confirmá que el +1 fue a LOTE_VIEJO (el que vence antes), NO a
--    LOTE_NUEVO, aunque LOTE_NUEVO sea el creado más recientemente:
-- select id, remaining_credits from user_credits where id in ('<LOTE_VIEJO>', '<LOTE_NUEVO>');

-- ── Regresión -- reserva de un socio con Aparatos únicamente (sin ningún
-- lote de créditos) -- tiene que seguir rechazando igual que siempre
-- ("Sin créditos disponibles para esta disciplina"), sin ningún cambio de
-- mensaje ni comportamiento:
-- select book_class('<CLASS_ID_DE_APARATOS_SI_SHOW_IN_AGENDA_TRUE>', '<FECHA>');
