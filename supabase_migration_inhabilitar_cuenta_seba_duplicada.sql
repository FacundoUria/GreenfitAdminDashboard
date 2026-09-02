-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- Fase C1 (resuelta como inhabilitación, no borrado): la cuenta admin
-- duplicada seba@gmail.com (id 6b1104aa-a8f5-456b-9575-2720b1deffe3) NO se
-- borra -- el análisis estructural de FKs (ver diagnostico_seba_duplicado.sql)
-- encontró 4 columnas (credit_transactions.created_by, notifications.sender_id,
-- xp_events.created_by, pagos_socio.created_by) sin ON DELETE CASCADE/SET
-- NULL -- un DELETE real puede fallar duro con una violación de foreign key,
-- o si esas están limpias, el resto de las tablas SÍ tienen cascade y un
-- DELETE podría arrastrar filas reales sin aviso. Inhabilitar (dejar la fila
-- intacta, pero inutilizable para loguear) evita los dos riesgos por
-- completo: nada se borra, ninguna FK se toca, cero chance de cascada.
--
-- Qué hace:
--   1) Verifica que el id corresponde EXACTO a seba@gmail.com antes de
--      tocar nada -- frena con excepción si no coincide (mismo criterio
--      defensivo que supabase_migration_cambiar_credenciales_admin.sql).
--   2) Le cambia el email a un valor no resoluble (dominio .local, no es
--      un email real entregable) y la contraseña a un valor aleatorio de
--      32 bytes generado con pgcrypto -- se genera y se hashea en la
--      misma expresión, el texto plano NUNCA se guarda en ninguna
--      variable que se imprima ni quede en logs.
--   3) Le saca el rol admin en profiles -- 'role' tiene un CHECK
--      constraint que solo permite 'socio' o 'admin' (no NULL, no
--      cualquier string), así que el único valor coherente para "ya no
--      es admin" es 'socio'. No afecta nada real: sin email/password
--      válidos, no hay forma de loguear con esta cuenta de ningún modo,
--      esto es una segunda capa de seguridad, no la primera.
--
-- NO toca admin@greenfit.fit / greenseba26@gmail.com, ni ninguna otra
-- tabla -- exclusivamente auth.users y profiles, y exclusivamente la fila
-- de este id puntual.

create extension if not exists pgcrypto;

do $$
declare
  v_id uuid := '6b1104aa-a8f5-456b-9575-2720b1deffe3';
  v_email_actual text;
begin
  select email into v_email_actual from auth.users where id = v_id;
  if v_email_actual is null then
    raise exception 'No existe ninguna cuenta en auth.users con id % -- no hay nada que inhabilitar.', v_id;
  end if;
  if v_email_actual <> 'seba@gmail.com' then
    raise exception 'El id % no corresponde a seba@gmail.com -- corresponde a "%". Revisá a mano antes de correr esto, no se tocó nada.', v_id, v_email_actual;
  end if;

  update auth.users
  set
    email = 'cuenta-inhabilitada-seba@invalido.greenfit.local',
    -- Contraseña aleatoria real (32 bytes de pgcrypto, no un valor fijo) --
    -- se genera y se hashea en la misma expresión, no queda guardada en
    -- ningún lado en texto plano.
    encrypted_password = crypt(encode(gen_random_bytes(32), 'hex'), gen_salt('bf')),
    -- Ya no hay nadie que pueda confirmar este email inválido -- lo deja
    -- explícitamente sin confirmar, una señal más de que no es una cuenta
    -- usable.
    email_confirmed_at = null,
    updated_at = now()
  where id = v_id;

  update profiles
  set
    email = 'cuenta-inhabilitada-seba@invalido.greenfit.local',
    role = 'socio'
  where id = v_id;

  raise notice 'Cuenta % (id %) inhabilitada -- email inválido, password aleatoria descartada, role ya no es admin. admin@greenfit.fit / greenseba26@gmail.com no fue tocada.', v_email_actual, v_id;
end $$;

-- ── Verificación (correr después, confirma que quedó todo consistente) ─────
--
-- 1) Confirmar que el email y el rol cambiaron:
-- select id, email, email_confirmed_at from auth.users where id = '6b1104aa-a8f5-456b-9575-2720b1deffe3';
-- select id, email, role from profiles where id = '6b1104aa-a8f5-456b-9575-2720b1deffe3';
-- Los dos tienen que mostrar 'cuenta-inhabilitada-seba@invalido.greenfit.local';
-- profiles.role tiene que ser 'socio'.
--
-- 2) SQL no puede "simular un login" (eso es una llamada a la API de Auth,
--    no una query de base) -- lo más cercano que se puede confirmar acá es
--    que el email VIEJO ya no existe como credencial válida en absoluto:
-- select count(*) from auth.users where email = 'seba@gmail.com';
-- Tiene que dar 0 -- ya no hay ninguna cuenta con ese email para intentar
-- loguearse. La confirmación real y completa es manual: probar loguearte
-- en el Dashboard Admin con seba@gmail.com y la contraseña vieja -- tiene
-- que rechazar el login (usuario no encontrado). También confirmar que
-- admin@greenfit.fit / greenseba26 / greenseba26 sigue entrando normal.
