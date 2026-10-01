-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- Cierra los permisos de las 5 funciones que acreditan créditos. Son SOLO
-- revoke/grant: no cambia el código de ninguna función ni toca ningún dato.
-- Idempotente.
--
-- AGUJERO: acreditar_pack() y mp_process_payment() no validan nada adentro y
-- se podían llamar por RPC desde afuera -- con login de socio y también SIN
-- login (Postgres le da EXECUTE a PUBLIC por defecto al crear una función, y
-- cada migración además terminaba con `grant ... to authenticated`). Cualquiera
-- podía acreditarse un pack sin pagar.
--
-- QUIÉN QUEDA CON PERMISO
--   acreditar_pack                      -> nadie de afuera. Solo la llaman, por dentro,
--                                          crear_pago_pendiente_transferencia, mp_process_payment
--                                          y admin_aprobar_comprobante: son SECURITY DEFINER, así
--                                          que adentro de ellas el permiso se chequea contra el
--                                          DUEÑO (postgres), no contra el socio.
--   mp_process_payment                  -> solo service_role (la Edge Function mp-webhook).
--   admin_acreditar_creditos_manual     -> authenticated (el panel Admin llama con la sesión
--   admin_aprobar_comprobante              normal de Seba; la protección real es el is_admin()
--                                          de adentro). Se cierra anon.
--   crear_pago_pendiente_transferencia  -> authenticated (el socio paga con comprobante desde la
--                                          PWA; la protección real es el is_active_socio() de
--                                          adentro). Se cierra anon.
--
-- DE PASO (privacidad, no créditos): dos funciones que devuelven listas de
-- user_id de socios sin ningún filtro, y que también se podían llamar sin login:
--   active_socio_ids()  -> nadie de afuera (no la usa nadie: ni el Admin, ni la PWA, ni RLS).
--   debtor_user_ids()   -> se cierra SOLO anon. authenticated SE MANTIENE a propósito: la
--                          policy notifications_select_recipient la evalúa con los permisos del
--                          socio que lee sus notificaciones -- sacársela rompería esa lectura.
--                          service_role se mantiene (Edge Function send-push, aviso a "deudores").
-- PENDIENTE APARTE (no se toca acá): que un socio logueado no pueda listar a los
-- "deudores" (requiere reescribir esa policy) y cerrar anon en community_author_names().
--
-- OJO A FUTURO: todas las migraciones viejas de estas funciones terminan con
-- `grant execute ... to authenticated`. Volver a correr una, o escribir una
-- versión nueva de acreditar_pack()/mp_process_payment() copiando ese final,
-- REABRE el agujero. Toda versión nueva de esas dos tiene que terminar con los
-- revoke de acá abajo (un `drop function` + `create` además vuelve a darle
-- EXECUTE a PUBLIC).
--
-- Probar con prueba_revoke_acreditar_pack.sql (se corre ANTES y DESPUÉS).

-- ── Internas: nadie las llama desde afuera ──
revoke execute on function public.acreditar_pack(uuid, uuid, text, text)
  from public, anon, authenticated;

revoke execute on function public.mp_process_payment(uuid, uuid, jsonb, boolean, int, uuid, numeric, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mp_process_payment(uuid, uuid, jsonb, boolean, int, uuid, numeric, text, text, text)
  to service_role;

-- ── Las llama un usuario logueado (Admin o socio): se cierra anon, se mantiene
--    authenticated (explícito: hoy ese permiso puede venir solo de PUBLIC). ──
revoke execute on function public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, int, date)
  from public, anon;
grant execute on function public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, int, date)
  to authenticated;

revoke execute on function public.admin_aprobar_comprobante(uuid)
  from public, anon;
grant execute on function public.admin_aprobar_comprobante(uuid)
  to authenticated;

revoke execute on function public.crear_pago_pendiente_transferencia(uuid, text, numeric)
  from public, anon;
grant execute on function public.crear_pago_pendiente_transferencia(uuid, text, numeric)
  to authenticated;

-- ── Listas de user_id de socios (privacidad) ──
revoke execute on function public.active_socio_ids()
  from public, anon, authenticated;

revoke execute on function public.debtor_user_ids()
  from public, anon;
grant execute on function public.debtor_user_ids()
  to authenticated, service_role;
