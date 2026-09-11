-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN, MÁXIMA URGENCIA -- esta herramienta se usa ahora
-- mismo y cada uso recrea el bug de doble vencimiento.
--
-- CAUSA CONFIRMADA (ver investigación aparte): admin_fijar_creditos_
-- disciplina() y admin_ajustar_credito_disciplina() -- el editor de
-- "Editar Socio" (Fijar/+1/-1) -- quedaron con la lógica del modelo de
-- LOTES viejo cuando se reescribió acreditar_pack() al modelo de "un solo
-- plan activo": solo tocan la disciplina que se les pasa (nunca resetean
-- el resto del plan) y crean filas con SU PROPIA fecha (fusión por día
-- calendario o now()+30 días fijo), sin relación con la fecha real del
-- plan vigente del socio. Huella: sus INSERT nunca setean pack_id (a
-- diferencia de acreditar_pack, que siempre lo hace) -- confirmado en
-- Andrea Migoya, Antonela Ponce y Tobias Colaizzo.
--
-- REGLA NUEVA: el editor corrige UN NÚMERO puntual de UNA disciplina, sin
-- tocar el resto del plan (otras disciplinas + Aparatos quedan
-- EXACTAMENTE igual) y sin inventar una fecha nueva -- usa la MISMA fecha
-- que ya tiene el plan actual del socio.
--
-- ============================================================
-- Helper interno -- "¿cuál es la fecha del plan actual de este socio?"
-- La fecha COMPARTIDA por sus disciplinas activas hoy (créditos con
-- remaining_credits>0 y expires_at>now(), o Aparatos con expires_at>now())
-- -- bajo el modelo nuevo debería ser una sola. Si hay residuo (más de
-- una, un socio que todavía no compró desde el cambio), toma la más
-- lejana -- nunca falla, nunca explota. Sin disciplinas activas todavía
-- (socio nuevo o recién limpiado del todo): now()+30 días, mismo default
-- de siempre. No expuesta a `authenticated` -- es un helper interno, las
-- dos funciones de abajo (SECURITY DEFINER, ya gateadas por is_admin())
-- la llaman con los privilegios de su propio owner.
-- ============================================================
create or replace function public.resolver_fecha_plan_actual(p_user_id uuid)
returns timestamptz
language plpgsql
security definer
stable
as $$
declare
  v_fecha timestamptz;
begin
  select max(expires_at) into v_fecha
  from (
    select uc.expires_at
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id and d.kind = 'credits'
    where uc.user_id = p_user_id and uc.remaining_credits > 0 and uc.expires_at > now()

    union all

    select uc.expires_at
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id and d.kind = 'membership'
    where uc.user_id = p_user_id and uc.expires_at > now()
  ) activas;

  return coalesce(v_fecha, now() + interval '30 days');
end;
$$;

-- ============================================================
-- 1) admin_fijar_creditos_disciplina() -- reescrita
-- ============================================================
create or replace function public.admin_fijar_creditos_disciplina(
  p_user_id uuid,
  p_discipline_id uuid,
  p_creditos int
)
returns void
language plpgsql
security definer
as $$
declare
  v_kind text;
  v_dni text;
  v_fecha_plan timestamptz;
  v_nuevo_total_global int;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  if p_creditos is null or p_creditos < 0 then
    raise exception 'p_creditos inválido: % -- tiene que ser un entero mayor o igual a 0.', p_creditos;
  end if;

  select kind into v_kind from disciplines where id = p_discipline_id;
  if v_kind is null then
    raise exception 'La disciplina % no existe.', p_discipline_id;
  end if;
  if v_kind <> 'credits' then
    raise exception 'admin_fijar_creditos_disciplina() es solo para disciplinas de créditos -- % es de tipo %, no tiene lotes de créditos (Aparatos se edita por su fecha de vencimiento).', p_discipline_id, v_kind;
  end if;

  -- Consolidar SOLO esta disciplina -- nunca se borra una fila, se la deja
  -- en 0 (bookings.credit_lote_id puede apuntarle). El resto del plan
  -- (otras disciplinas + Aparatos) no se toca para nada.
  --
  -- Se hace ANTES de resolver la fecha del plan a propósito: si la
  -- disciplina que se está corrigiendo tenía residuo con una fecha
  -- mismatcheada, esa fecha vieja no puede "contar" como la fecha del
  -- plan -- justo eso es lo que se está arreglando. Poniéndola en 0
  -- primero, resolver_fecha_plan_actual() ya no la ve como activa y
  -- resuelve la fecha real de las DEMÁS disciplinas.
  update user_credits
  set remaining_credits = 0
  where user_id = p_user_id and discipline_id = p_discipline_id and remaining_credits > 0;

  -- "Un solo plan activo" -- la fecha nueva es la del plan actual del
  -- socio (compartida por sus otras disciplinas activas), NUNCA una fecha
  -- propia inventada acá.
  v_fecha_plan := public.resolver_fecha_plan_actual(p_user_id);

  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
  values (p_user_id, p_discipline_id, p_creditos, v_fecha_plan);

  -- Espejo en socios.creditos -- recalculado desde cero, sumando TODAS las
  -- disciplinas de créditos (no solo la tocada). fecha_vencimiento NO se
  -- toca -- esta función nunca cambia Aparatos.
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    select coalesce(sum(uc.remaining_credits), 0) into v_nuevo_total_global
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id
    where uc.user_id = p_user_id
      and d.kind = 'credits'
      and uc.remaining_credits > 0
      and uc.expires_at > now();

    update socios set creditos = v_nuevo_total_global where dni = v_dni;
  end if;
