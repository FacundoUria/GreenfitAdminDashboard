-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- Limpieza de código muerto (Fase A del ticket): existe una función
-- huérfana public.mp_process_payment con una firma vieja de parámetros
-- sueltos (greenfit-app/backend/supabase_migration_mercadopago_payments.sql):
--   mp_process_payment(uuid, uuid, uuid, int, int, numeric, text, text, text)
-- Postgres permite funciones sobrecargadas (mismo nombre, distinta firma) --
-- como nunca se dropeó esa versión vieja al introducir la firma nueva con
-- combos (jsonb), es muy probable que ambas convivan hoy en producción.
--
-- Verificado antes de escribir esto (búsqueda real, no memoria de sesión):
--   - supabase/functions/mp-webhook/index.ts:63 -- ÚNICO caller real en
--     todo el repo -- llama con p_creditos/p_incluye_aparatos/... (la
--     firma NUEVA, jsonb).
--   - Ningún otro archivo (Admin, PWA, otras RPCs, e2e) llama a
--     mp_process_payment con la firma vieja (p_discipline_id/p_credits/
--     p_duration_days escalares) -- ni siquiera en comentarios que
--     describan un uso real.
--   - supabase_migration_mp_sync_socios.sql (este mismo repo) también
--     define mp_process_payment, pero con la MISMA firma jsonb de arriba
--     (create or replace de la versión nueva, le agrega sincronizar
--     socios.creditos/fecha_vencimiento) -- no crea una tercera firma, no
--     cambia esta conclusión.
--
-- La firma nueva (jsonb) NO se toca -- sigue intacta, sea cual sea su
-- versión de body vigente (con o sin el sync a socios).

-- ── Verificación ANTES de dropear (opcional, correr aparte) ────────────────
-- select oid::regprocedure from pg_proc where proname = 'mp_process_payment';
-- Debería listar 2 firmas hoy: la vieja (9 params escalares) y la nueva
-- (10 params, con p_creditos jsonb).

drop function if exists public.mp_process_payment(uuid, uuid, uuid, int, int, numeric, text, text, text);

-- ── Verificación DESPUÉS de dropear ─────────────────────────────────────────
-- select oid::regprocedure from pg_proc where proname = 'mp_process_payment';
-- Tiene que quedar UNA sola fila (la firma nueva, con p_creditos jsonb).
