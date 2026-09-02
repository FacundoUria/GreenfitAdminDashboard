-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- ============================================================
-- PASO 1 -- VERIFICACIÓN (resumen; detalle completo en el chat)
-- ============================================================
--
-- 1) Login del Admin: YA usa Supabase Auth real hoy.
--    src/context/AuthContext.jsx -> login() llama a
--    supabase.auth.signInWithPassword({ email, password }) y valida
--    profiles.role = 'admin' antes de dejar entrar (si no es admin, hace
--    signOut() y deniega). El login hardcodeado que describía el
--    comentario de supabase_migration_admin_auth_rls.sql fue reemplazado
--    en el commit 0c27b2a ("Reemplazar el login hardcodeado del panel por
--    Supabase Auth real") -- ESE MISMO commit fue el que agregó
--    admin_auth_rls.sql. O sea: para cuando ese archivo se escribió, el
--    problema que describía ya se estaba arreglando en el mismo cambio.
--    Conclusión: hay JWT real, is_admin() funciona con auth.uid() real, y
--    el patrón authenticated + is_admin() es 100% aplicable a socios/
--    classes -- y también a configuracion/asistencias en cuanto a
--    ESCRITURA (ver punto 3 para el matiz de LECTURA).
--
-- 2) is_admin() (backend/supabase-schema.sql):
--      create or replace function public.is_admin()
--      returns boolean as $$
--        select exists (
--          select 1 from profiles where id = auth.uid() and role = 'admin'
--        );
--      $$ language sql security definer stable;
--    Mismo criterio que ya usan socios_admin_all / classes_admin_write /
--    user_credits_admin_write -- reutilizado tal cual acá, no se toca.
--
-- 3) ¿Algo público lee `configuracion` sin login? SÍ -- y es MÁS que solo
--    la landing, lo cual cambia el diseño del fix respecto de lo pedido
--    ("SELECT y UPDATE solo para admin"). Dos consumidores reales
--    confirmados por código, ninguno con sesión:
--
--    a) PAGINA COMERCIAL/greenfit-site/index.html (líneas ~658-710):
--       select('banner_activo, banner_mensaje, banner_link_text,
--       banner_link_url') y select('whatsapp_numero, instagram_usuario')
--       -- sitio 100% estático y público, sin login posible.
--
--    b) greenfit-app/src/context/ConfiguracionContext.tsx (líneas 53-97),
--       montado en App.tsx ANTES de RootNavigator (envuelve TODA la app,
--       incluida la pantalla de Login) con un useEffect(..., []) que corre
--       UNA vez al abrir la app, sin importar si hay sesión:
--       select('precio_crossfit, precio_boxeo, precio_kickstrike,
--       precio_aparatos, dias_tolerancia, limite_cancelacion_minutos,
--       alias_cvu, titular_cuenta') + select('alerta_app_activa,
--       alerta_app_mensaje') aparte. Esto confirma además que
--       `limite_cancelacion_minutos`/`alias_cvu` (mencionados en la
--       auditoría como posible drift de nombres) SÍ existen de verdad en
--       producción -- si no existieran, esta pantalla ya estaría rota hoy.
--
--    Por eso el fix de abajo NO usa "SELECT solo admin" para
--    `configuracion` (eso rompería el precio/alias/tolerancia que ve
--    CUALQUIER socio logueado en "Elegí tu pack", y el arranque en frío
--    de la PWA antes de loguearse) -- usa columnas acotadas para `anon`
--    (la unión real de lo que leen los dos consumidores de arriba) en vez
--    de cerrar el SELECT del todo. Ningún dato de esa lista es secreto al
--    LEERSE (precios y alias de transferencia son, por naturaleza,
--    información que un gimnasio muestra para poder cobrar) -- el riesgo
--    real y lo único que hay que cerrar de verdad es la ESCRITURA, que sí
--    queda 100% admin-only acá abajo.
--    Nota técnica: Supabase no tiene un rol de Postgres separado para
--    "admin" -- admin y socio comparten el mismo rol `authenticated`, la
--    distinción vive en profiles.role vía is_admin(). Por eso el recorte
--    de columnas (GRANT SELECT (col, col...)) solo tiene sentido aplicado
--    a `anon`: aplicado a `authenticated` afectaría por igual a Seba
--    logueado en Configuracion.jsx (que hace select('*') y necesita ver
--    la fila entera) y a un socio cualquiera -- ahí la única forma de
--    diferenciar admin de socio es RLS (is_admin()), no GRANT de columnas.
--
-- 4) `asistencias`: no se pudo correr `select * from pg_policies where
--    tablename = 'asistencias'` (sin acceso a producción desde acá) --
--    correlo vos ANTES de aplicar esto y guardá el resultado por las
--    dudas. Por diseño, el bloque de abajo NO asume que esas policies
--    tengan los nombres de supabase_migration_rls_y_clase_id.sql (podrían
--    haber cambiado a mano, mismo patrón de drift que ya detectó la
--    auditoría en otras tablas) -- dropea CUALQUIER policy que exista hoy
--    en `asistencias`, sea cual sea su nombre, antes de crear las nuevas.
--    Verificación adicional hecha para esta migración: no se encontró
--    ningún `.from('asistencias')` vivo en el código de ninguno de los
--    dos frontends, ni ningún RPC/función SQL que la lea o escriba --
--    todo lo que hoy calcula asistencias usa `bookings`/`xp_events`. Todo
--    indica que es una tabla legacy sin tráfico real, así que se cierra
--    100% a admin (no hay ninguna columna "dueño" confirmada en uso para
--    ofrecer un SELECT propio del socio, y no hay evidencia de que haga
--    falta).
--
-- ============================================================
-- PASO 2 -- FIX
-- ============================================================

