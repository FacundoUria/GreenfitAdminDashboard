-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- ETAPA 4, PARTE A -- el gate de Aparatos mira la fila REAL de user_credits.
--
-- BUG: esta_habilitado_para_disciplina() resolvía Aparatos (kind='membership')
-- con `socios.fecha_vencimiento >= hoy` + `socios.activo`. Pero esa columna no
-- es "la fecha de Aparatos": según por dónde entró el último cambio, a veces
-- tiene la fecha del plan de CRÉDITOS (cobro desde el panel, "editar fecha del
-- plan", alta). Un socio de solo créditos con esa fecha futura tenía el gate de
-- Aparatos ABIERTO sin tener Aparatos (14 socios al 2026-10-01, ninguno con uso
-- real en 60 días).
--
-- FIX: Aparatos = "existe una fila de esa disciplina en user_credits con
-- expires_at > now()" -- el mismo criterio que ya usa la rama de créditos (lotes
-- reales) y el que ya usa el Admin para mostrar "Aparatos" en la tabla de Socios.
-- Se MANTIENE la condición de "socio no dado de baja" (socios.activo): una baja
-- corta Aparatos al instante aunque la fila tenga fecha futura.
--
-- socios.fecha_vencimiento deja de leerse acá. No se toca ningún dato, ni
-- ninguna otra función: book_class(), admin_book_class(),
-- admin_otorgar_checkin_aparatos() y award_xp_asistencia() siguen llamando a
-- esta función igual que antes.
--
-- Rama de créditos: copia textual de supabase_migration_lotes_creditos_fase2.sql.
--
-- Efecto medido antes de aplicar (2026-10-01): 14 socios pierden el acceso que
-- tenían solo por la columna; 0 socios lo ganan.
--
-- Para volver atrás: correr de nuevo el PASO 1 de
-- supabase_migration_lotes_creditos_fase2.sql.
-- Probar con prueba_gate_aparatos_fila_real.sql.

create or replace function public.esta_habilitado_para_disciplina(p_user_id uuid, p_discipline_id uuid)
returns boolean
language plpgsql
security definer
stable
as $$
declare
  v_kind text;
  v_activo boolean;
begin
  select kind into v_kind from disciplines where id = p_discipline_id;
  if v_kind is null then
    return false;
  end if;

  if v_kind = 'membership' then
    -- Dado de baja (o sin ficha en `socios`): no entra, tenga lo que tenga
    -- en user_credits. SIN CAMBIOS respecto de antes.
    select s.activo into v_activo
    from public.profiles p
    join public.socios s on s.dni = p.dni
    where p.id = p_user_id
    limit 1;

    if not coalesce(v_activo, false) then
      return false;
    end if;

    -- NUEVO -- la fila real de Aparatos, ya no socios.fecha_vencimiento.
    return exists (
      select 1 from public.user_credits
      where user_id = p_user_id and discipline_id = p_discipline_id
        and expires_at > now()
    );
  end if;

  if v_kind = 'credits' then
    -- SIN CAMBIOS -- alcanza con que UN lote esté vigente con saldo.
    return exists (
      select 1 from public.user_credits
      where user_id = p_user_id and discipline_id = p_discipline_id
        and remaining_credits > 0
        and expires_at > now()
    );
  end if;

  return false;
end;
$$;

grant execute on function public.esta_habilitado_para_disciplina(uuid, uuid) to authenticated;
