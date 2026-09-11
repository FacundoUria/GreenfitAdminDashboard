-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN -- máximo riesgo: reemplaza el modelo de lotes
-- (varias filas activas por disciplina, fusión por día calendario) por
-- uno de "UN SOLO plan activo" (regla de negocio confirmada con el
-- cliente, no se vuelve a evaluar acá).
--
-- FASE 1 de esta migración: SOLO acreditar_pack(). Nada más se toca --
-- book_class/admin_book_class/cancel_booking/admin_cancel_booking/
-- esta_habilitado_para_disciplina/registrar_hoy_entrene/
-- admin_revertir_comprobante y todo el frontend siguen exactamente igual
-- hasta que esto se valide y se decida conectar las fases siguientes.
--
-- REGLA NUEVA:
--   - Un socio tiene UN SOLO "plan activo" en cualquier momento -- el
--     contenido del ÚLTIMO pack comprado (créditos por disciplina +
--     Aparatos si el pack lo incluye) + UNA sola fecha de vencimiento
--     (now() + dias_vigencia del pack) para TODO ese plan.
--   - Acreditar un pack nuevo RESETEA todo lo anterior, sin importar la
--     disciplina -- créditos sin usar de disciplinas que el pack nuevo no
--     trae se pierden, y un Aparatos vigente que el pack nuevo no incluye
--     también se pierde. Sin excepciones, sin fusión, sin "el mayor de
--     los dos vencimientos".
--   - Nunca hay más de una fila ACTIVA de créditos por disciplina, ni
--     concepto de lote -- eso se elimina de esta función por completo
--     (las filas viejas NUNCA se borran, igual que siempre -- bookings.
--     credit_lote_id puede referenciarlas -- pero quedan en
--     remaining_credits=0/expires_at<=now(), inertes).
--
-- GAP REAL entre la regla y el dato existente -- leer antes de correr:
-- "now() + dias_vigencia del pack, sin excepciones" no se puede cumplir
-- literal hoy -- PackModal.jsx graba `dias_vigencia = incluyeAparatos ?
-- N : null` -- TODO pack 100% créditos (sin Aparatos) tiene
-- dias_vigencia=null en la base ahora mismo. Sin un fallback, cualquier
-- compra de un pack así crasharía (now() + null days = null). Este script
-- usa 30 días como fallback cuando dias_vigencia es null -- el mismo
-- default plano que ya usaban los packs de créditos antes de este cambio
-- (antes: siempre 30 días fijo, ignorando dias_vigencia por completo).
-- Si preferís otro número, o que dias_vigencia pase a ser obligatorio en
-- packs.creditos para TODO pack (no solo los que incluyen Aparatos),
-- avisame antes de aplicar esto -- es un cambio de UI/datos aparte.
--
-- Espejo en socios.fecha_vencimiento cuando el pack NUEVO no incluye
-- Aparatos: el código viejo hacía `coalesce(fecha_nueva, fecha_vieja)` --
-- con el modelo de lotes, "este pack no tocó Aparatos" quería decir
-- literalmente que Aparatos no cambió, así que mantener la fecha vieja
-- era correcto. Con la regla nueva, "no tocó Aparatos" en realidad
-- significa "Aparatos se acaba de resetear a no-vigente" -- mantener la
-- fecha vieja en socios.fecha_vencimiento la dejaría mostrando una fecha
-- futura mentirosa. Por eso acá se relee el expires_at REAL de Aparatos
-- después del reseteo (sea el nuevo del pack, o el `now()` recién puesto)
-- y se espeja ESO, no la fecha vieja.

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
  update user_credits
  set remaining_credits = 0
  where user_id = p_user_id
    and remaining_credits > 0
    and discipline_id in (select id from disciplines where kind = 'credits');

  -- Aparatos -- cualquier fila todavía vigente deja de estarlo ya mismo,
  -- sin importar si el pack nuevo la va a reemplazar o no.
  if v_aparatos_discipline_id is not null then
    update user_credits
    set expires_at = now()
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
-- VERIFICACIÓN -- correr a mano con un socio y packs de PRUEBA (no
-- reales), un caso a la vez. Mismo formato de siempre: armar el
-- escenario, llamar a la función, confirmar el resultado.
-- ============================================================

