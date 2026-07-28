-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- 1) Créditos por socio: usados por los planes de Actividades (CrossFit, Boxeo,
--    Kickstrike). Aparatos/Musculación y Pase Libre no usan créditos, se manejan
--    solo por fecha_vencimiento/estado (ya existente).
alter table socios
  add column if not exists creditos integer not null default 0;

-- 2) Configuración de precios: pasar de 3 campos difusos a 4 precios por
--    producto real, uno por cada plan que vende el gimnasio.
alter table configuracion rename column precio_pase_libre to precio_crossfit;
alter table configuracion rename column precio_musculacion to precio_aparatos;

alter table configuracion
  add column if not exists precio_boxeo numeric(10, 2) not null default 0,
  add column if not exists precio_kickstrike numeric(10, 2) not null default 0;

alter table configuracion drop column if exists precio_pase_clases;
