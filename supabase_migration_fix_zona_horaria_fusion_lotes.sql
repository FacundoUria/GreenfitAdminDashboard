-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- FIX preventivo -- bug de zona horaria en la condición de fusión de lotes
-- de acreditar_pack() (supabase_migration_lotes_creditos_fase1.sql).
--
-- CAUSA (confirmada por inspección de código -- ver diagnóstico completo
-- entregado aparte para el caso real de Elena Castillo, DNI 34237434):
-- la condición `expires_at::date = v_fecha_nuevo_lote::date` es un bare
-- cast de timestamptz a date -- Postgres lo resuelve con el timezone POR
-- DEFECTO DE LA SESIÓN (UTC en Supabase), no con la zona horaria real del
-- gimnasio (America/Argentina/Mendoza, UTC-3). Como Argentina está 3 horas
-- detrás de UTC, dos acreditaciones hechas el MISMO día calendario en
-- Mendoza entre las 21:00 y las 23:59 hora local caen en fechas UTC
-- DISTINTAS -- la condición de fusión las trata como días diferentes y
-- crea un lote nuevo en vez de fusionar, dejando el crédito fragmentado en
-- 2+ filas que la PWA/Admin sí suman bien (después del fix de lectura),
-- pero que deberían haber sido una sola fila desde el vamos.
--
-- Esto es la ÚNICA parte de acreditar_pack() que había quedado con el cast
-- crudo -- el resto de la función (el espejo a `socios`, unas líneas más
-- abajo) ya usa `at time zone 'America/Argentina/Mendoza'`, igual que
-- cancel_booking()/admin_cancel_booking() (supabase_migration_cancel_booking_configurable.sql).
-- Este fix alinea la condición de fusión con ese mismo criterio, ya
-- establecido en el resto del sistema.
--
-- Alcance: SOLO cambia la condición de fusión (línea con
-- `expires_at::date = v_fecha_nuevo_lote::date`). Nada más de la función
-- cambia -- mismos 4 parámetros de entrada, mismo `returns table` (no hace
-- falta `drop function` primero, `create or replace` alcanza).
--
-- Preventivo, no retroactivo: NO corrige los lotes que ya quedaron
-- fragmentados por este bug antes de aplicar este fix (ej. los 2 lotes de
-- Elena) -- esa corrección es manual, aparte, y se entrega por separado
-- para revisar antes de aplicarla. Este script solo evita que el mismo
-- problema le pase a acreditaciones NUEVAS de acá en adelante.

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

    v_fecha_nuevo_lote := now() + interval '30 days';

    -- FIX -- ambos lados de la comparación de "mismo día calendario" ahora
    -- se evalúan en hora Argentina (America/Argentina/Mendoza), no en el
    -- timezone por defecto de la sesión (UTC). Antes: `expires_at::date =
    -- v_fecha_nuevo_lote::date`.
    select id into v_lote_id
    from user_credits
    where user_id = p_user_id
      and discipline_id = v_discipline_id
      and remaining_credits > 0
      and (expires_at at time zone 'America/Argentina/Mendoza')::date
        = (v_fecha_nuevo_lote at time zone 'America/Argentina/Mendoza')::date
    order by created_at desc
    limit 1
    for update;

    if v_lote_id is not null then
      update user_credits
      set remaining_credits = remaining_credits + v_credits
      where id = v_lote_id;
    else
      insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
      values (p_user_id, p_pack_id, v_discipline_id, v_credits, v_fecha_nuevo_lote)
      returning id into v_lote_id;
    end if;

    v_total_creditos := v_total_creditos + v_credits;
    v_creditos_lotes := v_creditos_lotes || jsonb_build_array(
      jsonb_build_object('discipline_id', v_discipline_id, 'credits_otorgados', v_credits, 'lote_id', v_lote_id)
    );
  end loop;

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
-- Verificación -- reproduce EXACTO el escenario del bug: dos acreditaciones
-- que caen del mismo lado del "mismo día" en Argentina pero de lados
-- distintos de la medianoche UTC. Usá un socio y un pack de PRUEBA.
-- ============================================================

-- 1) Elegí un socio y un pack de una sola disciplina de créditos:
-- select p.id as user_id, p.dni from profiles p where p.dni = '<DNI DE PRUEBA>';
-- select id as pack_id, name, creditos from packs
-- where incluye_aparatos = false and jsonb_array_length(creditos) = 1 limit 5;

-- 2) Acreditá el primer pack:
-- select creditos_lotes from public.acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID>', 'manual');

-- 3) Simulá que ese lote quedó con un expires_at que es "el mismo día en
--    Argentina" pero "el día siguiente en UTC" -- ej. si hoy es
--    2026-09-08 en Argentina, un expires_at de las 23:30 hora Argentina
--    (02:30 UTC del día siguiente) sigue siendo "08/09" en Argentina.
--    Ajustá el lote recién creado para simular esa hora límite (tomá el id
--    real del jsonb que devolvió el paso 2):
-- update user_credits set expires_at = (expires_at::date || ' 23:30:00')::timestamp at time zone 'America/Argentina/Mendoza'
-- where id = '<LOTE_ID DEL PASO 2>';

-- 4) Acreditá el segundo pack de la MISMA disciplina, en un momento que en
--    UTC ya sea "el día siguiente" respecto al lote de arriba pero siga
--    siendo el MISMO día en Argentina (ej. corriendo este paso después de
--    las 21:00 hora Argentina) -- o, para no depender de la hora real a la
--    que corras esto, movele la fecha al lote de arriba con el UPDATE del
--    paso 3 para que separe por UTC pero no por Argentina, y confirmá que
--    ANTES de este fix fusionaban mal / AHORA fusionan bien:
-- select creditos_lotes from public.acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID>', 'manual');
-- El lote_id que devuelve tiene que ser EL MISMO que en el paso 2 -- eso
-- confirma que fusionó (antes de este fix, en este escenario puntual,
-- hubiera creado un lote nuevo en cambio).

-- 5) Confirmá UNA SOLA FILA con la suma:
-- select id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID>'
-- order by created_at desc;

-- ── Regresión -- los Casos A/B/C/D de supabase_migration_lotes_creditos_fase1.sql
-- siguen dando el mismo resultado (esta es una comparación en Argentina,
-- pero para acreditaciones normales -- hechas en horario diurno, sin cruzar
-- la medianoche UTC -- el resultado no cambia respecto a antes de este fix).
