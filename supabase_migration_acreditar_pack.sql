-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- FASE 1 -- SOLO la función nueva, aislada. NO se conecta a nada en este
-- script: mp_process_payment, admin_aprobar_comprobante y todo lo de
-- Socios (botones +1/+4/+8/+12, "Registrar Pago") siguen exactamente como
-- están hoy. Conectarla es la Fase 2 (mp_process_payment /
-- admin_aprobar_comprobante) y Fase 3 (Socios), recién después de validar
-- los casos de más abajo.
--
-- Qué es esto (ver diagnóstico de la sesión anterior): mp_process_payment
-- y admin_aprobar_comprobante tienen HOY el mismo loop de acreditación
-- copiado casi línea por línea entre dos archivos distintos -- exactamente
-- el patrón que generó el bug de desincronización de Emilio Camargo (dos
-- copias de la misma lógica que pueden desalinearse). Esto extrae esa
-- lógica a un solo lugar.
--
-- ES UNA EXTRACCIÓN, NO UNA REESCRITURA -- el loop de créditos, el cálculo
-- de v_nueva_fecha_vencimiento para Aparatos, y el espejo a `socios` con
-- la conversión de zona horaria son EXACTAMENTE los mismos que ya están
-- probados en mp_process_payment (versión vigente,
-- supabase_migration_mp_sync_socios.sql) -- ningún número, fórmula ni
-- criterio nuevo. Los únicos agregados son:
--   - Resolver `packs.creditos/incluye_aparatos/dias_vigencia` y
--     `disciplines.id (kind='membership')` DESDE ACÁ ADENTRO a partir de
--     p_pack_id -- en mp_process_payment estos valores llegaban
--     pre-resueltos como parámetros (los resolvía la Edge Function antes
--     de llamarla); acá la función recibe solo p_pack_id, así que hace
--     ella misma la misma consulta que YA hace admin_aprobar_comprobante
--     para lo mismo (`select creditos, incluye_aparatos, dias_vigencia
--     from packs where id = ...`, `select id from disciplines where
--     kind='membership' limit 1`) -- no es lógica nueva, es la misma
--     consulta que ya existe en el otro camino, movida acá.
--   - Un `raise exception` si p_pack_id no existe -- defensivo, no estaba
--     en mp_process_payment porque ahí el pack ya venía resuelto por el
--     caller; acá SÍ hace falta porque esta función es la que resuelve el
--     pack por primera vez.
--
-- Idempotencia por payment_id/comprobante_id QUEDA AFUERA a propósito
-- (decisión ya tomada, no se vuelve a evaluar acá): es específica de cada
-- camino (el `insert ... on conflict do nothing` + `for update` de MP, el
-- `reviewed_at is not null` de comprobantes) y sigue viviendo en el
-- caller correspondiente. Tampoco se toca `pagos_socio` acá -- esta
-- función solo hace la acreditación real (user_credits + socios); cada
-- caller sigue siendo responsable de su propia fila de historial, con su
-- propio criterio de qué campos guardar ahí.

