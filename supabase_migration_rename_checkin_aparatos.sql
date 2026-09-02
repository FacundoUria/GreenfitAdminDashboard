-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE APLICÓ TODAVÍA -- generado para revisión, Fase C2.
--
-- Rename de admin_otorgar_checkin_musculacion() -> admin_otorgar_checkin_aparatos()
-- (consistente con la nomenclatura estricta ya aplicada al resto del
-- sistema -- "Musculación" se unificó en "Aparatos" hace varias sesiones,
-- este RPC quedó como el único lugar que todavía dice "musculacion").
--
-- ALTER FUNCTION ... RENAME TO en vez de drop + create or replace: es una
-- sola operación atómica que preserva el body, el `grant execute`
-- existente y cualquier dependencia -- no hace falta re-otorgar permisos
-- ni recrear nada.
--
-- Este script NO alcanza solo -- ver la lista completa de archivos de
-- código (fichaSocioPwa.js, CheckInRapidoModal.jsx, y los 2 tests) que
-- tienen que actualizarse en el MISMO commit, o el Check-in Rápido del
-- panel se rompe en producción apenas se corra esto.

alter function public.admin_otorgar_checkin_musculacion(uuid)
  rename to admin_otorgar_checkin_aparatos;

-- ── Verificación (opcional, después de correr lo de arriba) ────────────────
-- select oid::regprocedure from pg_proc where proname in
--   ('admin_otorgar_checkin_musculacion', 'admin_otorgar_checkin_aparatos');
-- Tiene que devolver UNA sola fila: admin_otorgar_checkin_aparatos(uuid).
-- select grantee, privilege_type from information_schema.routine_privileges
--   where routine_name = 'admin_otorgar_checkin_aparatos';
-- Tiene que seguir listando 'authenticated' con EXECUTE (el grant viejo
-- sobrevive al rename, no hace falta un grant nuevo).
