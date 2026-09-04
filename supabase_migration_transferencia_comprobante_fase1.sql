-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA. Fase 1 -- solo cimientos (storage + columnas +
-- funciones). NADA de esto se conecta a ninguna pantalla en este cambio.
-- El flujo de Mercado Pago sigue funcionando en paralelo, intacto --
-- mp_process_payment NO se toca en ningún punto de este archivo.
--
-- ============================================================
-- INVESTIGACIÓN PREVIA (antes de asumir que "insertar en notifications"
-- alcanza para que el socio se entere):
-- ============================================================
-- Confirmado que SÍ hay una pantalla real donde el socio ve sus
-- notificaciones, no es una tabla que se use para otra cosa:
--   - greenfit-app/src/screens/user/NotificationsScreen.tsx: lee
--     directo de `notifications` (select id, title, body, created_at),
--     confía en que la policy notifications_select_recipient (RLS) ya le
--     filtra solo lo suyo -- entre otras cosas, cualquier fila con
--     audience_type='user' y target_user_id = su propio id.
--   - Hay campana con contador de no leídas en el header de Inicio
--     (notificationsBadge.ts) y una suscripción en vivo
--     (useNotificationSubscription.ts) -- una notificación nueva se
--     refleja sin que el socio tenga que hacer nada.
-- Conclusión: insertar en `notifications` con audience_type='user' y
-- target_user_id = el socio SÍ alcanza para que se entere -- es el mismo
-- mecanismo real que ya usa el resto del sistema, no hace falta
-- inventar nada nuevo.

-- ============================================================
-- PASO 1 -- Storage: bucket privado para comprobantes de pago
-- ============================================================
-- A diferencia de avatars/community-media (públicos, son fotos de perfil
-- y de un feed social) esto son comprobantes bancarios -- PRIVADO.

insert into storage.buckets (id, name, public)
values ('comprobantes-pago', 'comprobantes-pago', false)
on conflict (id) do nothing;

