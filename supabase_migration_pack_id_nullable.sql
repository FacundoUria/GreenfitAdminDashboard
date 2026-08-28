-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- Caso Aixa / Kickboxing: al sumar créditos a mano desde el panel Admin
-- para una disciplina que el socio nunca tuvo inicializada en
-- `user_credits` (la migración inicial solo sembró filas para CrossFit),
-- sincronizarCreditosPwa (src/utils/creditosPwa.js) fallaba al escribir esa
-- primera fila.
--
-- backend/supabase-schema.sql (repo greenfit-app) define
-- user_credits.pack_id como `not null references packs(id)`. Un ajuste
-- manual de créditos hecho por el admin (sin pasar por la compra de un
-- pack real) nunca tiene un pack_id real que ofrecer -- si esa restricción
-- sigue vigente tal cual en producción, CUALQUIER insert de
-- sincronizarCreditosPwa/sincronizarVencimientoPwa/
-- sincronizarVencimientoCreditoPwa (ninguna de las 3 manda pack_id) viola
-- la constraint y el INSERT se rechaza -- coincide exactamente con el
-- síntoma reportado ("crédito al plan actualizado pero no se pudo
-- sincronizar con la app"). Volverla nullable es un cambio aditivo y
-- seguro (no afecta ninguna fila ni policy existente) que despeja esa
-- posibilidad de raíz, sea o no la causa real en este ambiente puntual.
alter table public.user_credits
  alter column pack_id drop not null;

-- ── Verificación rápida (opcional, después de correr lo de arriba) ─────────
-- select is_nullable from information_schema.columns
--   where table_name = 'user_credits' and column_name = 'pack_id';
