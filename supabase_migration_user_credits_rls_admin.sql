-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- Caso Aixa / Kickboxing (segunda vuelta): el UPSERT de sincronizarCreditosPwa
-- (creditosPwa.js) puede fallar en silencio si la policy de RLS de
-- user_credits no deja pasar el INSERT/UPDATE del admin -- en ese caso
-- Supabase NO devuelve ningún error (la fila simplemente no matchea ninguna
-- policy y queda afuera), lo que explica el síntoma reportado ("error: null"
-- en la consola). backend/supabase-schema.sql (repo greenfit-app) define:
--
--   create policy "user_credits_admin_write" on user_credits
--     for all using (public.is_admin());
--
-- Esa policy, en teoría, ya alcanza (Postgres reusa el USING como WITH
-- CHECK cuando no hay uno explícito) -- pero esta migración la recrea con
-- un WITH CHECK EXPLÍCITO para sacar cualquier ambigüedad de en medio, sin
-- cambiar el criterio de acceso (sigue siendo "solo admin escribe").
-- Recrearla es seguro: DROP + CREATE de la misma policy no borra ni
-- modifica ninguna fila de la tabla, solo la regla de acceso.
drop policy if exists "user_credits_admin_write" on public.user_credits;

create policy "user_credits_admin_write" on public.user_credits
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- ── Verificación rápida (opcional, después de correr lo de arriba) ─────────
-- Confirma que la sesión actual (logueada como admin en el SQL Editor, o
-- vía "Run as" con el JWT del admin real) puede insertar/actualizar
-- cualquier fila de user_credits sin que RLS la bloquee en silencio:
--
-- select public.is_admin(); -- tiene que dar TRUE con la sesión del admin
--
-- select policyname, cmd, qual, with_check
--   from pg_policies
--   where tablename = 'user_credits';