create or replace function public.acreditar_pack(
  p_user_id uuid,
  p_pack_id uuid,
  p_origen text,
  p_referencia_externa text default null
)
returns table (
  creditos_otorgados int,
  aparatos_extendido boolean,
  nueva_fecha_vencimiento_aparatos date
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
  v_total_creditos int := 0;
  v_dni text;
  v_nueva_fecha_vencimiento timestamptz;
  v_aparatos_extendido boolean := false;
begin
  -- p_referencia_externa se acepta en la firma (mercado_pago_payment_id,
  -- o el id del comprobante, según el caller) pero A PROPÓSITO no se usa
  -- para nada acá adentro -- la idempotencia es responsabilidad de cada
  -- caller (ver header). Queda en la firma para que quede documentado de
  -- dónde viene la acreditación sin tener que volver a tocar esta función
  -- el día que se decida, por ejemplo, loguearla en algún lado.

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

  -- ── Loop de créditos por disciplina -- EXTRAÍDO TAL CUAL de
  -- mp_process_payment (supabase_migration_mp_sync_socios.sql:110-132). ──
  for v_credito in select * from jsonb_array_elements(coalesce(v_creditos, '[]'::jsonb))
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

  -- ── Extensión de Aparatos -- EXTRAÍDO TAL CUAL de mp_process_payment
  -- (supabase_migration_mp_sync_socios.sql:134-151). ──────────────────────
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

  -- ── Espejo en socios -- EXTRAÍDO TAL CUAL de mp_process_payment
  -- (supabase_migration_mp_sync_socios.sql:153-173): creditos se SUMA
  -- (pozo global), fecha_vencimiento se PISA con la fecha real recién
  -- calculada arriba (misma variable, no se recalcula -- para que
  -- user_credits y socios nunca puedan quedar corridas una respecto de la
  -- otra), convertida a día calendario de Argentina. Si el pack no incluía
  -- Aparatos, v_nueva_fecha_vencimiento queda NULL y el coalesce deja la
  -- columna intacta -- no se inventa ninguna fecha. ─────────────────────
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
    (v_nueva_fecha_vencimiento at time zone 'America/Argentina/Mendoza')::date;
end;
$$;

grant execute on function public.acreditar_pack(uuid, uuid, text, text) to authenticated;

-- ============================================================
-- Verificación (NO CONECTADA A NADA). Correr de a un bloque, a mano,
-- DESPUÉS de aplicar la función de arriba. Esto SÍ modifica datos reales
-- de los socios de prueba que elijas (inserta en user_credits, actualiza
-- socios) -- usá socios de prueba, no socios reales, y anotá los valores
-- de ANTES para poder comparar.
-- ============================================================

-- ── Caso 1: pack de una sola disciplina de créditos (ej. "Pack 4 CrossFit") ─
-- 1) Elegí un socio de prueba con cuenta de PWA y un pack real de una sola
--    disciplina de créditos, sin Aparatos:
-- select p.id as user_id, p.full_name, p.dni from profiles p where p.dni = '<DNI DE PRUEBA>';
-- select id as pack_id, name, creditos, incluye_aparatos, dias_vigencia
-- from packs where incluye_aparatos = false and jsonb_array_length(creditos) = 1
-- limit 5;
--
-- 2) Anotá el ANTES (balance de esa disciplina en user_credits, y
--    socios.creditos/fecha_vencimiento):
-- select discipline_id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' order by created_at desc limit 5;
-- select creditos, fecha_vencimiento from socios where dni = '<DNI DE PRUEBA>';
--
-- 3) Llamá a la función:
-- select * from public.acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID_1_DISCIPLINA>', 'manual');
--
-- 4) Confirmá el DESPUÉS -- tiene que coincidir con lo que mp_process_payment
--    hubiera producido para el mismo pack: remaining_credits sube EXACTO en
--    la cantidad del pack (sumado sobre el balance anterior de esa
--    disciplina puntual), expires_at de la fila nueva ≈ now()+30 días,
--    aparatos_extendido = false, nueva_fecha_vencimiento_aparatos = null,
--    y socios.creditos sube en la misma cantidad (socios.fecha_vencimiento
--    NO cambia, porque el pack no incluye Aparatos):
-- select discipline_id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' order by created_at desc limit 5;
-- select creditos, fecha_vencimiento from socios where dni = '<DNI DE PRUEBA>';

-- ── Caso 2: combo de 2+ disciplinas + Aparatos (ej. "Combo CrossFit+Boxeo+Aparatos") ─
-- 1) Elegí un socio de prueba (puede ser otro, o el mismo con un pack
--    distinto) y un pack combo real con al menos 2 disciplinas de
--    créditos Y Aparatos:
-- select id as pack_id, name, creditos, incluye_aparatos, dias_vigencia
-- from packs where incluye_aparatos = true and jsonb_array_length(creditos) >= 2
-- limit 5;
-- select id as discipline_id_aparatos from disciplines where kind = 'membership';
--
-- 2) Anotá el ANTES de TODAS las disciplinas del combo (créditos y
--    Aparatos) + socios:
-- select discipline_id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA_2>' order by created_at desc limit 10;
-- select creditos, fecha_vencimiento from socios where dni = '<DNI DE PRUEBA 2>';
--
-- 3) Llamá a la función:
-- select * from public.acreditar_pack('<USER_ID_PRUEBA_2>', '<PACK_ID_COMBO>', 'transferencia_comprobante');
--
-- 4) Confirmá el DESPUÉS -- CADA disciplina de créditos del combo sube
--    exacto en lo que le correspondía a ESA disciplina puntual dentro del
--    combo (no el total mezclado), la fila de Aparatos queda con
--    remaining_credits=null y expires_at = greatest(lo que tenía antes,
--    ahora) + dias_vigencia del pack, aparatos_extendido = true,
--    nueva_fecha_vencimiento_aparatos = esa misma fecha (como date), y
--    socios.creditos sube en la SUMA de todas las disciplinas de créditos
--    del combo, socios.fecha_vencimiento pasa a coincidir EXACTO con el
--    expires_at de Aparatos (mismo día, convertido a America/Argentina/Mendoza):
-- select discipline_id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA_2>' order by created_at desc limit 10;
-- select creditos, fecha_vencimiento from socios where dni = '<DNI DE PRUEBA 2>';

-- ── Caso 3: p_origen inválido -- tiene que tirar excepción, sin acreditar nada ─
-- select * from public.acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID_1_DISCIPLINA>', 'promocion_rota');
-- Tiene que fallar con: "p_origen inválido: "promocion_rota". Tiene que ser
-- uno de: manual, mercado_pago, transferencia_comprobante." -- confirmá que
-- NO se insertó ninguna fila nueva en user_credits ni se tocó socios.

-- ── Caso 4: p_pack_id inexistente -- tiene que tirar excepción ──────────────
-- select * from public.acreditar_pack('<USER_ID_PRUEBA>', '00000000-0000-0000-0000-000000000000', 'manual');
-- Tiene que fallar con: "El pack 00000000-0000-0000-0000-000000000000 no existe."
