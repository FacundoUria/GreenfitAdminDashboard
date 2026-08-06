-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)

-- Fecha de inicio de la cuota VIGENTE, elegida a mano por el admin en
-- "Registrar Pago" (junto con fecha_vencimiento, ver supabase_migration_fecha_vencimiento.sql).
-- Distinta de `created_at` (fecha de alta de la cuenta, no se toca).
alter table socios
  add column if not exists fecha_inicio_cuota date;

-- Backfill de socios existentes: como hasta ahora el inicio de la cuota
-- vigente no se guardaba, se aproxima restando 1 mes a la fecha_vencimiento
-- actual (o usando ultimo_pago/created_at si ni eso tiene).
update socios
set fecha_inicio_cuota = coalesce(fecha_vencimiento - interval '1 month', ultimo_pago, created_at::date)
where fecha_inicio_cuota is null;
