-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- Pedido del cliente: "Mis datos" (PWA) ahora exige Nombre, Apellido, DNI,
-- Correo, Teléfono, Teléfono de emergencia y Domicilio. De esos 7, el único
-- que no existía en ningún lado era Domicilio -- el resto ya vive en
-- `profiles` (full_name/dni/email/phone/emergency_contact_phone).
--
-- Además: sincronización estricta PWA -> Admin. El panel Admin (tabla
-- `socios`, columna `telefono`) es una ficha SEPARADA de `profiles` --
-- bridgeada únicamente por profiles.dni = socios.dni (mismo criterio que
-- sync_my_membership/disciplinas_del_plan_actual). Si un socio actualiza su
-- Teléfono en la PWA, hasta ahora `socios.telefono` (y por lo tanto el botón
-- de WhatsApp del Admin, que lee ESTRICTAMENTE socio.telefono) se quedaba
-- con el valor viejo para siempre. El RPC de acá abajo corrige eso.

-- 1) profiles.domicilio -----------------------------------------------------
alter table public.profiles
  add column if not exists domicilio text;

-- 2) Sincronización de teléfono PWA -> socios (Admin) -----------------------
-- security definer porque la policy de `socios` es admin-only
-- (socios_admin_all using (public.is_admin())) -- un socio autenticado no
-- puede hacer un UPDATE directo a esa tabla, tiene que pasar por acá.
-- Sin parámetros a propósito (mismo estilo que sync_my_membership): lee
-- profiles.phone del USUARIO AUTENTICADO, no confía en un valor que mande
-- el cliente por si ese valor no es el que realmente quedó guardado.
create or replace function public.sincronizar_telefono_a_socio()
returns void
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_dni text;
  v_phone text;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  select p.dni, p.phone into v_dni, v_phone
  from public.profiles p
  where p.id = v_user_id;

  -- Cuenta sin DNI vinculado a ninguna ficha de socios todavía (mismo caso
  -- fail-open que el resto de este puente) -- no hay a qué fila pegarle el
  -- UPDATE, no es un error, simplemente no hay nada que sincronizar.
  if v_dni is null then
    return;
  end if;

  update public.socios
  set telefono = v_phone
  where dni = v_dni;
end;
$$;

grant execute on function public.sincronizar_telefono_a_socio() to authenticated;

-- ── Verificación rápida (opcional, después de correr lo de arriba) ─────────
-- select column_name from information_schema.columns
--   where table_name = 'profiles' and column_name = 'domicilio';
--
-- select p.dni, p.phone as phone_pwa, s.telefono as telefono_admin
--   from profiles p join socios s on s.dni = p.dni
--   where p.dni = 'DNI_DE_PRUEBA';