end;
$$;

grant execute on function public.admin_fijar_creditos_disciplina(uuid, uuid, int) to authenticated;

-- ============================================================
-- 2) admin_ajustar_credito_disciplina() -- reescrita
-- ============================================================
create or replace function public.admin_ajustar_credito_disciplina(
  p_user_id uuid,
  p_discipline_id uuid,
  p_delta int
)
returns void
language plpgsql
security definer
as $$
declare
  v_kind text;
  v_dni text;
  v_fecha_plan timestamptz;
  v_lote_id uuid;
  v_restante int;
  v_lote record;
  v_descuento int;
  v_nuevo_total_global int;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select kind into v_kind from disciplines where id = p_discipline_id;
  if v_kind is null then
    raise exception 'La disciplina % no existe.', p_discipline_id;
  end if;
  if v_kind <> 'credits' then
    raise exception 'admin_ajustar_credito_disciplina() es solo para disciplinas de créditos -- % es de tipo %, no tiene lotes de créditos (Aparatos se edita por su fecha de vencimiento).', p_discipline_id, v_kind;
  end if;

  if p_delta is null or p_delta = 0 then
    return; -- nada que ajustar
  end if;

  if p_delta > 0 then
    -- Suma sobre la fila ACTIVA de esta disciplina si existe -- conserva
    -- SU fecha tal cual (bajo el modelo nuevo ya debería coincidir con la
    -- del plan, así que no hace falta ni tiene sentido tocarla). YA NO se
    -- fusiona "por día calendario" -- ese concepto era del modelo de
    -- lotes; ahora alcanza con "¿hay una fila activa de esta disciplina?".
    -- Si hay más de una (residuo), se toma la de fecha más lejana --
    -- mismo criterio que resolver_fecha_plan_actual().
    select id into v_lote_id
    from user_credits
    where user_id = p_user_id
      and discipline_id = p_discipline_id
      and remaining_credits > 0
      and expires_at > now()
    order by expires_at desc
    limit 1
    for update;

    if v_lote_id is not null then
      update user_credits set remaining_credits = remaining_credits + p_delta where id = v_lote_id;
    else
      -- Sin ninguna fila activa de esta disciplina -- la fila nueva usa la
      -- fecha del plan actual del socio, NUNCA una fecha propia de 30 días.
      v_fecha_plan := public.resolver_fecha_plan_actual(p_user_id);
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
      values (p_user_id, p_discipline_id, p_delta, v_fecha_plan);
    end if;
  else
    -- Descuenta de la(s) fila(s) activa(s) existentes, sin bajar de 0, sin
    -- crear nada -- sin cambios respecto de antes. El loop FIFO (por
    -- expires_at asc) sigue ahí como salvaguarda para el caso RESIDUAL de
    -- un socio con 2+ filas activas de la misma disciplina (no debería
    -- pasar bajo el modelo nuevo, pero no rompe si pasa) -- bajo uso
    -- normal (1 sola fila activa), es exactamente "descontá de esa".
    v_restante := abs(p_delta);

    for v_lote in
      select id, remaining_credits
      from user_credits
      where user_id = p_user_id
        and discipline_id = p_discipline_id
        and remaining_credits > 0
        and expires_at > now()
      order by expires_at asc
      for update
    loop
      exit when v_restante <= 0;

      v_descuento := least(v_lote.remaining_credits, v_restante);
      update user_credits
      set remaining_credits = remaining_credits - v_descuento
      where id = v_lote.id;

      v_restante := v_restante - v_descuento;
    end loop;
    -- Si v_restante sigue > 0 acá, no había suficiente saldo -- se
    -- descontó todo lo que había y se corta, sin error.
  end if;

  -- Espejo en socios.creditos -- recalculado desde cero, mismo criterio
  -- que admin_fijar_creditos_disciplina(). fecha_vencimiento NO se toca.
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    select coalesce(sum(uc.remaining_credits), 0) into v_nuevo_total_global
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id
    where uc.user_id = p_user_id
      and d.kind = 'credits'
      and uc.remaining_credits > 0
      and uc.expires_at > now();

    update socios set creditos = v_nuevo_total_global where dni = v_dni;
  end if;