-- 0) Datos de prueba que vas a necesitar -- anotalos antes de arrancar:
-- select id as user_id, dni from profiles where dni = '<DNI_PRUEBA>';
-- select id as discipline_id, name, kind from disciplines order by kind, name;
-- select id as pack_id, name, creditos, incluye_aparatos, dias_vigencia from packs where is_active = true order by name;

-- ── CASO 1: socio con créditos activos de una disciplina, compra un pack
-- de OTRA disciplina distinta -- la vieja queda en 0, la nueva con lo que
-- corresponde, una sola fecha para todo. ────────────────────────────────
-- 1a) Sembrar créditos viejos de Kickstrike (o la disciplina que uses):
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
-- values ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_KICKSTRIKE>', 12, now() + interval '20 days');
-- 1b) Acreditar un pack de CrossFit (otra disciplina):
-- select * from acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID_CROSSFIT>', 'manual');
-- 1c) Verificar:
-- select discipline_id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' order by created_at desc;
-- -- esperado: la fila de Kickstrike (la vieja) con remaining_credits=0 (NO borrada);
-- -- una fila NUEVA de CrossFit con los créditos del pack y expires_at = now()+dias_vigencia (o +30 si el pack no tiene dias_vigencia).
-- select creditos, fecha_vencimiento from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: creditos = exactamente los de CrossFit (no 12+lo nuevo).

-- ── CASO 2: socio con Aparatos vigente, compra un pack que NO incluye
-- Aparatos -- Aparatos queda sin vigencia. ──────────────────────────────
-- 2a) Sembrar Aparatos vigente:
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
-- values ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_APARATOS>', null, now() + interval '15 days');
-- 2b) Acreditar un pack 100% créditos (incluye_aparatos=false):
-- select * from acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID_SOLO_CREDITOS>', 'manual');
-- 2c) Verificar:
-- select discipline_id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID_APARATOS>' order by created_at desc;
-- -- esperado: la fila de Aparatos (la sembrada en 2a) con expires_at <= now() (ya no vigente) -- NINGUNA fila nueva de Aparatos.
-- select fecha_vencimiento from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: fecha_vencimiento = HOY (refleja que Aparatos se apagó), NO la fecha futura vieja.

-- ── CASO 3: socio con Aparatos vigente, compra un combo que SÍ incluye
-- Aparatos -- la fecha nueva es hoy+dias_vigencia del pack NUEVO, no una
-- extensión de la vieja. ─────────────────────────────────────────────────
-- 3a) Sembrar Aparatos vigente con una fecha LEJANA (para que quede claro
-- que no se "extiende" sobre ella):
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
-- values ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_APARATOS>', null, now() + interval '90 days');
-- 3b) Acreditar un combo con Aparatos + créditos (dias_vigencia, ej. 30):
-- select * from acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID_COMBO_CON_APARATOS>', 'manual');
-- 3c) Verificar:
-- select discipline_id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID_APARATOS>' order by created_at desc;
-- -- esperado: fila vieja (90 días) con expires_at <= now(); fila NUEVA con
-- -- expires_at = now() + dias_vigencia DEL PACK NUEVO (ej. +30 días) -- NO now()+90.
-- select fecha_vencimiento from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: coincide con la fecha nueva (now()+dias_vigencia del combo), no con los 90 días viejos.

-- ── CASO 4: socio sin nada, compra un pack -- funciona normal. ──────────
-- 4a) Confirmar que no tiene nada activo:
-- select * from user_credits where user_id = '<USER_ID_PRUEBA_SIN_NADA>';
-- -- esperado: 0 filas (o todas en remaining_credits=0/expires_at vencido).
-- 4b) Acreditar cualquier pack:
-- select * from acreditar_pack('<USER_ID_PRUEBA_SIN_NADA>', '<PACK_ID>', 'manual');
-- 4c) Verificar que acreditó normal, sin ningún error por "no había nada que resetear":
-- select discipline_id, remaining_credits, expires_at from user_credits where user_id = '<USER_ID_PRUEBA_SIN_NADA>';
-- select creditos, fecha_vencimiento from socios where dni = '<DNI_PRUEBA_SIN_NADA>';

-- ── Regresión rápida -- guardas que siguen intactas ──────────────────────
-- select acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID_INEXISTENTE_O_UUID_RANDOM>', 'manual');
-- -- esperado: excepción "El pack % no existe.".
-- select acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID>', 'origen_invalido');
-- -- esperado: excepción "p_origen inválido...".
