-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- Decisión de negocio confirmada: "Clases del mes" en el perfil del socio
-- (PWA) tiene que contar desde el último corte/renovación del socio
-- (socios.dia_corte), no desde el 1° del mes calendario -- mismo eje que
-- ya usa el resto del sistema para vencimiento/cobro. Ver greenfit-app/
-- src/lib/xpApi.ts (fetchClasesDelMes/calcularInicioCicloDeCorte).
--
-- Problema real: `dia_corte` vive en `socios`, una tabla que el propio
-- socio logueado en la PWA NO puede leer -- su policy es
-- `socios_admin_all: for all to authenticated using (is_admin())`
-- (supabase_migration_admin_auth_rls.sql). Sin este RPC, la PWA no tiene
-- ninguna forma de saber el dia_corte del socio logueado.
--
-- Mismo patrón exacto que disciplinas_del_plan_actual()/sync_my_membership()
-- (supabase_migration_single_source_of_truth.sql /
-- supabase_migration_domicilio_y_sync_telefono.sql): security definer,
-- resuelve auth.uid() -> profiles.dni -> socios, y devuelve ÚNICAMENTE el
-- dato del propio socio logueado -- nunca expone `socios` entera ni deja
-- pedir el dia_corte de otro. Fail-open (`vinculado=false`) si el socio no
-- tiene DNI cargado en su profile o no hay ninguna ficha en `socios` con
-- ese DNI -- el cliente cae al 1° del mes calendario en ese caso, mismo
-- comportamiento de siempre, en vez de romper la pantalla.
create or replace function public.mi_dia_corte()
returns table (vinculado boolean, dia_corte int)
language plpgsql
security definer
stable
as $$
declare
  v_user_id uuid := auth.uid();
  v_dni text;
  v_dia_corte int;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  select p.dni into v_dni from profiles p where p.id = v_user_id;
  if v_dni is null then
    return query select false, null::int;
    return;
  end if;

  select s.dia_corte into v_dia_corte from socios s where s.dni = v_dni limit 1;
  if v_dia_corte is null then
    -- DNI cargado pero sin ficha en `socios`, o ficha sin dia_corte
    -- cargado todavía (socio nuevo sin ningún ciclo de vencimiento
    -- calculado aún) -- se deja sin resolver en vez de inventar un día.
    return query select false, null::int;
    return;
  end if;

  return query select true, v_dia_corte;
end;
$$;

grant execute on function public.mi_dia_corte() to authenticated;

-- ── Verificación rápida (opcional, después de correr lo de arriba) ─────────
-- Logueado como un socio real en la PWA (o "Run as" con su JWT en el SQL
-- Editor):
--   select * from mi_dia_corte();
-- Tiene que devolver (true, <día real de socios.dia_corte para ese DNI>).
-- Comparar contra el dato real en el panel Admin:
--   select dni, dia_corte from socios where dni = '<DNI del socio de prueba>';
