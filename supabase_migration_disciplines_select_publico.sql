-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- BUG CRÍTICO REAL: Aparatos (is_active=false) seguía sin aparecer en la
-- Landing ("Elegí tu ritmo") aunque `index.html` YA NO filtra por
-- is_active del lado del cliente (ver commit anterior, "fix: landing page
-- muestra todas las disciplinas sin badges de estado"). Diagnóstico
-- confirmado leyendo `disciplines` con la MISMA anon key que usa la
-- Landing (sin sesión): devolvía únicamente Boxeo/CrossFit/Kickboxing
-- (is_active=true) -- Aparatos ni siquiera llegaba a la respuesta. Eso
-- significa que el filtro real NO estaba en el código de la Landing sino
-- en una Row Level Security policy de `disciplines` que restringe el
-- SELECT del rol anon/público a is_active=true (probablemente configurada
-- a mano en el dashboard de Supabase, sin migración rastreada acá) --
-- ningún cambio de `index.html` puede pasar por encima de eso, el filtro
-- corre en la base antes de que la fila llegue al cliente.
--
-- Fix: una policy nueva y explícitamente permisiva de SELECT para
-- `disciplines` -- en Postgres, las policies permisivas se combinan con
-- OR, así que esta sola alcanza para que el catálogo completo (activo o
-- no) quede legible por cualquiera, sin necesidad de tocar/adivinar el
-- nombre de la policy restrictiva que ya exista. `disciplines` es catálogo
-- público del gimnasio (nombre/tipo/cupo) -- nada sensible, no hay
-- problema en que sea 100% legible sin sesión.
alter table disciplines enable row level security;

drop policy if exists "disciplines_select_public" on disciplines;
create policy "disciplines_select_public" on disciplines
  for select
  using (true);

-- Verificación opcional (correr aparte, ANTES o DESPUÉS de lo de arriba):
-- confirma que "Aparatos" existe de verdad en la tabla y ver su estado
-- actual de is_active/show_in_agenda. El SQL Editor corre como service
-- role (bypasea RLS), así que esto siempre muestra la verdad completa sin
-- importar las policies.
--   select id, name, kind, is_active, show_in_agenda from disciplines order by name;