-- INSERT: el socio activo solo puede subir dentro de SU carpeta
-- <user_id>/... -- mismo patrón storage.foldername(name) que ya usan
-- avatars/community-media, incluido el mismo chequeo is_active_socio()
-- (role='socio' and active=true, supabase_migration_comunidad.sql) --
-- esto significa que HOY el propio admin no puede subir un comprobante
-- en nombre de un socio con esta policy tal cual (is_active_socio()
-- exige role='socio'); si más adelante hace falta ese caso (Seba carga
-- un comprobante en papel), es un policy aparte, no se agrega acá sin
-- que se pida.
drop policy if exists "comprobantes_insert_own" on storage.objects;
create policy "comprobantes_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'comprobantes-pago'
    and public.is_active_socio()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- SELECT: SOLO el propio dueño del archivo, o admin -- nadie más (a
-- diferencia de avatars/community-media, que son de lectura pública).
drop policy if exists "comprobantes_select_own_or_admin" on storage.objects;
create policy "comprobantes_select_own_or_admin" on storage.objects
  for select using (
    bucket_id = 'comprobantes-pago'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- Sin UPDATE ni DELETE a propósito (pedido explícito -- un comprobante no
-- se edita; si se sube mal, se sube uno nuevo).

-- ============================================================
-- PASO 2 -- pagos_socio: columnas nuevas + valor nuevo de origen
-- ============================================================
-- Se extiende pagos_socio en vez de crear una tabla nueva -- ya tiene
-- todo lo demás que hace falta (user_id, paquete, monto, estado con
-- 'pendiente' YA disponible en su CHECK, created_by/created_at).

alter table public.pagos_socio
  add column if not exists comprobante_url text,
  add column if not exists pack_id uuid references packs(id),
  add column if not exists reviewed_by uuid references profiles(id),
  add column if not exists reviewed_at timestamptz;

-- El CHECK de `origen` es una constraint con nombre autogenerado por
-- Postgres al momento de crear la tabla -- no se puede "agregar un valor"
-- a un CHECK existente, hay que dropearlo y recrearlo con la lista
-- completa (valores viejos + el nuevo). Se busca el nombre real en vez de
-- asumirlo, para que esto sea seguro sin importar cómo se haya llamado.
do $$
declare
  v_constraint_name text;
begin
  select con.conname into v_constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'pagos_socio'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%origen%';

  if v_constraint_name is not null then
    execute format('alter table public.pagos_socio drop constraint %I', v_constraint_name);
  end if;

  -- Por si esta migración ya se corrió parcialmente antes (el nombre
  -- nuevo de abajo, puntual) -- así correr el script de nuevo no falla
  -- con "la constraint ya existe".
  alter table public.pagos_socio drop constraint if exists pagos_socio_origen_check;

  alter table public.pagos_socio
    add constraint pagos_socio_origen_check
    check (origen in ('manual', 'mercado_pago', 'transferencia_comprobante'));
end $$;

-- ── Verificación (opcional) ─────────────────────────────────────────────
-- select column_name from information_schema.columns
--   where table_name = 'pagos_socio' and column_name in
--   ('comprobante_url', 'pack_id', 'reviewed_by', 'reviewed_at');
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.pagos_socio'::regclass and contype = 'c';

-- ============================================================
-- PASO 3 -- Funciones de aprobación/rechazo manual
-- ============================================================
-- admin_aprobar_comprobante(): reusa el MISMO loop de acreditación por
-- disciplina que ya usa mp_process_payment (backend/supabase_migration_
-- planes_combos.sql, re-extendida en supabase_migration_mp_sync_socios.sql)
-- -- deliberadamente DUPLICADO acá, no extraído a un helper compartido: el
-- pedido explícito de esta fase es no tocar mp_process_payment para nada
-- (sigue funcionando en paralelo con Mercado Pago), y cualquier refactor a
-- un helper común hubiera significado tocarla igual.
--
-- Idempotencia: NO hay ningún payment_id externo acá (a diferencia de MP) --
-- se ancla en reviewed_at de la propia fila de pagos_socio, con un
-- `for update` que la bloquea antes de leerla, para que dos aprobaciones
-- casi simultáneas del mismo comprobante (doble click del admin) no
-- acrediten dos veces.
create or replace function public.admin_aprobar_comprobante(p_pagos_socio_id uuid)
returns table (credito_otorgado boolean)
language plpgsql
security definer
as $$
declare
  v_row public.pagos_socio%rowtype;
  v_creditos jsonb;
  v_incluye_aparatos boolean;
  v_dias_vigencia int;
  v_aparatos_discipline_id uuid;
  v_credito jsonb;
  v_discipline_id uuid;
  v_credits int;
  v_total_creditos int := 0;
  v_dni text;
  v_nueva_fecha_vencimiento timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select * into v_row from public.pagos_socio where id = p_pagos_socio_id for update;
  if not found then
    raise exception 'No existe ningún comprobante con id %.', p_pagos_socio_id;
  end if;

  -- Ya se revisó antes (aprobado o rechazado) -- no vuelve a acreditar.
  if v_row.reviewed_at is not null then
    return query select false;
    return;
  end if;

  if v_row.pack_id is null then
    raise exception 'Este comprobante no tiene pack_id asociado -- no se puede saber qué acreditar.';
  end if;

  select creditos, incluye_aparatos, dias_vigencia
    into v_creditos, v_incluye_aparatos, v_dias_vigencia
  from packs where id = v_row.pack_id;

  if v_incluye_aparatos then
    select id into v_aparatos_discipline_id from disciplines where kind = 'membership' limit 1;
  end if;

  -- Créditos por disciplina (0 a N filas, un combo puede traer varias).
  for v_credito in select * from jsonb_array_elements(coalesce(v_creditos, '[]'::jsonb))
  loop
    v_discipline_id := (v_credito->>'discipline_id')::uuid;
    v_credits := (v_credito->>'credits')::int;
    if v_discipline_id is not null and v_credits is not null and v_credits > 0 then
      insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
      select
        v_row.user_id, v_row.pack_id, v_discipline_id,
        coalesce(
          (select remaining_credits from user_credits
           where user_id = v_row.user_id and discipline_id = v_discipline_id
           order by created_at desc limit 1),
          0
        ) + v_credits,
        now() + interval '30 days';

      v_total_creditos := v_total_creditos + v_credits;
    end if;
  end loop;

  -- Extensión de Aparatos, si el pack la incluye.
  if v_incluye_aparatos and v_aparatos_discipline_id is not null and v_dias_vigencia is not null and v_dias_vigencia > 0 then
    v_nueva_fecha_vencimiento := greatest(
      coalesce(
        (select expires_at from user_credits
         where user_id = v_row.user_id and discipline_id = v_aparatos_discipline_id
         order by created_at desc limit 1),
        now()
      ),
      now()
    ) + (v_dias_vigencia || ' days')::interval;

    insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
    values (v_row.user_id, v_row.pack_id, v_aparatos_discipline_id, null, v_nueva_fecha_vencimiento);
  end if;

  -- Espejo en socios (mismo puente por DNI y mismo criterio que
  -- mp_process_payment: creditos se SUMA, fecha_vencimiento se PISA con
  -- la fecha real recién calculada, convertida a día calendario de
  -- Argentina).
  select dni into v_dni from profiles where id = v_row.user_id;
  if v_dni is not null then
    update socios
    set creditos = coalesce(creditos, 0) + v_total_creditos,
        fecha_vencimiento = coalesce(
          (v_nueva_fecha_vencimiento at time zone 'America/Argentina/Mendoza')::date,
          fecha_vencimiento
        )
    where dni = v_dni;
  end if;

  update public.pagos_socio
  set estado = 'pagado',
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = p_pagos_socio_id;

  -- Notificación real al socio -- mismo mecanismo que ya usa
  -- NotificationsScreen.tsx (audience_type='user' + target_user_id), sin
  -- inventar nada nuevo (ver investigación al principio del archivo).
  insert into notifications (sender_id, audience_type, target_user_id, title, body)
  values (
    auth.uid(),
    'user',
    v_row.user_id,
    '¡Tu comprobante fue aprobado!',
    'Ya acreditamos tu pago -- revisá tu saldo actualizado en Inicio.'
  );

  return query select true;
end;
$$;

grant execute on function public.admin_aprobar_comprobante(uuid) to authenticated;

-- admin_rechazar_comprobante(): NO acredita nada, NO notifica -- 'anulado'
-- ya es un valor válido del CHECK de `estado` hoy (pagado/pendiente/
-- anulado, supabase_migration_ficha360.sql), no hizo falta agregar nada.
create or replace function public.admin_rechazar_comprobante(p_pagos_socio_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_reviewed_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select reviewed_at into v_reviewed_at from public.pagos_socio where id = p_pagos_socio_id for update;
  if not found then
    raise exception 'No existe ningún comprobante con id %.', p_pagos_socio_id;
  end if;

  -- Ya se revisó antes (aprobado o rechazado) -- no lo vuelve a tocar.
  if v_reviewed_at is not null then
    return;
  end if;

  update public.pagos_socio
  set estado = 'anulado',
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = p_pagos_socio_id;
end;
$$;

grant execute on function public.admin_rechazar_comprobante(uuid) to authenticated;

-- ============================================================
-- PASO 4 -- Verificación manual (correr a mano, de a un paso, DESPUÉS de
-- aplicar todo lo de arriba -- nada de esto se corre automáticamente)
-- ============================================================

-- 1) Elegí un socio de prueba real (con cuenta de PWA vinculada) y un pack
--    real que ya exista, y anotá sus ids:
-- select id, dni from profiles where dni = '<DNI DE PRUEBA>';
-- select id, name, creditos, incluye_aparatos, dias_vigencia from packs where is_active = true limit 5;

-- 2) Insertá una fila de prueba en pagos_socio simulando un comprobante
--    recién subido, pendiente de revisión (reemplazá los <...>):
-- insert into pagos_socio (user_id, paquete, monto, metodo_pago, estado, origen, pack_id, comprobante_url)
-- values ('<PROFILE_ID>', '<NOMBRE DEL PACK>', <MONTO>, 'transferencia', 'pendiente', 'transferencia_comprobante', '<PACK_ID>', 'comprobantes-pago/<PROFILE_ID>/prueba.jpg')
-- returning id; -- guardate este id para el paso 3

