-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- ETAPA 2 (fix de raíz) -- cambia SOLO el comportamiento futuro. Cero UPDATE/DELETE
-- contra datos existentes: son dos `create or replace function` y nada más.
--
-- BUG: acreditar_pack() y admin_acreditar_creditos_manual() reseteaban los créditos
-- viejos con `remaining_credits = 0` pero les dejaban su `expires_at` (fecha futura del
-- plan anterior). Esas filas "muertas" cumplen `expires_at > now()`, así que
-- cancel_booking()/admin_cancel_booking() -- que devuelven el crédito al lote de la
-- reserva (o, sin lote, a la fila vigente que vence antes) -- las reactivaban y el socio
-- terminaba con 2+ fechas activas.
--
-- FIX: el mismo reseteo ahora también manda `expires_at` al pasado (ayer), igual que ya
-- hacen con Aparatos. Único cambio en las dos funciones (una línea de SET + comentario);
-- el resto es copia textual de:
--   * acreditar_pack()                    <- supabase_migration_plan_unico_acreditar_pack.sql
--   * admin_acreditar_creditos_manual()   <- supabase_migration_admin_acreditar_creditos_manual.sql
--
-- `least(expires_at, now() - interval '1 day')` y no un `now() - 1 día` a secas: una
-- fila que ya venía vencida (con saldo residual) conserva su fecha real en vez de
-- "adelantarse" a ayer. Para una fila con fecha futura da exactamente ayer.
--
-- NO se tocan: cancel_booking(), admin_cancel_booking(), admin_cancelar_clase_dia(),
-- book_class(), admin_book_class(), admin_fijar/ajustar_credito_disciplina(),
-- admin_agregar_aparatos_socio(), admin_editar_fecha_vencimiento_socio(),
-- admin_quitar_disciplina_socio(), admin_revertir_comprobante().
--
-- CAMBIO DE COMPORTAMIENTO ÚNICO Y ESPERADO (es justo lo que cierra el bug): una reserva
-- hecha ANTES de pagar, cancelada DESPUÉS de pagar (dentro del plazo), ya no le devuelve
-- el crédito a la fila del plan anterior -- ese crédito era del plan que se reseteó.
-- Reservas hechas después del pago, o sin ningún pago en el medio: sin cambios.

