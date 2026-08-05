-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor) CUANDO SE
-- QUIERA activar la Ficha 360° del Socio en el Panel Admin.
--
-- Este script toca el MISMO proyecto de Supabase que usa la PWA de socios
-- (greenfit-app) -- profiles/bookings/xp_events/routines ya existen ahí.
-- No se ejecuta automáticamente: es un cambio de schema sobre producción.

-- ============================================================
-- 1) El admin necesita poder LEER el xp_events de CUALQUIER socio (para
--    Nivel/Racha/Historial de asistencias en la Ficha 360°), no solo el
--    propio -- hoy la policy es "cada uno lo suyo" a secas. Mismo criterio
--    que ya tienen bookings_select_own_or_admin / profiles_select_own_or_admin.
-- ============================================================

drop policy if exists "xp_events_select_own" on xp_events;
create policy "xp_events_select_own_or_admin" on xp_events
  for select using (auth.uid() = user_id or public.is_admin());

-- ============================================================
-- 2) Historial de Pagos y Suscripciones (cobros manuales de Seba desde
--    "Registrar Pago", con la estructura lista para la futura
--    automatización con Mercado Pago -- columnas `origen` y
--    `mercado_pago_payment_id`). No existía ninguna tabla que guardara
--    Monto/Método de pago hasta ahora: `socios.ultimo_pago` es solo la
--    fecha del último cobro, sin historial ni esos dos campos, y
--    `credit_transactions` (PWA) tampoco los tiene.
-- ============================================================

create table if not exists pagos_socio (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references profiles(id) on delete cascade,
  fecha date not null default current_date,
  paquete text not null,
  monto numeric(10, 2),
  metodo_pago text check (metodo_pago in ('efectivo', 'transferencia', 'tarjeta', 'mercado_pago', 'otro')),
  periodo_desde date,
  periodo_hasta date,
  estado text not null default 'pagado' check (estado in ('pagado', 'pendiente', 'anulado')),
  -- Listo para la futura automatización: un pago que llegue solo via
  -- Mercado Pago se inserta con origen='mercado_pago' y su payment_id,
  -- distinguible de los cobros manuales de Seba (origen='manual').
  origen text not null default 'manual' check (origen in ('manual', 'mercado_pago')),
  mercado_pago_payment_id text,
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);

create index if not exists idx_pagos_socio_user on pagos_socio(user_id, fecha desc);

alter table pagos_socio enable row level security;

-- Mismo patrón que credit_transactions: cada socio ve los suyos (pensado
-- para cuando la PWA tenga su propia pantalla de "Pagos y Facturas"), el
-- admin ve y gestiona todos.
drop policy if exists "pagos_socio_select_own_or_admin" on pagos_socio;
create policy "pagos_socio_select_own_or_admin" on pagos_socio
  for select using (auth.uid() = user_id or public.is_admin());

drop policy if exists "pagos_socio_admin_write" on pagos_socio;
create policy "pagos_socio_admin_write" on pagos_socio
  for all using (public.is_admin()) with check (public.is_admin());
