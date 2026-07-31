-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- Contexto: auditoría E2E del sistema de Web Push Notifications. savePushSubscription()
-- (greenfit-app/src/lib/pushApi.ts) hace SELECT por endpoint y, si ya existe, UPDATE --
-- pero push_subscriptions tenía policies de INSERT/SELECT/DELETE y NINGUNA de UPDATE.
-- Sin policy, RLS bloquea el UPDATE en silencio: la query corre sin error (0 filas
-- afectadas), así que el cliente cree que guardó la suscripción renovada y en realidad
-- quedó la vieja (potencialmente muerta) en la base. Aditivo: no toca INSERT/SELECT/DELETE.
--
-- Ya aplicado en producción (2026-07-30) y verificado en vivo con un round-trip real de
-- Push (Playwright + FCM real): sin esta policy el UPDATE devolvía 0 filas afectadas;
-- con ella, la fila se actualiza de verdad.

create policy "Usuarios pueden actualizar sus propias suscripciones"
  on public.push_subscriptions
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
