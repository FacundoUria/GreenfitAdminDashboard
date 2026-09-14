-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- CONTEXTO (CAMBIO 3, "editar la fecha del plan"): bajo el modelo de "plan
-- único" (ver acreditar_pack/admin_acreditar_creditos_manual/
-- admin_fijar_creditos_disciplina), un socio con algo activo tiene UNA sola
-- fecha compartida entre TODAS sus disciplinas de créditos vigentes +
-- Aparatos (si está vigente). Hasta ahora, la única forma de mover esa
-- fecha era "Cobrar" (acreditar_pack/admin_acreditar_creditos_manual) --
-- que además resetea cantidades y recalcula todo el plan desde cero. Este
-- RPC es un atajo chico y separado, mismo espíritu que
-- admin_agregar_aparatos_socio/admin_quitar_disciplina_socio: SOLO mueve la
-- fecha, no toca remaining_credits de ninguna disciplina, no agrega ni
-- saca nada.
--
-- ADITIVO A PROPÓSITO -- función nueva, no modifica ninguna existente.
-- acreditar_pack(), admin_acreditar_creditos_manual() y todo el flujo de
-- "Cobrar"/comprobantes quedan sin un solo cambio (ver el test dedicado a
-- confirmar esto en el frontend).
--
-- Guarda -- no reemplaza a "Cobrar": un socio sin ningún plan activo no
-- tiene ninguna fecha que "mover", tiene que dársele un plan nuevo (con
-- cantidades reales) por Cobrar.

create or replace function public.admin_editar_fecha_vencimiento_socio(
  p_user_id uuid,
  p_nueva_fecha date
)
returns int
language plpgsql
security definer
as $$
declare
  v_nueva_fecha_ts timestamptz;
  v_filas_actualizadas int;
  v_dni text;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  if p_nueva_fecha is null then
    raise exception 'p_nueva_fecha no puede ser null.';
  end if;

  -- Medianoche Argentina del día elegido -- mismo criterio de conversión
  -- date -> timestamptz que ya usa admin_acreditar_creditos_manual() para
  -- p_fecha_inicio.
  v_nueva_fecha_ts := (p_nueva_fecha::timestamp at time zone 'America/Argentina/Mendoza');

  -- Guarda -- "¿tiene algo activo hoy?" con el MISMO criterio que
  -- resolver_fecha_plan_actual()/admin_agregar_aparatos_socio: una
  -- disciplina de créditos con saldo Y vigente, o Aparatos vigente.
  if not exists (
    select 1
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id
    where uc.user_id = p_user_id
      and (
        (d.kind = 'credits' and uc.remaining_credits > 0 and uc.expires_at > now())
        or (d.kind = 'membership' and uc.expires_at > now())
      )
  ) then
    raise exception 'Este socio no tiene ningún plan activo -- para asignarle una fecha nueva, hay que usar Cobrar, no editar la fecha.';
  end if;

  -- Mueve la fecha de TODAS las filas activas (mismo criterio del guard de
  -- arriba) -- créditos Y Aparatos por igual, sin tocar remaining_credits
  -- de ninguna.
  update user_credits uc
  set expires_at = v_nueva_fecha_ts
  from disciplines d
  where uc.discipline_id = d.id
    and uc.user_id = p_user_id
    and (
      (d.kind = 'credits' and uc.remaining_credits > 0 and uc.expires_at > now())
      or (d.kind = 'membership' and uc.expires_at > now())
    );
  get diagnostics v_filas_actualizadas = row_count;

  -- Espejo en socios.fecha_vencimiento -- p_nueva_fecha YA es la fecha
  -- calendario elegida por el admin, sin conversión de por medio (a
  -- diferencia de cuando se parte de un timestamptz resuelto, como en
  -- admin_agregar_aparatos_socio).
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    update socios set fecha_vencimiento = p_nueva_fecha where dni = v_dni;
  end if;

  return v_filas_actualizadas;
end;
$$;

grant execute on function public.admin_editar_fecha_vencimiento_socio(uuid, date) to authenticated;

-- ============================================================
-- VERIFICACIÓN -- correr a mano con un socio de PRUEBA.
-- ============================================================

-- ── CASO 1: socio con 2 disciplinas de créditos + Aparatos, las 3 con la
-- MISMA fecha -- editar mueve las 3 al mismo valor nuevo, cantidades
-- intactas. ────────────────────────────────────────────────────────────
-- select uc.discipline_id, d.name, uc.remaining_credits, uc.expires_at
-- from user_credits uc join disciplines d on d.id = uc.discipline_id
-- where uc.user_id = '<USER_ID_PRUEBA>' and uc.expires_at > now()
-- order by d.name;
-- -- anotar remaining_credits de cada una ANTES de seguir.
--
-- select admin_editar_fecha_vencimiento_socio('<USER_ID_PRUEBA>', '2027-01-15');
-- -- esperado: devuelve 3 (si tenía 2 créditos + Aparatos vigentes).
--
-- select uc.discipline_id, d.name, uc.remaining_credits, uc.expires_at
-- from user_credits uc join disciplines d on d.id = uc.discipline_id
-- where uc.user_id = '<USER_ID_PRUEBA>' and uc.expires_at > now()
-- order by d.name;
-- -- esperado: las 3 con expires_at = 2027-01-15 00:00 Argentina, MISMOS
-- -- remaining_credits que antes (ninguno cambió).
--
-- select fecha_vencimiento from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: 2027-01-15.

-- ── CASO 2 (regresión del ticket): socio SIN nada activo -- rechaza. ─────
-- select admin_editar_fecha_vencimiento_socio('<USER_ID_SIN_NADA>', '2027-01-15');
-- -- esperado: excepción "Este socio no tiene ningún plan activo -- para
-- -- asignarle una fecha nueva, hay que usar Cobrar, no editar la fecha.".
-- -- confirmar que NINGUNA fila de user_credits ni socios cambió.

-- ── CASO 3: confirmar que acreditar_pack()/admin_acreditar_creditos_manual()
-- siguen exactamente iguales -- este script no los tocó. ─────────────────
-- select pg_get_functiondef(oid) from pg_proc where proname = 'acreditar_pack';
-- select pg_get_functiondef(oid) from pg_proc where proname = 'admin_acreditar_creditos_manual';
-- -- comparar a mano contra supabase_migration_lotes_creditos_fase1.sql /
-- -- supabase_migration_admin_acreditar_creditos_manual.sql (las versiones
-- -- vigentes más recientes) -- tienen que coincidir, sin ningún cambio.