end;
$$;

grant execute on function public.admin_ajustar_credito_disciplina(uuid, uuid, int) to authenticated;

-- ============================================================
-- VERIFICACIÓN -- correr a mano con un socio de PRUEBA. Armá el escenario
-- del pedido: 2 disciplinas de créditos + Aparatos, las 3 con la MISMA
-- fecha (simulando un plan único real ya vigente).
-- ============================================================

-- 0) Escenario -- CrossFit (8), Boxeo (4) y Aparatos, los 3 venciendo el
-- mismo día (ej. hoy + 20 días):
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_CROSSFIT>', 8, now() + interval '20 days'),
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_BOXEO>', 4, now() + interval '20 days'),
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_APARATOS>', null, now() + interval '20 days');

-- ── CASO 1: "Fijar en" sobre CrossFit -- Boxeo y Aparatos NO se mueven,
-- CrossFit cambia de número pero mantiene la MISMA fecha del plan. ───────
-- select admin_fijar_creditos_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_CROSSFIT>', 15);
-- select d.name, uc.remaining_credits, uc.expires_at from user_credits uc
-- join disciplines d on d.id = uc.discipline_id
-- where uc.user_id = '<USER_ID_PRUEBA>' and uc.remaining_credits > 0 and uc.expires_at > now()
-- order by d.name;
-- -- esperado: CrossFit=15 con la MISMA fecha (+20 días) que tenía antes -- Boxeo sigue en 4, Aparatos sin tocar, mismas fechas.

-- ── CASO 2: mismo escenario, con +1/-1 en vez de Fijar. ──────────────────
-- select admin_ajustar_credito_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_CROSSFIT>', 1);
-- select admin_ajustar_credito_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_CROSSFIT>', -3);
-- -- mismo select de arriba -- esperado: CrossFit cambia de número (16, después 13), la fecha NUNCA cambia, Boxeo/Aparatos intactos.

-- ── CASO 3: socio SIN ninguna disciplina activa -- primera vez que se usa
-- "Fijar" -- usa now()+30 días. ──────────────────────────────────────────
-- select admin_fijar_creditos_disciplina('<USER_ID_PRUEBA_SIN_NADA>', '<DISCIPLINE_ID>', 10);
-- select remaining_credits, expires_at from user_credits where user_id = '<USER_ID_PRUEBA_SIN_NADA>' order by created_at desc limit 1;
-- -- esperado: expires_at ≈ now()+30 días.

-- ── Regresión -- de los 8 casos que ya estaban probados, cuáles siguen
-- aplicando y cuáles quedaron obsoletos (ver detalle completo en la
-- respuesta) -- resumen:
--   - Fijar mayor / menor / en 0: siguen aplicando, pero la fecha esperada
--     ahora es la del PLAN (no "el vencimiento más lejano de la propia
--     disciplina").
--   - "+1 fusiona con lote existente del mismo día calendario": OBSOLETO
--     -- ya no hay fusión por día, ahora es "¿hay una fila activa?".
--   - "+1 sin lote existente crea uno a +30 días": OBSOLETO en el motivo
--     (ya no es +30 fijo, es la fecha del plan) pero el ESPÍRITU sigue
--     (crear cuando no hay fila activa).
--   - "-1 con varios lotes, FIFO": pasa de ser el caso NORMAL a ser
--     salvaguarda de un caso RESIDUAL (no debería pasar bajo el modelo
--     nuevo).
--   - "-1 sin nada que descontar" y "guardas de Aparatos": sin cambios,
--     siguen aplicando tal cual.
-- select admin_ajustar_credito_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_CROSSFIT>', -999);
-- -- esperado: no explota, descuenta hasta 0 y corta ahí.
-- select admin_fijar_creditos_disciplina('<USER_ID_PRUEBA>', (select id from disciplines where kind='membership' limit 1), 5);
-- -- esperado: excepción "admin_fijar_creditos_disciplina() es solo para disciplinas de créditos...".
