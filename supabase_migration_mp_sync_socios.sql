-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor) CUANDO SE
-- QUIERA activar: que un pago aprobado automáticamente por Mercado Pago
-- también actualice `socios.creditos`/`socios.fecha_vencimiento`, no solo
-- `user_credits` (la PWA). Mismo proyecto de Supabase que usa la PWA --
-- reemplaza la versión de mp_process_payment de
-- greenfit-app/backend/supabase_migration_planes_combos.sql (mismo nombre
-- y firma, create or replace). No se ejecuta automáticamente: es un
-- cambio de schema sobre producción.
--
-- ============================================================
-- POR QUÉ HACÍA FALTA (bug detectado en la auditoría del webhook de MP):
-- mp_process_payment nunca tocaba `socios` -- solo `pagos_socio` y
-- `user_credits`. El panel Admin lee ÚNICAMENTE socios.fecha_vencimiento
-- para decidir Activo/Vencido/Tolerancia
-- (PAGINA SUPABASE/src/utils/socioMetrics.js, estadoOperativoSocio) --
-- eso alimenta el badge de Socios.jsx, los KPI del Dashboard y cualquier
-- filtro de WhatsApp a "vencidos". Un socio que pagaba solo por Mercado
-- Pago quedaba con la PWA al día pero el Admin seguía viéndolo "Vencido"
-- hasta que alguien lo reconciliara a mano con "Registrar Pago".
--
-- DECISIONES DE DISEÑO (confirmadas con Facundo):
--   - Refunds/chargebacks: IGNORADOS a propósito. Gimnasio chico, riesgo
--     mínimo -- si pasa, el Admin lo corrige a mano. No se agrega
--     ninguna lógica de reversión para mantener la función simple.
--   - `socios.creditos`: sigue siendo un pozo global único (un solo
--     número). Un combo multi-disciplina suma TODOS sus créditos ahí
--     (se pierde el desglose por disciplina en esa vista puntual) --
--     costo aceptado porque la fuente de verdad real para reservar sigue
--     siendo `user_credits` (que sí tiene el desglose exacto); el Admin
--     solo necesita un número total de referencia.
--   - `socios.fecha_vencimiento`: se pisa (no se suma) con la MISMA fecha
--     que ya se calcula para extender la membresía de Aparatos en
--     `user_credits` -- una sola cuenta, reusada en los dos lugares, para
--     que nunca puedan quedar desalineadas entre sí. Si el pack no incluye
--     Aparatos, no hay ninguna fecha real que escribir -- esa columna
--     queda intacta (mismo criterio "no inventar datos" que
--     sincronizacion_crossfy.sql).
--   - El puente hacia `socios` es `profiles.dni = socios.dni` (mismo
--     puente que usa TODO el resto del sistema, ver
--     src/utils/creditosPwa.js). Si el socio no tiene DNI cargado en
--     GreenFit, o su profile no tiene DNI, este UPDATE no encuentra a
--     nadie (0 filas) -- no es un error, la acreditación real en
--     user_credits ya se hizo igual.
-- ============================================================

create or replace function public.mp_process_payment(
  p_user_id uuid,
  p_pack_id uuid,
  p_creditos jsonb,               -- [{"discipline_id": uuid, "credits": int}, ...]
  p_incluye_aparatos boolean,
  p_dias_vigencia int,            -- null/ignorado si p_incluye_aparatos es false
  p_aparatos_discipline_id uuid,  -- null si p_incluye_aparatos es false
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
  v_credito jsonb;
  v_discipline_id uuid;
  v_credits int;
  -- NUEVO: acumula el total de créditos del combo (para socios.creditos,
  -- pozo global) y la fecha de vencimiento real de Aparatos (para
  -- socios.fecha_vencimiento) -- ver header de arriba.
  v_total_creditos int := 0;
  v_dni text;
  v_nueva_fecha_vencimiento timestamptz;
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
    -- Un combo puede incluir N disciplinas -- una fila de user_credits por
    -- cada una, sumando sobre el balance previo de ESA disciplina puntual
    -- (igual que el modelo de un solo crédito de antes, ahora en loop).
    for v_credito in select * from jsonb_array_elements(coalesce(p_creditos, '[]'::jsonb))
    loop
      v_discipline_id := (v_credito->>'discipline_id')::uuid;
      v_credits := (v_credito->>'credits')::int;
      if v_discipline_id is not null and v_credits is not null and v_credits > 0 then
        insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
        select
          p_user_id, p_pack_id, v_discipline_id,
          coalesce(
            (select remaining_credits from user_credits
             where user_id = p_user_id and discipline_id = v_discipline_id
             order by created_at desc limit 1),
            0
          ) + v_credits,
          now() + interval '30 days';

        v_total_creditos := v_total_creditos + v_credits;
      end if;
    end loop;

    if p_incluye_aparatos and p_aparatos_discipline_id is not null and p_dias_vigencia is not null and p_dias_vigencia > 0 then
      -- Se calcula UNA sola vez en una variable -- se usa acá para
      -- user_credits Y más abajo para socios.fecha_vencimiento, así las
      -- dos tablas quedan con exactamente la misma fecha, nunca corridas
      -- una respecto de la otra por evaluarla dos veces.
      v_nueva_fecha_vencimiento := greatest(
        coalesce(
          (select expires_at from user_credits
           where user_id = p_user_id and discipline_id = p_aparatos_discipline_id
           order by created_at desc limit 1),
          now()
        ),
        now()
      ) + (p_dias_vigencia || ' days')::interval;

      insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
      values (p_user_id, p_pack_id, p_aparatos_discipline_id, null, v_nueva_fecha_vencimiento);
    end if;

    -- ============================================================
    -- NUEVO: espejo en `socios` -- ver header. Vincula por DNI (mismo
    -- puente que usa sincronizarCreditosPwa/sincronizarVencimientoPwa en
    -- sentido inverso). `creditos` se SUMA (pozo global);
    -- `fecha_vencimiento` se PISA con la fecha real recién calculada
    -- arriba, convertida a día calendario de Argentina (no UTC crudo --
    -- un pago aprobado a la noche en Mendoza no debe registrar el día
    -- siguiente por error de huso horario). Si el pack no incluía
    -- Aparatos, v_nueva_fecha_vencimiento quedó NULL y el coalesce de
    -- abajo deja la columna intacta -- no se inventa ninguna fecha.
    -- ============================================================
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
  end if;

  return query select v_otorgar;
end;
$$;

-- ============================================================
-- Verificación rápida después de correr esto:
--   1. Un pago de un pack de créditos puros (sin Aparatos) aprobado por MP
--      -> socios.creditos sube exactamente en la cantidad del combo;
--      socios.fecha_vencimiento queda IGUAL que antes (no se toca).
--   2. Un pago de un pack con Aparatos aprobado por MP -> socios.fecha_vencimiento
--      pasa a la nueva fecha (misma que expires_at en user_credits para esa
--      disciplina, comparar los dos); el badge en Socios.jsx debería pasar
--      a "Activo" sin que nadie haga nada a mano.
--   3. select id, dni, creditos, fecha_vencimiento from socios where dni = '...';
--      antes y después del pago, para confirmar el delta exacto.
-- ============================================================