-- 3) Aprobalo (logueado como admin real, o "Run as" con su JWT):
-- select * from admin_aprobar_comprobante('<ID DE LA FILA DEL PASO 2>');
-- Tiene que devolver credito_otorgado = true.

-- 4) Confirmá que user_credits sumó lo esperado (comparar contra
--    packs.creditos del pack usado) y que la fila quedó marcada:
-- select discipline_id, remaining_credits, expires_at from user_credits
--   where user_id = '<PROFILE_ID>' order by created_at desc limit 5;
-- select estado, reviewed_by, reviewed_at from pagos_socio where id = '<ID DEL PASO 2>';
-- select id, title, body from notifications where target_user_id = '<PROFILE_ID>' order by created_at desc limit 1;

-- 5) Confirmá la idempotencia -- aprobarlo una segunda vez NO tiene que
--    volver a sumar créditos:
-- select * from admin_aprobar_comprobante('<ID DE LA FILA DEL PASO 2>');
-- Tiene que devolver credito_otorgado = false, y user_credits NO cambia de nuevo.

-- 6) Probá el rechazo con una fila de prueba NUEVA (pendiente, sin revisar):
-- select admin_rechazar_comprobante('<ID DE OTRA FILA PENDIENTE>');
-- select estado, reviewed_by, reviewed_at from pagos_socio where id = '<ESE ID>';
-- Tiene que quedar 'anulado' -- y confirmar que NO se insertó ninguna fila
-- nueva en user_credits ni en notifications para ese socio.8