-- ============================================================
-- acreditar_pack()
-- ============================================================
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
  v_fecha_plan_nuevo timestamptz;
  v_fecha_aparatos_actual timestamptz;
  v_aparatos_extendido boolean := false;
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

  -- "Un solo plan activo" -- UNA fecha para todo lo que este pack otorga
  -- (créditos Y Aparatos). Fallback de 30 días si dias_vigencia es null
  -- (packs 100% créditos hoy) -- ver nota del header.
  v_fecha_plan_nuevo := now() + (coalesce(v_dias_vigencia, 30) || ' days')::interval;

  -- Se resuelve SIEMPRE (no solo si el pack nuevo incluye Aparatos) --
  -- hace falta para poder apagar un Aparatos vigente aunque este pack no
  -- lo traiga.
  select id into v_aparatos_discipline_id from disciplines where kind = 'membership' limit 1;

  -- ============================================================
  -- RESETEO -- todo lo que el socio tenía activo se apaga ANTES de
  -- acreditar el pack nuevo. Si algo falla más abajo (pack malformado en
  -- el loop), la transacción entera se revierte -- este reseteo nunca
  -- queda aplicado a mitad de camino sin la acreditación nueva.
  -- ============================================================

  -- Créditos -- remaining_credits=0 en TODAS las disciplinas de créditos
  -- del socio, no solo las que trae el pack nuevo. Nunca se borra una
  -- fila (bookings.credit_lote_id puede referenciarla, mismo criterio de
  -- siempre) -- solo se la deja en 0, inerte.
  -- expires_at al pasado, igual que Aparatos abajo: una fila en 0 NO puede quedar
  -- con fecha futura -- cancel_booking()/admin_cancel_booking() reintegran a un lote
  -- con `expires_at > now()`, y una fila muerta con la fecha del plan anterior se
  -- reactivaba como 2ª fecha activa. least(): las filas que ya venían vencidas
  -- conservan su fecha real, no se "adelantan" a ayer.
  update user_credits
  set remaining_credits = 0,
      expires_at = least(expires_at, now() - interval '1 day')
  where user_id = p_user_id
    and remaining_credits > 0
    and discipline_id in (select id from disciplines where kind = 'credits');

  -- Aparatos -- cualquier fila todavía vigente deja de estarlo ya mismo,
  -- sin importar si el pack nuevo la va a reemplazar o no.
  --
  -- BUG REAL (encontrado probando la Fase 1): `expires_at = now()` deja
  -- una fecha que, espejada en socios.fecha_vencimiento (una columna
  -- `date`, sin hora), da EXACTAMENTE hoy. esta_habilitado_para_disciplina()
  -- compara `fecha_vencimiento >= current_date` -- por DÍA completo, no
  -- por instante -- así que un reseteo hecho a cualquier hora del día de
  -- hoy seguía leyendo como "vigente" hasta la medianoche, aunque
  -- técnicamente ya se había apagado. `now() - interval '1 day'` deja la
  -- fecha SIEMPRE claramente anterior a hoy, sin ambigüedad para ningún
  -- chequeo por día completo, sin importar a qué hora se ejecute esto.
  if v_aparatos_discipline_id is not null then
    update user_credits
    set expires_at = now() - interval '1 day'
    where user_id = p_user_id
      and discipline_id = v_aparatos_discipline_id
      and expires_at > now();
  end if;

  -- ============================================================
  -- ACREDITACIÓN -- solo lo que trae ESTE pack. Sin lotes, sin fusión por
  -- fecha -- ya no hace falta, porque no puede quedar nada previo vigente
  -- con lo que fusionar.
  -- ============================================================
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

    insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
    values (p_user_id, p_pack_id, v_discipline_id, v_credits, v_fecha_plan_nuevo)
    returning id into v_lote_id;

    v_total_creditos := v_total_creditos + v_credits;
    v_creditos_lotes := v_creditos_lotes || jsonb_build_array(
      jsonb_build_object('discipline_id', v_discipline_id, 'credits_otorgados', v_credits, 'lote_id', v_lote_id)
    );
  end loop;

  -- Aparatos, si el pack nuevo lo incluye -- MISMA fecha que los créditos
  -- de este pack (plan único), plana. SIN el greatest(vigente, hoy) de
  -- antes -- no hay carryover de la vigencia anterior: se acaba de apagar
  -- arriba, sin importar cuál era.
  if v_incluye_aparatos and v_aparatos_discipline_id is not null then
    insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
    values (p_user_id, p_pack_id, v_aparatos_discipline_id, null, v_fecha_plan_nuevo);

    v_aparatos_extendido := true;
  end if;

  -- Estado REAL de Aparatos después del reseteo -- ver nota del header
  -- sobre por qué esto ya no puede ser un simple coalesce con la fecha
  -- vieja. Es la fila más reciente (la nueva del pack si la incluyó, o la
  -- que se acaba de apagar arriba si no) -- null si el socio nunca tuvo
  -- Aparatos.
  if v_aparatos_discipline_id is not null then
    select expires_at into v_fecha_aparatos_actual
    from user_credits
    where user_id = p_user_id and discipline_id = v_aparatos_discipline_id
    order by created_at desc
    limit 1;
  end if;

  -- Espejo en socios -- recalculado desde cero (ya no incremental): el
  -- total activo es EXACTAMENTE lo que este pack acredita (todo lo
  -- anterior quedó en 0 arriba).
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    update socios
    set creditos = v_total_creditos,
        fecha_vencimiento = coalesce(
          (v_fecha_aparatos_actual at time zone 'America/Argentina/Mendoza')::date,
          fecha_vencimiento
        )
    where dni = v_dni;
  end if;

  return query select
    v_total_creditos,
    v_aparatos_extendido,
    (v_fecha_aparatos_actual at time zone 'America/Argentina/Mendoza')::date,
    v_creditos_lotes;
end;
$$;

grant execute on function public.acreditar_pack(uuid, uuid, text, text) to authenticated;

