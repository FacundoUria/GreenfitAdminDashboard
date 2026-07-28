-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)

alter table socios
  add column if not exists dia_corte integer,
  add column if not exists fecha_vencimiento date;

-- Backfill de socios existentes:
--   dia_corte         = día del mes de ultimo_pago (o de created_at si nunca pagó)
--   fecha_vencimiento = esa misma fecha + 1 mes
update socios
set dia_corte = extract(day from coalesce(ultimo_pago, created_at::date)),
    fecha_vencimiento = coalesce(ultimo_pago, created_at::date) + interval '1 month'
where fecha_vencimiento is null;
