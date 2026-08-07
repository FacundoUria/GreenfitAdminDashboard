-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)

-- Alerta global / anuncio flotante DENTRO de la app de socios (PWA) --
-- distinta de banner_activo/banner_mensaje (esa es la barra de la LANDING
-- pública, otra audiencia). Un admin puede querer avisar algo solo a los
-- socios ya logueados en la app sin tocar la web pública, o viceversa.
alter table configuracion
  add column if not exists alerta_app_activa boolean not null default false,
  add column if not exists alerta_app_mensaje text;