-- ============================================================
-- admin_acreditar_creditos_manual()
-- ============================================================
create or replace function public.admin_acreditar_creditos_manual(
  p_user_id uuid,
  p_creditos jsonb,
  p_incluye_aparatos boolean default false,
  p_dias_vigencia int default 30,
  p_fecha_inicio date default null
)
returns table (
  creditos_otorgados int,
  aparatos_extendido boolean,
  nueva_fecha_vencimiento_aparatos date,
  creditos_lotes jsonb
)
language plpgsql
security definer
as $$
declare
  v_aparatos_discipline_id uuid;
  v_credito jsonb;
  v_discipline_id uuid;
  v_credits int;
  v_kind text;
  v_discipline_ids_vistos uuid[] := '{}';
  v_total_creditos int := 0;
  v_dni text;
  v_fecha_plan_nuevo timestamptz;
  v_fecha_aparatos_actual timestamptz;
  v_aparatos_extendido boolean := false;
  v_lote_id uuid;
  v_creditos_lotes jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  if p_dias_vigencia is null or p_dias_vigencia <= 0 then
    raise exception 'p_dias_vigencia inválido: % -- tiene que ser un entero mayor a 0.', p_dias_vigencia;
  end if;

  -- Guarda propia de este contexto (acreditar_pack no la necesita -- un
  -- pack siempre trae algo por definición, ya validado al crearlo en
  -- Configuración). Acá, con cantidades tipeadas a mano, es perfectamente
  -- posible mandar el formulario vacío sin querer -- sin esto, el reseteo
  -- de abajo igual se aplicaría completo y el socio se queda sin nada a
  -- cambio.
  if coalesce(jsonb_array_length(p_creditos), 0) = 0 and not p_incluye_aparatos then
    raise exception 'No se especificó ningún crédito ni Aparatos para acreditar -- no se resetea el plan del socio sin darle algo a cambio.';
  end if;

  -- "Un solo plan activo" -- misma UNA fecha para todo lo que esto
  -- acredita (créditos Y Aparatos si corresponde), igual que
  -- acreditar_pack(). Ver la nota del header sobre p_fecha_inicio.
  v_fecha_plan_nuevo := (case
    when p_fecha_inicio is null then now()
    else (p_fecha_inicio::timestamp at time zone 'America/Argentina/Mendoza')
  end) + (p_dias_vigencia || ' days')::interval;

  -- Se resuelve SIEMPRE (no solo si p_incluye_aparatos) -- hace falta para
  -- poder apagar un Aparatos vigente aunque esta carga no lo traiga. Mismo
  -- criterio que acreditar_pack().
  select id into v_aparatos_discipline_id from disciplines where kind = 'membership' limit 1;

  -- ============================================================
  -- RESETEO -- idéntico a acreditar_pack(): todo lo que el socio tenía
  -- activo se apaga ANTES de acreditar lo nuevo. Si algo falla más abajo
  -- (carga malformada en el loop), la transacción entera se revierte --
  -- este reseteo nunca queda aplicado a mitad de camino sin la
  -- acreditación nueva.
  -- ============================================================

  -- expires_at al pasado, igual que Aparatos abajo: una fila en 0 NO puede quedar
  -- con fecha futura -- cancel_booking()/admin_cancel_booking() reintegran a un lote
  -- con `expires_at > now()`, y una fila muerta con la fecha del plan anterior se
  -- reactivaba como 2ª fecha activa. least(): las filas que ya venían vencidas
  -- conservan su fecha real, no se "adelantan" a ayer.
  update user_credits
  set remaining_credits = 0,
      expires_at = least(expires_at, now() - interval '1 day')
  where user_id = p_user_id
    and remaining_credits > 0
    and discipline_id in (select id from disciplines where kind = 'credits');

  -- now() - interval '1 day', no now() -- mismo fix ya aplicado en
  -- acreditar_pack() (ver esa migración para el detalle): con now() a
  -- secas, un chequeo por DÍA completo (esta_habilitado_para_disciplina,
  -- fecha_vencimiento >= current_date) seguía leyendo "vigente" hasta la
  -- medianoche del día del reseteo, sin importar a qué hora se ejecutó.
  if v_aparatos_discipline_id is not null then
    update user_credits
    set expires_at = now() - interval '1 day'
    where user_id = p_user_id
      and discipline_id = v_aparatos_discipline_id
      and expires_at > now();
  end if;

  -- ============================================================
  -- ACREDITACIÓN -- solo lo que trae ESTA carga. Mismas guardas que
  -- acreditar_pack() (discipline_id/credits inválidos, disciplina
  -- repetida) MÁS una adaptada a este contexto: a diferencia de un pack
  -- (packs.creditos, ya validado al crearlo en Configuración), acá
  -- discipline_id viene de lo que Seba tipeó/eligió a mano -- se valida
  -- que exista y sea de créditos ANTES de insertar, en vez de dejar que
  -- una FK inválida explote con un error crudo de Postgres.
  -- ============================================================
  for v_credito in select * from jsonb_array_elements(coalesce(p_creditos, '[]'::jsonb))
  loop
    v_discipline_id := (v_credito->>'discipline_id')::uuid;
    v_credits := (v_credito->>'credits')::int;

    if v_discipline_id is null then
      raise exception 'Hay una entrada de créditos sin discipline_id válido: %', v_credito;
    end if;
    if v_credits is null or v_credits <= 0 then
      raise exception 'Cantidad de créditos inválida para la disciplina % (credits=%)', v_discipline_id, v_credito->>'credits';
    end if;
    if v_discipline_id = any(v_discipline_ids_vistos) then
      raise exception 'La disciplina % está repetida más de una vez en la carga -- corregí los valores antes de acreditar.', v_discipline_id;
    end if;

    select kind into v_kind from disciplines where id = v_discipline_id;
    if v_kind is null then
      raise exception 'La disciplina % no existe.', v_discipline_id;
    end if;
    if v_kind <> 'credits' then
      raise exception 'La disciplina % (%) no es de créditos -- Aparatos se acredita con p_incluye_aparatos, no en esta lista.', v_discipline_id, v_kind;
    end if;

    v_discipline_ids_vistos := array_append(v_discipline_ids_vistos, v_discipline_id);

    -- Sin pack_id (no hay ningún pack real detrás de esto) -- mismo
    -- criterio que ya usan admin_fijar_creditos_disciplina/
    -- admin_ajustar_credito_disciplina para sus propias inserciones
    -- manuales.
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (p_user_id, v_discipline_id, v_credits, v_fecha_plan_nuevo)
    returning id into v_lote_id;

    v_total_creditos := v_total_creditos + v_credits;
    v_creditos_lotes := v_creditos_lotes || jsonb_build_array(
      jsonb_build_object('discipline_id', v_discipline_id, 'credits_otorgados', v_credits, 'lote_id', v_lote_id)
    );
  end loop;

  -- Aparatos, si esta carga lo incluye -- MISMA fecha que los créditos de
  -- esta carga (plan único), plana. Sin carryover de la vigencia
  -- anterior -- se acaba de apagar arriba, sin importar cuál era.
  if p_incluye_aparatos and v_aparatos_discipline_id is not null then
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (p_user_id, v_aparatos_discipline_id, null, v_fecha_plan_nuevo);

    v_aparatos_extendido := true;
  end if;

  -- Estado REAL de Aparatos después del reseteo -- mismo criterio que
  -- acreditar_pack(): la fila más reciente (la nueva si se incluyó, o la
  -- que se acaba de apagar arriba si no) -- null si el socio nunca tuvo
  -- Aparatos.
  if v_aparatos_discipline_id is not null then
    select expires_at into v_fecha_aparatos_actual
    from user_credits
    where user_id = p_user_id and discipline_id = v_aparatos_discipline_id
    order by created_at desc
    limit 1;
  end if;

  -- Espejo en socios -- recalculado desde cero, mismo criterio que
  -- acreditar_pack().
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    update socios
    set creditos = v_total_creditos,
        fecha_vencimiento = coalesce(
          (v_fecha_aparatos_actual at time zone 'America/Argentina/Mendoza')::date,
          fecha_vencimiento
        )
    where dni = v_dni;
  end if;

  return query select
    v_total_creditos,
    v_aparatos_extendido,
    (v_fecha_aparatos_actual at time zone 'America/Argentina/Mendoza')::date,
    v_creditos_lotes;
end;
$$;

grant execute on function public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, int, date) to authenticated;

-- ============================================================
-- VERIFICACIÓN -- SOLO LECTURA. Correr ANTES y DESPUÉS de esta migración: los tres
-- números y las fechas tienen que dar IDÉNTICOS (este script no toca datos existentes).
-- ============================================================
-- with activas as (
--   select uc.user_id, (uc.expires_at at time zone 'America/Argentina/Mendoza')::date as fecha_ar
--   from user_credits uc join disciplines d on d.id = uc.discipline_id
--   where uc.expires_at > now()
--     and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership')
-- ),
-- por_socio as (
--   select user_id, count(distinct fecha_ar) as cant, array_agg(distinct fecha_ar order by fecha_ar) as fechas
--   from activas group by user_id
-- )
-- select
--   count(*) filter (where cant = 1) as socios_con_1_fecha_activa,
--   count(*) filter (where cant > 1) as socios_con_2_o_mas_fechas_activas,
--   md5(coalesce(string_agg(user_id::text || ':' || fechas::text, '|' order by user_id) filter (where cant > 1), '')) as huella_de_los_socios_con_2_o_mas
-- from por_socio;
