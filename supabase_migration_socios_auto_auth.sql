-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- Contexto: `socios` (esta app) y `profiles`/auth.users (greenfit-app, la PWA)
-- son dos tablas independientes. Hoy, cargar o editar el DNI de un socio acá
-- NO crea su cuenta de login en la PWA -- por eso el DNI 40123456 (y el resto
-- de los 970 socios históricos) no podían entrar. Ya se corrió un backfill
-- one-off para los 221 que tenían DNI en ese momento; este trigger es lo que
-- hace que, de ahora en más, cargar o corregir un DNI desde este panel
-- provisione la cuenta automáticamente, sin depender de correr un script a mano.
--
-- Por qué un trigger de base y no llamar a la Edge Function admin-create-socio
-- desde el frontend: ese endpoint exige un JWT de un usuario con
-- profiles.role = 'admin' (ver supabase/functions/_shared/adminGuard.ts en el
-- repo de la app). El login de ESTE panel (AuthContext.jsx) hoy es un check
-- de usuario/clave hardcodeado en el cliente -- nunca abre una sesión real de
-- Supabase Auth, así que no tiene ningún JWT para mandarle a esa función.
-- Arreglar el login del panel para que use Supabase Auth de verdad es un
-- cambio más grande y aparte; mientras tanto, el trigger resuelve el
-- problema puntual llamando directo a la Auth Admin API con la Service Role
-- key (que sí tiene permiso), sin importar qué cliente hizo el INSERT/UPDATE.
--
-- Antes de correr: reemplazá <SERVICE_ROLE_KEY> por la Service Role key real
-- (Project Settings > API > service_role) en la línea de vault.create_secret.
-- Es información sensible -- después de correrla una vez, borrá esa línea del
-- historial de tu editor si quedó pegada en algún lado.

create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key') then
    perform vault.create_secret(
      '<SERVICE_ROLE_KEY>',
      'service_role_key',
      'Service role key para crear auth.users desde el trigger de socios.dni'
    );
  end if;
end $$;

create or replace function public.handle_socio_dni_upsert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_key text;
  v_project_url text := 'https://pgigyscgsrowlfddfnbj.supabase.co';
  v_full_name text;
begin
  -- Sin DNI válido no hay nada que provisionar (mismo criterio que
  -- isValidDni() en la app: 6 a 10 dígitos).
  if NEW.dni is null or NEW.dni !~ '^\d{6,10}$' then
    return NEW;
  end if;

  -- En UPDATE, solo dispara si el DNI realmente cambió (evita recrear la
  -- cuenta en cada edición de teléfono/plan/etc. que no toque el DNI).
  if TG_OP = 'UPDATE' and OLD.dni is not distinct from NEW.dni then
    return NEW;
  end if;

  select decrypted_secret into v_service_key
  from vault.decrypted_secrets
  where name = 'service_role_key';

  if v_service_key is null then
    raise warning 'handle_socio_dni_upsert: falta el secret service_role_key en Vault, no se creó la cuenta de Auth para el socio %.', NEW.id;
    return NEW;
  end if;

  v_full_name := trim(coalesce(NEW.nombre, '') || ' ' || coalesce(NEW.apellido, ''));
  if v_full_name = '' then
    v_full_name := 'Socio sin nombre';
  end if;

  -- Llamada async (pg_net no bloquea el INSERT/UPDATE de socios esperando la
  -- respuesta). Si el email ya existe (auth.users ya creada antes, ej. por el
  -- backfill), la Auth Admin API responde 422/"already registered" y no pasa
  -- nada -- no se duplica ni se rompe el guardado del socio.
  perform net.http_post(
    url := v_project_url || '/auth/v1/admin/users',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_service_key,
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := jsonb_build_object(
      'email', NEW.dni || '@greenfit.com',
      'password', NEW.dni,
      'email_confirm', true,
      'user_metadata', jsonb_build_object(
        'full_name', v_full_name,
        'dni', NEW.dni,
        'phone', NEW.telefono
      )
    )
  );

  return NEW;
end;
$$;

drop trigger if exists on_socio_dni_upsert on public.socios;
create trigger on_socio_dni_upsert
  after insert or update of dni on public.socios
  for each row execute function public.handle_socio_dni_upsert();

-- Verificación rápida después de correr esto: cargale un DNI de prueba a un
-- socio desde el panel (o UPDATE socios SET dni = '99999999' WHERE id = ...)
-- y confirmá que aparezca la cuenta:
--   select id, email, created_at from auth.users where email = '99999999@greenfit.com';
-- Si pg_net tarda en procesar la cola, podés revisar el resultado de la
-- llamada HTTP en: select * from net._http_response order by created desc limit 5;
