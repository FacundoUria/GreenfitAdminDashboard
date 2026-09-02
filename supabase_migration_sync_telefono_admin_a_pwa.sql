-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- Sentido inverso de supabase_migration_domicilio_y_sync_telefono.sql: esa
-- migración ya sincroniza PWA -> Admin (el socio edita su teléfono en "Mis
-- datos" y `socios.telefono` se actualiza vía sincronizar_telefono_a_socio()).
-- Hasta ahora NO existía el sentido contrario -- si Seba corregía el
-- teléfono de un socio desde el panel, `profiles.phone` (lo que el socio ve
-- en su propio perfil de la PWA) se quedaba con el valor viejo para
-- siempre, sin ningún aviso de que quedó desincronizado.
--
-- Mismo puente de siempre: profiles.dni = socios.dni (ver
-- sync_my_membership/disciplinas_del_plan_actual/
-- sincronizar_telefono_a_socio). El caller es el ADMIN (no el propio
-- socio), así que a diferencia de esas funciones -- que resuelven todo
-- por auth.uid() del que llama -- esta recibe el DNI explícito del socio
-- que se está editando en el panel.
--
-- security definer + chequeo explícito de is_admin() adentro: aunque hoy
-- profiles_update_own_or_admin ya deja pasar un UPDATE directo de un admin
-- autenticado, se mantiene el mismo patrón defensivo que ya usan
-- admin_book_class/admin_cancel_booking (nunca confiar solo en la policy,
-- reforzar el chequeo adentro de la función).
create or replace function public.sincronizar_telefono_a_profile(p_dni text, p_telefono text)
returns void
language plpgsql
security definer
as $$
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  if p_dni is null then
    return;
  end if;

  -- Fail-open (mismo criterio que el resto del puente por DNI): si el
  -- socio todavía no tiene cuenta de PWA vinculada a ese DNI, el UPDATE
  -- no encuentra ninguna fila -- no es un error, simplemente no hay nada
  -- que sincronizar todavía.
  update public.profiles
  set phone = p_telefono
  where dni = p_dni;
end;
$$;

grant execute on function public.sincronizar_telefono_a_profile(text, text) to authenticated;

-- ── Verificación rápida (opcional, después de correr lo de arriba) ─────────
-- select p.dni, p.phone as phone_pwa, s.telefono as telefono_admin
--   from profiles p join socios s on s.dni = p.dni
--   where p.dni = 'DNI_DE_PRUEBA';
-- Editá el teléfono de ese socio desde el panel y guardá -- los dos
-- valores tienen que quedar iguales después.
