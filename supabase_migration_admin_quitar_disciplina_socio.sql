-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- CONTEXTO: los checkboxes de "Planes/Actividades" en Editar Socio y la
-- columna "Plan/Membresía" de la tabla de Socios dejan de leer socios.plan
-- (un campo editado a mano por Seba, desincronizado de la realidad -- caso
-- real: Valentina Ramon) y pasan a calcularse en vivo desde user_credits +
-- Aparatos vigente (ver el fix en el frontend, mismo ticket). La única
-- acción que queda disponible desde ese checkbox es DESTILDAR una
-- disciplina activa -- este RPC es lo que ejecuta eso: le saca al socio
-- una disciplina puntual, sin tocar ninguna otra.
--
-- Mismo criterio de reseteo de siempre (acreditar_pack/
-- admin_acreditar_creditos_manual): nunca se borra una fila de
-- user_credits, se la deja en 0 / vencida -- Aparatos usa
-- now() - interval '1 day' (no now() a secas) por el mismo motivo ya
-- documentado en esas migraciones: now() a secas deja una fecha que, leída
-- por día completo (esta_habilitado_para_disciplina, fecha_vencimiento >=
-- current_date), sigue pareciendo vigente hasta la medianoche.
--
-- Pase Libre NO se trata distinto de Aparatos -- son la misma disciplina/
-- columna (kind='membership'), un alias de nomenclatura nada más. Este RPC
-- ni siquiera necesita saber cuál de las dos etiquetas usa el socio: solo
-- le importa el discipline_id real que le pasa el frontend.

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
    -- que ya usa acreditar_pack() para apagar Aparatos.
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
      -- Igual que acreditar_pack(): se relee el expires_at REAL de
      -- Aparatos después del ajuste (la fila más reciente) -- si el socio
      -- nunca tuvo otra fila de Aparatos, coalesce mantiene lo que ya
      -- había en socios.fecha_vencimiento en vez de pisarlo con null.
      select expires_at into v_fecha_aparatos_actual
      from user_credits
      where user_id = p_user_id and discipline_id = p_discipline_id
      order by created_at desc
      limit 1;

      update socios
      set creditos = v_nuevo_total_global,
          fecha_vencimiento = coalesce(
            (v_fecha_aparatos_actual at time zone 'America/Argentina/Mendoza')::date,
            fecha_vencimiento
          )
      where dni = v_dni;
    end if;
  end if;
end;
$$;

grant execute on function public.admin_quitar_disciplina_socio(uuid, uuid) to authenticated;

-- ============================================================
-- VERIFICACIÓN -- correr a mano con un socio de PRUEBA. Armá el escenario:
-- CrossFit (12 créditos) + Kickstrike (12 créditos) + Aparatos, los 3
-- vigentes.
-- ============================================================

-- 0) Escenario:
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_CROSSFIT>', 12, now() + interval '20 days'),
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_KICKSTRIKE>', 12, now() + interval '20 days'),
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_APARATOS>', null, now() + interval '20 days');

-- ── CASO 1: sacar CrossFit -- Kickstrike y Aparatos quedan intactos. ─────
-- select admin_quitar_disciplina_socio('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_CROSSFIT>');
-- select d.name, uc.remaining_credits, uc.expires_at from user_credits uc
-- join disciplines d on d.id = uc.discipline_id
-- where uc.user_id = '<USER_ID_PRUEBA>' order by d.name;
-- -- esperado: CrossFit remaining_credits=0 (fila NO borrada); Kickstrike sigue en 12; Aparatos sin tocar.
-- select creditos from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: 12 (solo Kickstrike).

-- ── CASO 2: sacar Aparatos -- los créditos no se tocan. ──────────────────
-- select admin_quitar_disciplina_socio('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_APARATOS>');
-- select expires_at from user_credits where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID_APARATOS>' order by created_at desc limit 1;
-- -- esperado: expires_at ≈ ayer (now() - 1 día).
-- select fecha_vencimiento, current_date from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: fecha_vencimiento = AYER, claramente pasada.
-- select esta_habilitado_para_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_APARATOS>');
-- -- esperado: false.

-- ── Regresión -- guardas ──────────────────────────────────────────────────
-- select admin_quitar_disciplina_socio('<USER_ID_PRUEBA>', gen_random_uuid());
-- -- esperado: excepción "La disciplina % no existe.".
