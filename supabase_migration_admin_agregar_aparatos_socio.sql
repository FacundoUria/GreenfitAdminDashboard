-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- CONTEXTO (CAMBIO 5 del ticket "sacar tolerancia + simplificar estados +
-- arreglar Activo sin nada real"): "+ Agregar disciplina" (Editar Socio,
-- CreditosEditablesSocio.jsx) solo ofrece disciplinas kind='credits' a
-- propósito -- admin_fijar_creditos_disciplina() rechaza kind='membership'
-- explícitamente (ver supabase_migration_fix_editor_creditos_plan_unico.sql,
-- "es solo para disciplinas de créditos... Aparatos se edita por su fecha
-- de vencimiento"). Volver a agregar Aparatos a un socio al que se le sacó
-- (admin_quitar_disciplina_socio) no tenía ningún camino corto: había que
-- pasar por "Registrar Pago" completo. Este RPC es ese camino corto,
-- simétrico al de sacar -- mismo patrón (security definer + is_admin() +
-- mirror a socios), pero para AGREGAR, no para quitar.
--
-- Reusa resolver_fecha_plan_actual() (mismo helper que ya usan
-- admin_fijar_creditos_disciplina/admin_ajustar_credito_disciplina) para la
-- fecha -- NUNCA inventa una fecha propia: si el socio ya tiene algo activo
-- (créditos u otra membresía), Aparatos queda con la MISMA fecha que el
-- resto del plan; si no tiene nada, now()+30 días, igual que cualquier
-- disciplina nueva.

create or replace function public.admin_agregar_aparatos_socio(
  p_user_id uuid
)
returns void
language plpgsql
security definer
as $$
declare
  v_dni text;
  v_aparatos_discipline_id uuid;
  v_ya_vigente boolean;
  v_fecha_plan timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select id into v_aparatos_discipline_id from disciplines where kind = 'membership' limit 1;
  if v_aparatos_discipline_id is null then
    raise exception 'No hay ninguna disciplina de tipo membresía (Aparatos) en el catálogo.';
  end if;

  -- Guarda -- no tiene sentido "agregar" algo que ya está vigente; para
  -- cambiarle la fecha existe "Registrar Pago"/"Cobrar", no este atajo.
  select exists(
    select 1 from user_credits
    where user_id = p_user_id
      and discipline_id = v_aparatos_discipline_id
      and expires_at > now()
  ) into v_ya_vigente;
  if v_ya_vigente then
    raise exception 'El socio ya tiene Aparatos vigente -- no hay nada que agregar.';
  end if;

  -- "Un solo plan activo" -- misma fecha que el resto del plan del socio
  -- (créditos activos + Aparatos, si tuviera otra fila residual futura),
  -- o now()+30 días si no tiene nada activo todavía.
  v_fecha_plan := public.resolver_fecha_plan_actual(p_user_id);

  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
  values (p_user_id, v_aparatos_discipline_id, null, v_fecha_plan);

  -- Espejo en socios.fecha_vencimiento -- mismo criterio de conversión de
  -- huso horario que ya usa admin_quitar_disciplina_socio() para lo mismo.
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    update socios
    set fecha_vencimiento = (v_fecha_plan at time zone 'America/Argentina/Mendoza')::date
    where dni = v_dni;
  end if;
end;
$$;

grant execute on function public.admin_agregar_aparatos_socio(uuid) to authenticated;

-- ============================================================
-- VERIFICACIÓN -- correr a mano con un socio de PRUEBA.
-- ============================================================

-- ── CASO 1: socio sin Aparatos y sin nada más activo -- now()+30 días. ───
-- select admin_agregar_aparatos_socio('<USER_ID_SIN_NADA>');
-- select expires_at from user_credits
-- where user_id = '<USER_ID_SIN_NADA>' and discipline_id = (select id from disciplines where kind = 'membership' limit 1)
-- order by created_at desc limit 1;
-- -- esperado: expires_at ≈ now()+30 días.
-- select fecha_vencimiento from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: la misma fecha (día calendario Argentina).

-- ── CASO 2: socio con CrossFit vigente (vence en 20 días) -- Aparatos
-- nuevo queda con la MISMA fecha que CrossFit, no now()+30. ──────────────
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_CROSSFIT>', 8, now() + interval '20 days');
-- select admin_agregar_aparatos_socio('<USER_ID_PRUEBA>');
-- select d.name, uc.expires_at from user_credits uc join disciplines d on d.id = uc.discipline_id
-- where uc.user_id = '<USER_ID_PRUEBA>' and uc.expires_at > now() order by d.name;
-- -- esperado: CrossFit y Aparatos con la MISMA fecha (+20 días).

-- ── CASO 3: socio que YA tiene Aparatos vigente -- rechaza. ──────────────
-- select admin_agregar_aparatos_socio('<USER_ID_CON_APARATOS_VIGENTE>');
-- -- esperado: excepción "El socio ya tiene Aparatos vigente -- no hay nada que agregar.".

-- ── CASO 4 (regresión real del ticket): sacar Aparatos con
-- admin_quitar_disciplina_socio() y volver a agregarlo con este RPC. ─────
-- select admin_quitar_disciplina_socio('<USER_ID_PRUEBA>', (select id from disciplines where kind = 'membership' limit 1));
-- select admin_agregar_aparatos_socio('<USER_ID_PRUEBA>');
-- -- esperado: la segunda llamada funciona sin error (la primera dejó
-- -- expires_at en el pasado, "v_ya_vigente" da false) y Aparatos queda
-- -- vigente de nuevo con la fecha del plan actual del socio.
