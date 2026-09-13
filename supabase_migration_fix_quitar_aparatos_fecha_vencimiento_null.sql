-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- CONTEXTO (caso real Arianna Isgro, DNI 51705419): admin_quitar_
-- disciplina_socio() (supabase_migration_admin_quitar_disciplina_socio.sql)
-- -- rama kind='membership' -- releía el expires_at más reciente de
-- Aparatos DESPUÉS del ajuste y usaba coalesce(esa_fecha, fecha_vencimiento)
-- para el espejo en `socios`. La intención (documentada en esa misma
-- migración) era una salvaguarda: "si el socio nunca tuvo otra fila de
-- Aparatos, no perder el valor viejo". En los hechos, esa salvaguarda es la
-- causa de que "destildar Aparatos" no haga NADA visible cuando nunca hubo
-- una fila real detrás (fecha_vencimiento con una fecha residual -- import
-- de CrossFy, el campo "Fecha de vencimiento" ya eliminado del Admin --
-- sin ninguna fila en user_credits): el UPDATE de abajo no encuentra
-- ninguna fila para tocar (0 filas afectadas, sin excepción), la relectura
-- da NULL, y coalesce mantenía el valor viejo tal cual -- el checkbox
-- seguía tildado para siempre, sin ningún error que avisara nada.
--
-- FIX: sin coalesce. Si después del ajuste no queda NINGUNA fila real de
-- esta disciplina, fecha_vencimiento pasa a NULL -- refleja la realidad
-- (nada real) en vez de mentir con un dato viejo. NULL en esta columna ya
-- es un valor completamente normal y soportado en todo el código (un socio
-- 100% créditos que nunca tuvo Aparatos también lo tiene en NULL,
-- calcularEstadoCuota/tieneAparatosVigente/estaPorVencer/
-- diasHastaVencimiento ya lo tratan con gracia) -- no es un estado nuevo,
-- solo pasa a ser alcanzable también desde "sacar la última Aparatos que
-- quedaba sin fila real".
--
-- La rama kind='credits' (créditos) NO se toca -- nunca escribió
-- fecha_vencimiento, este fix es 100% acotado a Aparatos/Pase Libre.

create or replace function public.admin_quitar_disciplina_socio(
  p_user_id uuid,
  p_discipline_id uuid
)
returns void
language plpgsql
security definer
as $$
declare
  v_kind text;
  v_dni text;
  v_nuevo_total_global int;
  v_fecha_aparatos_actual timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select kind into v_kind from disciplines where id = p_discipline_id;
  if v_kind is null then
    raise exception 'La disciplina % no existe.', p_discipline_id;
  end if;

  if v_kind = 'credits' then
    -- Créditos -- a 0 en cualquier lote activo de ESTA disciplina nada
    -- más. El resto del plan (otras disciplinas + Aparatos) no se toca.
    update user_credits
    set remaining_credits = 0
    where user_id = p_user_id and discipline_id = p_discipline_id and remaining_credits > 0;
  else
    -- Aparatos / Pase Libre (kind='membership') -- mismo ajuste de -1 día
    -- que ya usa acreditar_pack() para apagar Aparatos. Si no había
    -- ninguna fila vigente (caso Arianna: cero filas, ni vigente ni
    -- vencida), este UPDATE simplemente no afecta ninguna fila -- no
    -- rompe nada, sigue de largo hacia el espejo de abajo.
    update user_credits
    set expires_at = now() - interval '1 day'
    where user_id = p_user_id and discipline_id = p_discipline_id and expires_at > now();
  end if;

  -- Espejo en socios -- recalculado desde cero, mismo criterio que
  -- admin_fijar_creditos_disciplina()/admin_ajustar_credito_disciplina().
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    select coalesce(sum(uc.remaining_credits), 0) into v_nuevo_total_global
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id
    where uc.user_id = p_user_id
      and d.kind = 'credits'
      and uc.remaining_credits > 0
      and uc.expires_at > now();

    if v_kind = 'credits' then
      update socios set creditos = v_nuevo_total_global where dni = v_dni;
    else
      -- Se relee el expires_at REAL de Aparatos después del ajuste (la
      -- fila más reciente, vigente o no). FIX -- sin ninguna fila
      -- (v_fecha_aparatos_actual queda NULL), fecha_vencimiento pasa a
      -- NULL directo -- YA NO se preserva el valor viejo vía coalesce.
      select expires_at into v_fecha_aparatos_actual
      from user_credits
      where user_id = p_user_id and discipline_id = p_discipline_id
      order by created_at desc
      limit 1;

      update socios
      set creditos = v_nuevo_total_global,
          fecha_vencimiento = (v_fecha_aparatos_actual at time zone 'America/Argentina/Mendoza')::date
      where dni = v_dni;
    end if;
  end if;
end;
$$;

grant execute on function public.admin_quitar_disciplina_socio(uuid, uuid) to authenticated;

-- ============================================================
-- VERIFICACIÓN -- correr a mano con socios de PRUEBA.
-- ============================================================

-- ── CASO 1 (regresión -- sigue igual que antes): sacar Aparatos con una
-- fila real vigente -- fecha_vencimiento queda en AYER, no en null. ───────
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_APARATOS>', null, now() + interval '20 days');
-- select admin_quitar_disciplina_socio('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_APARATOS>');
-- select fecha_vencimiento, current_date from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: fecha_vencimiento = AYER, claramente pasada (sin cambios respecto de antes).

-- ── CASO 2 (el fix -- caso Arianna): sacar Aparatos SIN ninguna fila real
-- detrás -- fecha_vencimiento pasa a NULL, no se queda con el valor viejo. ─
-- -- Escenario: socios.fecha_vencimiento con una fecha futura "fantasma",
-- -- CERO filas en user_credits para esa disciplina.
-- select admin_quitar_disciplina_socio('<USER_ID_ARIANNA>', '<DISCIPLINE_ID_APARATOS>');
-- select fecha_vencimiento from socios where dni = '51705419';
-- -- esperado: NULL (antes del fix: se quedaba con la fecha fantasma vieja).

-- ── Regresión -- créditos no se tocan por este fix. ──────────────────────
-- select admin_quitar_disciplina_socio('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_CROSSFIT>');
-- select creditos from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: sin cambios respecto del comportamiento ya probado en
-- -- supabase_migration_admin_quitar_disciplina_socio.sql.
