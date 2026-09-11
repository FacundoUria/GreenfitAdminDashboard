-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN, MÁXIMA URGENCIA -- "Nuevo Socio" y "Cobrar" siguen
-- usando el sistema viejo (cantidades sueltas por disciplina, tipeadas a
-- mano) para acreditar créditos/Aparatos, generando el mismo bug de doble
-- vencimiento que ya se cerró en acreditar_pack() cada vez que se usan.
--
-- FASE 1 de este cambio: SOLO esta función nueva, sin conectar a ningún
-- frontend todavía -- NuevoSocioModal.jsx y RegistrarPagoModal.jsx siguen
-- llamando exactamente a lo que llamaban antes hasta que se decida
-- conectarlos (Fase 2). Esta función queda creada y probada, pero inerte.
--
-- CONTEXTO: acreditar_pack() ya resuelve el modelo de "un solo plan
-- activo" correctamente, pero exige un pack_id real de la tabla `packs`.
-- "Nuevo Socio" y "Cobrar" permiten que Seba tipee cantidades sueltas y
-- arbitrarias por disciplina que no siempre coinciden con ningún pack del
-- catálogo -- de ahí esta función, que acepta esas cantidades sueltas
-- directo (mismo formato que packs.creditos) en vez de un pack_id.
--
-- ============================================================
-- DECISIÓN: duplicar la lógica de acreditar_pack(), NO refactorizarla para
-- compartir un núcleo interno común. El pedido dejaba las dos opciones
-- abiertas -- se eligió duplicar por lo siguiente:
--   1. acreditar_pack() es código de producción ya validado (pasó por 2
--      fixes reales esta misma semana: el modelo de plan único y el ajuste
--      de now()-1 día para Aparatos) y lo llaman TANTO "Registrar Pago"
--      como el webhook de Mercado Pago -- cualquier edición, aunque sea un
--      refactor puramente interno sin cambiar su firma ni su
--      comportamiento, toca un camino que Seba y los cobros automáticos
--      usan AHORA MISMO, antes de que esta Fase 1 siquiera termine.
--   2. No hay forma de correr SQL contra la base desde acá en esta sesión
--      -- cada verificación depende de que quien lea esto la corra a mano
--      y reporte el resultado. Confirmar que un acreditar_pack()
--      refactorizado se comporta IDÉNTICO al de hoy, en un sistema
--      financiero en producción, sin poder probarlo yo mismo antes de
--      entregarlo, es un riesgo bastante más alto que sumar una función
--      nueva y desconectada que, por diseño (Fase 1: sin conectar
--      todavía), no puede romper nada existente pase lo que pase.
--   3. El pedido mismo habilita esta opción explícitamente si resulta más
--      segura.
-- La lógica de reseteo + espejo a `socios` de abajo es funcionalmente
-- idéntica a la de acreditar_pack() (mismo criterio, mismos comentarios
-- donde aplica) -- si en algún momento se decide extraer un núcleo
-- compartido, Fase 2 (cuando ya se sepa cómo se usa esta función en la
-- práctica) es un momento más seguro para ese refactor que ahora.
-- ============================================================
--
-- REGLA (idéntica a acreditar_pack, ver esa migración para el detalle
-- completo): acreditar acá RESETEA todo el plan anterior del socio --
-- créditos de disciplinas que esta carga no trae quedan en 0, y un
-- Aparatos vigente que esta carga no incluye se apaga -- y arma UN SOLO
-- plan nuevo (créditos + Aparatos si corresponde) con UNA sola fecha de
-- vencimiento.
--
-- p_fecha_inicio -- alta retroactiva: si Seba no toca el campo (null), la
-- vigencia arranca AHORA MISMO (now(), igual que acreditar_pack: "recién
-- comprado"). Si carga una fecha (ej. "en realidad empezó hace 5 días"),
-- la vigencia arranca a la MEDIANOCHE de ESE día en hora Argentina (viene
-- de un campo de fecha sin hora) -- el vencimiento se calcula siempre
-- desde ahí, nunca desde hoy.

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

  update user_credits
  set remaining_credits = 0
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
-- VERIFICACIÓN -- correr a mano con un socio y disciplinas de PRUEBA (no
-- reales), un caso a la vez. Mismo formato de siempre: armar el
-- escenario, llamar a la función, confirmar el resultado. Esta función
-- NO está conectada a ningún frontend todavía -- probarla acá es la única
-- forma de validarla en esta fase.
-- ============================================================

-- 0) Datos de prueba que vas a necesitar -- anotalos antes de arrancar:
-- select id as user_id, dni from profiles where dni = '<DNI_PRUEBA>';
-- select id as discipline_id, name, kind from disciplines order by kind, name;

-- ── CASO 1: socio con créditos activos de una disciplina, se le acreditan
-- créditos SUELTOS de OTRA disciplina distinta -- la vieja queda en 0, la
-- nueva con lo cargado, una sola fecha para todo. ────────────────────────
-- 1a) Sembrar créditos viejos de Kickstrike (o la disciplina que uses):
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
-- values ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_KICKSTRIKE>', 12, now() + interval '20 days');
-- 1b) Acreditar 8 créditos sueltos de CrossFit (otra disciplina), 30 días, sin fecha de inicio (hoy):
-- select * from admin_acreditar_creditos_manual(
--   '<USER_ID_PRUEBA>',
--   jsonb_build_array(jsonb_build_object('discipline_id', '<DISCIPLINE_ID_CROSSFIT>', 'credits', 8)),
--   false, 30, null
-- );
-- 1c) Verificar:
-- select discipline_id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' order by created_at desc;
-- -- esperado: la fila de Kickstrike (la vieja) con remaining_credits=0 (NO borrada);
-- -- una fila NUEVA de CrossFit con remaining_credits=8 y expires_at ≈ now()+30 días.
-- select creditos, fecha_vencimiento from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: creditos = 8 (no 12+8).

