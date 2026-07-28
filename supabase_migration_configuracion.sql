-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- Tabla de fila única con la configuración operativa del gimnasio. La lee el
-- Web Dashboard y, a futuro, la App Mobile (banner de anuncios, precios, etc.)
-- con la misma clave publicable.

create table if not exists configuracion (
  id integer primary key default 1,
  precio_pase_libre numeric(10, 2) not null default 0,
  precio_musculacion numeric(10, 2) not null default 0,
  precio_pase_clases numeric(10, 2) not null default 0,
  dias_tolerancia integer not null default 5,
  horas_limite_cancelacion integer not null default 2,
  banner_activo boolean not null default false,
  banner_mensaje text not null default '',
  alias_cbu text not null default '',
  titular_cuenta text not null default '',
  updated_at timestamptz not null default now(),
  constraint configuracion_singleton check (id = 1)
);

insert into configuracion (id) values (1)
on conflict (id) do nothing;

-- RLS: la app usa la clave publicable (anon) sin login todavía. Solo se permite
-- leer y actualizar la fila -- nunca insertar ni borrar (es una fila fija).
alter table configuracion enable row level security;

drop policy if exists "anon select configuracion" on configuracion;
drop policy if exists "anon update configuracion" on configuracion;

create policy "anon select configuracion" on configuracion for select to anon using (true);
create policy "anon update configuracion" on configuracion for update to anon using (true) with check (true);