-- ── 1) configuracion: cerrar anon, dejar SELECT acotado por columnas ────

-- Limpieza defensiva: revoca cualquier grant de tabla completa que pueda
-- existir hoy sobre `configuracion` para anon/authenticated (probablemente
-- el default de Supabase al crear la tabla) -- sin esto, un GRANT SELECT
-- de columnas puntuales de más abajo no restringe nada si ya existe un
-- GRANT SELECT de la tabla entera corriendo en paralelo.
revoke all on public.configuracion from anon;
revoke all on public.configuracion from authenticated;

-- authenticated (socio Y admin -- comparten el mismo rol de Postgres, ver
-- nota del punto 3 de arriba): SELECT de la fila entera. Nada acá es
-- secreto al leerse; lo que había que cerrar es la escritura (más abajo).
grant select on public.configuracion to authenticated;

-- anon (Landing pública + arranque en frío de la PWA antes de loguearse):
-- SOLO las columnas que los dos consumidores reales confirmados
-- necesitan (unión exacta de lo listado en el punto 3). `id` incluida
-- porque ambos filtran con .eq('id', 1) -- sin privilegio de lectura
-- sobre esa columna, el propio filtro falla aunque no esté en el SELECT.
grant select (
  id,
  precio_crossfit,
  precio_boxeo,
  precio_kickstrike,
  precio_aparatos,
  dias_tolerancia,
  limite_cancelacion_minutos,
  alias_cvu,
  titular_cuenta,
  banner_activo,
  banner_mensaje,
  banner_link_text,
  banner_link_url,
  whatsapp_numero,
  instagram_usuario,
  alerta_app_activa,
  alerta_app_mensaje
) on public.configuracion to anon;

-- Policies: se dropean las que abrían UPDATE a anon (el hueco real) y la
-- de SELECT abierta también, para reemplazarlas por las de abajo.
drop policy if exists "anon select configuracion" on public.configuracion;
drop policy if exists "anon update configuracion" on public.configuracion;
drop policy if exists "configuracion_select_authenticated" on public.configuracion;
drop policy if exists "configuracion_select_anon_publica" on public.configuracion;
drop policy if exists "configuracion_update_admin" on public.configuracion;

-- SELECT: cualquier logueado (socio o admin) ve la fila entera -- el GRANT
-- de arriba ya decide qué columnas puede pedir cada rol.
create policy "configuracion_select_authenticated" on public.configuracion
  for select
  to authenticated
  using (true);

-- SELECT: público (Landing + PWA sin sesión) ve la fila -- el GRANT de
-- columnas de arriba es lo que realmente acota qué puede leer.
create policy "configuracion_select_anon_publica" on public.configuracion
  for select
  to anon
  using (true);

-- UPDATE: SOLO admin autenticado. Este es el fix real del hueco de
-- seguridad -- mismo patrón exacto que socios_admin_all/
-- classes_admin_write (authenticated + is_admin()). anon no tiene NINGÚN
-- grant de UPDATE (revocado arriba) y ninguna policy que lo permita.
create policy "configuracion_update_admin" on public.configuracion
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ── 2) asistencias: cerrar TODO a anon, dejar todo (CRUD) admin-only ────

-- Dropea cualquier policy que exista hoy en la tabla, sea cual sea su
-- nombre real en producción (ver nota del punto 4 de arriba).
do $$
declare
  pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'asistencias'
  loop
    execute format('drop policy if exists %I on public.asistencias', pol.policyname);
  end loop;
end $$;

revoke all on public.asistencias from anon;
revoke all on public.asistencias from authenticated;
grant select, insert, update, delete on public.asistencias to authenticated;

alter table public.asistencias enable row level security;

create policy "asistencias_admin_all" on public.asistencias
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- VERIFICACIÓN (correr a mano DESPUÉS de aplicar lo de arriba)
-- ============================================================

-- (a) Logueado como admin real en el panel (o "Run as" con el JWT del
--     admin en el SQL Editor) -- todo esto tiene que funcionar igual que
--     antes:
--
-- select public.is_admin(); -- true
-- select * from configuracion where id = 1;                 -- fila completa
-- update configuracion set banner_mensaje = banner_mensaje where id = 1; -- 1 fila afectada
-- select * from asistencias limit 1;                         -- funciona (puede dar 0 filas si está vacía, eso es OK)

-- (b) Sin sesión -- con la anon key pura, SIN Authorization Bearer de un
--     usuario logueado (ej. curl directo a la REST API, o
--     createClient(url, anonKey) sin signIn):
--
-- select alias_cvu, titular_cuenta from configuracion where id = 1;   -- OK, tiene que funcionar (es el fix de la Landing/PWA)
-- select * from configuracion where id = 1;                           -- tiene que FALLAR ("permission denied for column ...") -- select(*) ya no es legal para anon
-- update configuracion set alias_cvu = 'hackeado' where id = 1;       -- tiene que devolver 0 filas afectadas (RLS bloquea el UPDATE)
-- select * from asistencias limit 1;                                  -- tiene que devolver 0 filas (RLS bloquea el SELECT, sin error -- así es como responde RLS: no error, filtra en silencio)
-- insert into asistencias (id) values (gen_random_uuid());            -- tiene que FALLAR (RLS bloquea el INSERT)

-- (c) Logueado como un SOCIO común (no admin) en la PWA:
--
-- select precio_crossfit, alias_cvu from configuracion where id = 1;  -- tiene que funcionar (Elegí tu pack / arranque de la app)
-- update configuracion set banner_mensaje = 'test' where id = 1;      -- tiene que devolver 0 filas afectadas (is_admin() = false)