-- ── CASO 2: socio con Aparatos vigente, se le acreditan créditos sueltos
-- SIN incluir Aparatos -- Aparatos queda sin vigencia. ───────────────────
-- 2a) Sembrar Aparatos vigente:
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
-- values ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_APARATOS>', null, now() + interval '15 days');
-- 2b) Acreditar créditos sueltos, p_incluye_aparatos=false:
-- select * from admin_acreditar_creditos_manual(
--   '<USER_ID_PRUEBA>',
--   jsonb_build_array(jsonb_build_object('discipline_id', '<DISCIPLINE_ID_CROSSFIT>', 'credits', 4)),
--   false, 30, null
-- );
-- 2c) Verificar:
-- select discipline_id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID_APARATOS>' order by created_at desc;
-- -- esperado: la fila de Aparatos (la sembrada en 2a) con expires_at ≈ ayer (now() - 1 día) -- NINGUNA fila nueva de Aparatos.
-- select fecha_vencimiento, current_date from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: fecha_vencimiento = AYER (current_date - 1), claramente pasada.
-- select esta_habilitado_para_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_APARATOS>');
-- -- esperado: false, inmediatamente después del reseteo, sin importar la hora.

-- ── CASO 3: p_fecha_inicio en el pasado (alta retroactiva) -- el
-- vencimiento se calcula desde ESA fecha, no desde hoy. ──────────────────
-- 3a) Socio sin nada activo (o cualquiera, el reseteo lo deja limpio igual):
-- 3b) Acreditar con fecha de inicio hace 5 días, 30 días de vigencia:
-- select * from admin_acreditar_creditos_manual(
--   '<USER_ID_PRUEBA>',
--   jsonb_build_array(jsonb_build_object('discipline_id', '<DISCIPLINE_ID_CROSSFIT>', 'credits', 10)),
--   false, 30, (current_date - 5)
-- );
-- 3c) Verificar:
-- select discipline_id, remaining_credits, expires_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID_CROSSFIT>' order by created_at desc limit 1;
-- -- esperado: expires_at ≈ (current_date - 5) + 30 días = current_date + 25 días -- NO current_date + 30.
-- -- (con Aparatos incluido, mismo caso pero comparando contra
-- -- DISCIPLINE_ID_APARATOS y revisando socios.fecha_vencimiento también.)

-- ── CASO 4: socio sin nada, primera carga -- funciona normal. ───────────
-- 4a) Confirmar que no tiene nada activo:
-- select * from user_credits where user_id = '<USER_ID_PRUEBA_SIN_NADA>';
-- -- esperado: 0 filas (o todas en remaining_credits=0/expires_at vencido).
-- 4b) Acreditar créditos + Aparatos sueltos:
-- select * from admin_acreditar_creditos_manual(
--   '<USER_ID_PRUEBA_SIN_NADA>',
--   jsonb_build_array(
--     jsonb_build_object('discipline_id', '<DISCIPLINE_ID_CROSSFIT>', 'credits', 6),
--     jsonb_build_object('discipline_id', '<DISCIPLINE_ID_BOXEO>', 'credits', 4)
--   ),
--   true, 30, null
-- );
-- 4c) Verificar que acreditó normal, sin ningún error por "no había nada que resetear":
-- select discipline_id, remaining_credits, expires_at from user_credits where user_id = '<USER_ID_PRUEBA_SIN_NADA>';
-- select creditos, fecha_vencimiento from socios where dni = '<DNI_PRUEBA_SIN_NADA>';
-- -- esperado: CrossFit=6, Boxeo=4, Aparatos con expires_at ≈ now()+30, los 3 con la misma fecha.

-- ── Regresión rápida -- guardas ──────────────────────────────────────────
-- select admin_acreditar_creditos_manual('<USER_ID_PRUEBA>', '[]'::jsonb, false, 30, null);
-- -- esperado: excepción "No se especificó ningún crédito ni Aparatos...".
-- select admin_acreditar_creditos_manual('<USER_ID_PRUEBA>', jsonb_build_array(jsonb_build_object('discipline_id', gen_random_uuid(), 'credits', 5)), false, 30, null);
-- -- esperado: excepción "La disciplina % no existe.".
-- select admin_acreditar_creditos_manual('<USER_ID_PRUEBA>', jsonb_build_array(jsonb_build_object('discipline_id', '<DISCIPLINE_ID_APARATOS>', 'credits', 5)), false, 30, null);
-- -- esperado: excepción "...no es de créditos..." (Aparatos no se acredita por esta lista).
-- select admin_acreditar_creditos_manual('<USER_ID_PRUEBA>', jsonb_build_array(jsonb_build_object('discipline_id', '<DISCIPLINE_ID_CROSSFIT>', 'credits', 0)), false, 30, null);
-- -- esperado: excepción "Cantidad de créditos inválida...".
-- select admin_acreditar_creditos_manual('<USER_ID_PRUEBA>', jsonb_build_array(
--   jsonb_build_object('discipline_id', '<DISCIPLINE_ID_CROSSFIT>', 'credits', 5),
--   jsonb_build_object('discipline_id', '<DISCIPLINE_ID_CROSSFIT>', 'credits', 3)
-- ), false, 30, null);
-- -- esperado: excepción "...está repetida más de una vez...".
-- select admin_acreditar_creditos_manual('<USER_ID_PRUEBA>', jsonb_build_array(jsonb_build_object('discipline_id', '<DISCIPLINE_ID_CROSSFIT>', 'credits', 5)), false, 0, null);
-- -- esperado: excepción "p_dias_vigencia inválido...".
