-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- Cambia el email y la contraseña de la cuenta admin ACTIVA HOY
-- (admin@greenfit.fit) a greenseba26@gmail.com / greenseba26, directo por
-- SQL -- NO usa supabase.auth.updateUser() del lado del cliente, así que
-- NO dispara el flujo normal de "confirmá el cambio de email por correo"
-- de Supabase Auth (ese flujo solo se activa cuando el cambio pasa por el
-- SDK/API pública; una escritura directa en auth.users con el rol de
-- Postgres del SQL Editor lo bypasea por completo). Login nuevo funciona
-- INMEDIATO apenas corra esto, sin ningún paso intermedio pendiente.
--
-- Corrección respecto de un intento anterior: ese script ubicaba la
-- cuenta por `profiles.role = 'admin'`, pero ahora se confirmó que hay
-- MÁS DE UNA cuenta con ese rol (seba@gmail.com también es admin) -- con
-- ese criterio se podía terminar pisando la cuenta equivocada. Este
-- script ubica la cuenta por su EMAIL ACTUAL exacto (admin@greenfit.fit)
-- en auth.users, no por rol -- así que seba@gmail.com queda 100% afuera
-- sin importar cuántas cuentas admin existan.
--
-- Verificado (ver sesión anterior): is_admin() y requireAdmin() (Edge
-- Functions) resuelven todo por user_id/auth.uid(), nunca por email --
-- cambiar el email no rompe ningún permiso de RLS.

create extension if not exists pgcrypto;

do $$
declare
  v_admin_id uuid;
  v_email_count int;
begin
  select count(*) into v_email_count from auth.users where email = 'admin@greenfit.fit';
  if v_email_count <> 1 then
    raise exception 'Se esperaba exactamente 1 cuenta con email admin@greenfit.fit en auth.users, se encontraron % -- revisá a mano antes de correr esto: select id, email from auth.users where email = ''admin@greenfit.fit'';', v_email_count;
  end if;

  select id into v_admin_id from auth.users where email = 'admin@greenfit.fit';

  update auth.users
  set
    email = 'greenseba26@gmail.com',
    encrypted_password = crypt('greenseba26', gen_salt('bf')),
    email_confirmed_at = coalesce(email_confirmed_at, now()), -- ya confirmada, sin pedir nada de nuevo
    updated_at = now()
  where id = v_admin_id;

  update profiles
  set email = 'greenseba26@gmail.com'
  where id = v_admin_id;

  raise notice 'Cuenta admin@greenfit.fit actualizada -- id: %, email nuevo: greenseba26@gmail.com. seba@gmail.com no fue tocada.', v_admin_id;
end $$;

-- ── Verificación (correr después, confirma que quedó todo consistente) ──
-- select id, email, email_confirmed_at from auth.users where email = 'greenseba26@gmail.com';
-- select id, email, role from profiles where email = 'greenseba26@gmail.com';
-- Los dos SELECT tienen que devolver 1 fila con el mismo id.
-- Chequeo extra recomendado -- confirma que seba@gmail.com sigue intacta:
-- select id, email from auth.users where email = 'seba@gmail.com';
