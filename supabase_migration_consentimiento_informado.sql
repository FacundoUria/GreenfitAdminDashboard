-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- Consentimiento informado / declaración de salud -- segundo gate de
-- reserva, coexiste con el de contacto de emergencia (AgendaMobileView.tsx)
-- sin tocarlo. Ver greenfit-app/src/lib/consentApi.ts para el texto legal
-- exacto y CONSENT_VERSION (constante en código, no en la base -- el
-- mecanismo de "el texto cambió" es subir esa constante a 'v2': cualquier
-- socio que solo tenga aceptado 'v1' vuelve a ver la pantalla completa la
-- próxima vez que reserve, sin migración de datos).
--
-- ============================================================
-- PASO 1 -- Tabla consentimientos_socio
-- ============================================================
-- nombre_declarado/dni_declarado son un SNAPSHOT del perfil al momento de
-- aceptar (no una referencia a profiles) -- a propósito: si el socio edita
-- después su nombre en "Mis datos", el registro legal de esta aceptación
-- puntual no tiene que cambiar retroactivamente.

create table if not exists public.consentimientos_socio (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  version text not null,
  nombre_declarado text not null,
  dni_declarado text not null,
  fecha_aceptacion timestamptz not null default now()
);

-- Una consulta por (user_id, version) en cada intento de reserva
-- (fetchTieneConsentimientoVigente) -- índice para que sea barata.
create index if not exists consentimientos_socio_user_version_idx
  on public.consentimientos_socio (user_id, version);

alter table public.consentimientos_socio enable row level security;

-- INSERT: el propio socio activo, solo puede insertar a su propio nombre
-- (mismo patrón is_active_socio() que ya usan avatars/community-media/
-- comprobantes-pago).
drop policy if exists "consentimientos_insert_own" on public.consentimientos_socio;
create policy "consentimientos_insert_own" on public.consentimientos_socio
  for insert with check (
    public.is_active_socio() and user_id = auth.uid()
  );

-- SELECT: el propio dueño, o admin -- mismo patrón que
-- comprobantes_select_own_or_admin (supabase_migration_transferencia_
-- comprobante_fase1.sql).
drop policy if exists "consentimientos_select_own_or_admin" on public.consentimientos_socio;
create policy "consentimientos_select_own_or_admin" on public.consentimientos_socio
  for select using (
    user_id = auth.uid() or public.is_admin()
  );

-- Sin UPDATE ni DELETE a propósito (pedido explícito -- un consentimiento
-- aceptado es un registro histórico, no se edita ni se borra; si el texto
-- cambia, se sube CONSENT_VERSION en código y se pide una fila nueva).

-- ============================================================
-- Verificación (opcional, correr a mano después de aplicar lo de arriba)
-- ============================================================
-- 1) Confirmar la tabla y el índice:
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_name = 'consentimientos_socio' order by ordinal_position;
-- select indexname from pg_indexes where tablename = 'consentimientos_socio';

-- 2) Confirmar RLS activo y las 2 policies (sin update/delete):
-- select polname, polcmd from pg_policy
--   where polrelid = 'public.consentimientos_socio'::regclass;

-- 3) Logueado como un socio real de prueba (o "Run as" con su JWT), insertar
--    su propia aceptación y confirmar que puede verla:
-- insert into consentimientos_socio (user_id, version, nombre_declarado, dni_declarado)
-- values (auth.uid(), 'v1', 'Nombre de prueba', '12345678');
-- select * from consentimientos_socio where user_id = auth.uid();

-- 4) Confirmar que ese mismo socio NO puede editar ni borrar (tienen que
--    fallar con "new row violates row-level security" / 0 filas afectadas):
-- update consentimientos_socio set version = 'v2' where user_id = auth.uid();
-- delete from consentimientos_socio where user_id = auth.uid();

-- 5) Logueado como OTRO socio de prueba, confirmar que NO ve la fila del
--    socio del paso 3 (select vacío) y que insertar con un user_id ajeno
--    falla:
-- insert into consentimientos_socio (user_id, version, nombre_declarado, dni_declarado)
-- values ('<ID DEL SOCIO DEL PASO 3>', 'v1', 'x', 'x'); -- tiene que fallar

-- 6) Logueado como admin, confirmar que ve las filas de ambos socios de
--    prueba (select * from consentimientos_socio devuelve las 2).
