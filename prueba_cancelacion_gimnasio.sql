-- =====================================================================================
-- PRUEBA de supabase_migration_cancelacion_gimnasio_reintegro.sql -- correr DESPUÉS de la
-- migración, en el SQL Editor, con la cuenta de test DNI 44537978.
--
-- NO DEJA NADA: todo pasa dentro de un único bloque DO que termina SIEMPRE con un error a
-- propósito ("PRUEBA TERMINADA -- se deshizo todo"). Ese error deshace todo lo que hizo
-- (disciplinas, clases, lotes, pagos, reservas, cancelaciones y notificaciones de prueba).
-- El mensaje del error ES el informe: "N de M OK" y una línea por chequeo.
--
-- Usa una disciplina y una clase de PRUEBA propias: los créditos reales de la cuenta de test
-- no participan (y se verifica que no cambien). Corre como el primer admin de profiles
-- (simulando su sesión con request.jwt.claims, local a esta transacción).
-- =====================================================================================

do $prueba$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  v_user uuid;
  v_admin uuid;
  v_disc uuid;
  v_disc2 uuid;
  v_clase uuid;
  v_clase2 uuid;
  v_clase3 uuid;
  v_base date := (now() at time zone 'America/Argentina/Mendoza')::date + 40;
  l1 uuid; l2 uuid; l3 uuid; l4 uuid; l6 uuid;
  v_disc_ap uuid;
  v_disc_ap2 uuid;
  v_nombre_ap text;
  v_nombre_ap2 text;
  v_clase_ap uuid;
  v_clase_ap2 uuid;
  la uuid;
  r jsonb;
  v_int int;
  v_bool boolean;
  v_txt text;
  v_huella_real_antes text;
  v_huella_real_despues text;
  v_notifs_antes int;
  ok int := 0;
  total int := 0;
  informe text := '';
begin
  -- ── Preparación ────────────────────────────────────────────────────────────────────
  select id into v_user from profiles where dni = '44537978';
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  select id into v_admin from profiles where role = 'admin' order by created_at limit 1;
  if v_admin is null then
    raise exception 'No hay ningún perfil admin.';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Huella de los créditos REALES de la cuenta de test (no tienen que cambiar).
  select coalesce(md5(string_agg(id::text || ':' || coalesce(remaining_credits, -1) || ':' || coalesce(expires_at::text, ''), ',' order by id)), '-')
    into v_huella_real_antes
  from user_credits where user_id = v_user;

  -- Mismas columnas que manda el Admin al crear una disciplina (DisciplinaModal.jsx); oculta e inactiva.
  insert into disciplines (name, kind, is_active, show_in_agenda) values ('PRUEBA REINTEGRO ' || gen_random_uuid(), 'credits', false, false) returning id into v_disc;
  insert into disciplines (name, kind, is_active, show_in_agenda) values ('PRUEBA REINTEGRO 2 ' || gen_random_uuid(), 'credits', false, false) returning id into v_disc2;
  insert into classes (title, discipline_id, capacity, days_of_week, start_time, end_time)
    values ('PRUEBA REINTEGRO', v_disc, 50, '{0,1,2,3,4,5,6}', '23:00', '23:30') returning id into v_clase;
  insert into classes (title, discipline_id, capacity, days_of_week, start_time, end_time)
    values ('PRUEBA REINTEGRO 2', v_disc2, 50, '{0,1,2,3,4,5,6}', '23:00', '23:30') returning id into v_clase2;
  insert into classes (title, discipline_id, capacity, days_of_week, start_time, end_time)
    values ('PRUEBA CLASE DEL DIA', v_disc, 50, '{0,1,2,3,4,5,6}', '22:00', '22:30') returning id into v_clase3;

  -- Aparatos de prueba (kind = 'membership'): uno con acceso vigente (la) y otro sin nada.
  v_nombre_ap := 'PRUEBA APARATOS ' || gen_random_uuid();
  v_nombre_ap2 := 'PRUEBA APARATOS 2 ' || gen_random_uuid();
  insert into disciplines (name, kind, is_active, show_in_agenda) values (v_nombre_ap, 'membership', false, false) returning id into v_disc_ap;
  insert into disciplines (name, kind, is_active, show_in_agenda) values (v_nombre_ap2, 'membership', false, false) returning id into v_disc_ap2;
  insert into classes (title, discipline_id, capacity, days_of_week, start_time, end_time)
    values ('PRUEBA APARATOS', v_disc_ap, 50, '{0,1,2,3,4,5,6}', '23:00', '23:30') returning id into v_clase_ap;
  insert into classes (title, discipline_id, capacity, days_of_week, start_time, end_time)
    values ('PRUEBA APARATOS 2', v_disc_ap2, 50, '{0,1,2,3,4,5,6}', '23:00', '23:30') returning id into v_clase_ap2;
  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values (v_user, v_disc_ap, null, now() + interval '15 days') returning id into la;

  -- Lotes de prueba:
  --  l1 vigente (vence en 20 días)            -> destino normal del +1
  --  l2 de un pago anulado CON regla F          (vencido, listado en filas_vencidas)
  --  l3 de un pago anulado ANTES de la regla F  (sigue vigente y vence ANTES que l1)
  --  l4 vencido / reseteado (no anulado)
  --  l6 vencido en otra disciplina sin nada vigente
  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values (v_user, v_disc, 3, now() + interval '20 days') returning id into l1;
  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values (v_user, v_disc, 0, now() - interval '1 day') returning id into l2;
  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values (v_user, v_disc, 1, now() + interval '10 days') returning id into l3;
  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values (v_user, v_disc, 0, now() - interval '5 days') returning id into l4;
  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values (v_user, v_disc2, 0, now() - interval '3 days') returning id into l6;

  insert into pagos_socio (user_id, paquete, estado, origen, detalle_acreditacion)
  values (v_user, 'PRUEBA regla F', 'anulado', 'manual', jsonb_build_object(
    'reversion', jsonb_build_object('filas_vencidas', jsonb_build_array(jsonb_build_object(
      'user_credit_id', l2, 'disciplina', 'PRUEBA', 'saldo_que_tenia', 1, 'vencia', now())))));
  insert into pagos_socio (user_id, paquete, estado, origen, detalle_acreditacion)
  values (v_user, 'PRUEBA anterior a regla F', 'anulado', 'manual', jsonb_build_object(
    'creditos', jsonb_build_array(jsonb_build_object('discipline_id', v_disc, 'credits_otorgados', 1, 'lote_id', l3))));

  -- Reservas de prueba (una por día, desde dentro de 40 días).
  insert into bookings (user_id, class_id, booking_date, credit_lote_id) values
    (v_user, v_clase, v_base + 1, l1),
    (v_user, v_clase, v_base + 2, l2),
    (v_user, v_clase, v_base + 3, l3),
    (v_user, v_clase, v_base + 4, l4),
    (v_user, v_clase, v_base + 5, null),
    (v_user, v_clase2, v_base + 6, l6),
    (v_user, v_clase3, v_base + 7, l1),
    (v_user, v_clase3, v_base + 8, l2),
    (v_user, v_clase3, v_base + 9, l4),
    (v_user, v_clase, v_base + 10, l4),
    (v_user, v_clase, v_base + 11, l4),
    (v_user, v_clase, v_base + 12, l1),
    (v_user, v_clase, v_base + 13, l1),
    (v_user, v_clase_ap, v_base + 14, null),
    (v_user, v_clase_ap2, v_base + 15, null);

  -- ── S1. Quitar: lote vigente -> +1 a ese lote ───────────────────────────────────────
  r := admin_quitar_de_clase(v_user, v_clase, v_base + 1, 'prueba');
  total := total + 1;
  if r->>'motivo' = 'reintegrado' and (r->>'lote_id')::uuid = l1 and (select remaining_credits from user_credits where id = l1) = 4 then
    ok := ok + 1; informe := informe || E'\nOK     S1 lote vigente -> +1 al mismo lote (l1 = 4)';
  else informe := informe || E'\nFALLA  S1 lote vigente: ' || r::text; end if;

  -- ── S2. Quitar: lote de pago anulado (regla F) -> no se devuelve ─────────────────────
  r := admin_quitar_de_clase(v_user, v_clase, v_base + 2, 'prueba');
  v_txt := format('El gimnasio te quitó de la clase del %s. Ese crédito no se reintegró porque pertenecía a un pago anulado. Consultá con el gimnasio.', to_char(v_base + 2, 'DD/MM/YYYY'));
  total := total + 1;
  if r->>'motivo' = 'pago_anulado' and r->>'mensaje_socio' = v_txt
     and (select remaining_credits from user_credits where id = l1) = 4
     and (select remaining_credits from user_credits where id = l2) = 0 then
    ok := ok + 1; informe := informe || E'\nOK     S2 pago anulado (regla F) -> no se devuelve, mensaje exacto';
  else informe := informe || E'\nFALLA  S2 pago anulado regla F: ' || r::text; end if;

  -- ── S3. Quitar: lote de pago anulado ANTES de la regla F (sigue vigente) -> no se devuelve
  r := admin_quitar_de_clase(v_user, v_clase, v_base + 3, 'prueba');
  total := total + 1;
  if r->>'motivo' = 'pago_anulado' and (select remaining_credits from user_credits where id = l3) = 1
     and (select remaining_credits from user_credits where id = l1) = 4 then
    ok := ok + 1; informe := informe || E'\nOK     S3 pago anulado anterior a regla F (lote vigente) -> no se devuelve';
  else informe := informe || E'\nFALLA  S3 pago anulado pre-F: ' || r::text; end if;

  -- ── S4. Quitar: lote vencido/reseteado -> +1 al vigente que vence antes, SIN contar l3 ──
  r := admin_quitar_de_clase(v_user, v_clase, v_base + 4, 'prueba');
  total := total + 1;
  if r->>'motivo' = 'reintegrado_otro_lote' and (r->>'lote_id')::uuid = l1
     and (select remaining_credits from user_credits where id = l1) = 5
     and (select remaining_credits from user_credits where id = l3) = 1
     and (select remaining_credits from user_credits where id = l4) = 0 then
    ok := ok + 1; informe := informe || E'\nOK     S4 lote vencido -> +1 a l1 (l3 vence antes pero es de pago anulado)';
  else informe := informe || E'\nFALLA  S4 lote vencido: ' || r::text; end if;

  -- ── S5. Quitar: reserva vieja sin lote -> +1 al vigente que vence antes ─────────────────
  r := admin_quitar_de_clase(v_user, v_clase, v_base + 5, 'prueba');
  total := total + 1;
  if r->>'motivo' = 'reintegrado_fifo' and (select remaining_credits from user_credits where id = l1) = 6 then
    ok := ok + 1; informe := informe || E'\nOK     S5 reserva sin lote -> +1 a l1';
  else informe := informe || E'\nFALLA  S5 sin lote: ' || r::text; end if;

  -- ── S6. Quitar: sin nada vigente en esa disciplina -> no se devuelve ────────────────────
  r := admin_quitar_de_clase(v_user, v_clase2, v_base + 6, 'prueba');
  total := total + 1;
  if r->>'motivo' = 'sin_lote_vigente' and not (r->>'reintegrado')::boolean
     and r->>'mensaje_socio' like '%no se reintegró porque no tenés créditos vigentes de PRUEBA REINTEGRO 2%'
     and (select remaining_credits from user_credits where id = l6) = 0 then
    ok := ok + 1; informe := informe || E'\nOK     S6 sin lote vigente -> no se devuelve, mensaje con la verdad';
  else informe := informe || E'\nFALLA  S6 sin vigente: ' || r::text; end if;

  -- ── S7. Las 6 de Quitar: 6 notificaciones, ninguna miente, reservas borradas, log ok ────
  total := total + 1;
  if (select count(*) from notifications where target_user_id = v_user and created_at = now() and title = 'Cambio en tu reserva') = 6
     and not exists (select 1 from notifications where target_user_id = v_user and created_at = now()
                     and body like '%no se reintegró%' and body like '%devolvimos%')
     and (select count(*) from notifications where target_user_id = v_user and created_at = now() and body like '%Te devolvimos el crédito%') = 3
     and not exists (select 1 from bookings where class_id in (v_clase, v_clase2) and booking_date between v_base + 1 and v_base + 6)
     and (select count(*) from booking_cancellations where user_id = v_user and class_id in (v_clase, v_clase2) and cancelled_at = now()) = 6 then
    ok := ok + 1; informe := informe || E'\nOK     S7 Quitar avisa siempre (6 notificaciones, 3 "devolvimos", 0 contradictorias) y deja el log';
  else informe := informe || E'\nFALLA  S7 notificaciones/log de Quitar'; end if;

  -- ── S8. Cancelar la clase del día (v2), crédito devuelto ────────────────────────────────
  r := admin_cancelar_clase_dia_v2(v_clase3, v_base + 7);
  total := total + 1;
  if (r->>'cancelados')::int = 1 and (r->>'reintegrados')::int = 1 and jsonb_array_length(r->'no_reintegrados') = 0
     and (select remaining_credits from user_credits where id = l1) = 7
     and exists (select 1 from class_occurrence_cancellations where class_id = v_clase3 and occurrence_date = v_base + 7)
     and exists (select 1 from notifications where target_user_id = v_user and created_at = now() and title = 'Clase cancelada'
                 and body = format('PRUEBA CLASE DEL DIA de las 22:00 del %s fue cancelada por el gimnasio. Te devolvimos el crédito (vence el %s).',
                                   to_char(v_base + 7, 'DD/MM/YYYY'), to_char(((select expires_at from user_credits where id = l1) at time zone c_zona)::date, 'DD/MM/YYYY'))) then
    ok := ok + 1; informe := informe || E'\nOK     S8 clase del día: resumen 1/1, ocurrencia marcada, notificación verdadera';
  else informe := informe || E'\nFALLA  S8 clase del día (devuelto): ' || r::text; end if;

  -- ── S9. Cancelar la clase del día (v2), pago anulado -> texto pedido, en el resumen ─────
  r := admin_cancelar_clase_dia_v2(v_clase3, v_base + 8);
  total := total + 1;
  if (r->>'cancelados')::int = 1 and (r->>'reintegrados')::int = 0
     and r->'no_reintegrados'->0->>'motivo' = 'pago_anulado'
     and r->'no_reintegrados'->0->>'mensaje_admin' like '%NO se devolvió el crédito, era de un pago anulado%'
     and exists (select 1 from notifications where target_user_id = v_user and created_at = now() and title = 'Clase cancelada'
                 and body = format('La clase del %s se canceló. Ese crédito no se reintegró porque pertenecía a un pago anulado. Consultá con el gimnasio.', to_char(v_base + 8, 'DD/MM/YYYY')))
     and (select remaining_credits from user_credits where id = l1) = 7 then
    ok := ok + 1; informe := informe || E'\nOK     S9 clase del día: pago anulado en no_reintegrados, texto exacto al socio';
  else informe := informe || E'\nFALLA  S9 clase del día (anulado): ' || r::text; end if;

  -- ── S10. admin_cancelar_clase_dia VIEJA (int): sigue devolviendo la cantidad, no miente ─
  v_int := admin_cancelar_clase_dia(v_clase3, v_base + 9);
  total := total + 1;
  if v_int = 1 and (select remaining_credits from user_credits where id = l1) = 8
     and exists (select 1 from notifications where target_user_id = v_user and created_at = now() and title = 'Clase cancelada'
                 and body like format('%%del %s fue cancelada por el gimnasio. Te devolvimos el crédito%%', to_char(v_base + 9, 'DD/MM/YYYY'))) then
    ok := ok + 1; informe := informe || E'\nOK     S10 admin_cancelar_clase_dia (vieja) devuelve 1 y usa las reglas nuevas';
  else informe := informe || E'\nFALLA  S10 vieja clase del día: ' || coalesce(v_int::text, 'null'); end if;

  -- ── S11. admin_cancel_booking forzado: misma respuesta (boolean), reglas nuevas, sin notificar
  select count(*) into v_notifs_antes from notifications where target_user_id = v_user and created_at = now();
  v_bool := admin_cancel_booking(v_user, v_clase, v_base + 10, 'prueba', true);
  total := total + 1;
  if v_bool = true and (select remaining_credits from user_credits where id = l1) = 9
     and (select count(*) from notifications where target_user_id = v_user and created_at = now()) = v_notifs_antes then
    ok := ok + 1; informe := informe || E'\nOK     S11 admin_cancel_booking forzado: devuelve true, lote vencido -> +1 a l1, no notifica';
  else informe := informe || E'\nFALLA  S11 admin_cancel_booking forzado'; end if;

  -- ── S12. admin_cancel_booking SIN forzar: exactamente como producción ───────────────────
  v_bool := admin_cancel_booking(v_user, v_clase, v_base + 11, 'prueba', false); -- lote vencido: no devuelve
  v_bool := admin_cancel_booking(v_user, v_clase, v_base + 12, 'prueba', false); -- lote vigente, dentro del límite: +1
  total := total + 1;
  if (select remaining_credits from user_credits where id = l1) = 10
     and (select remaining_credits from user_credits where id = l4) = 0 then
    ok := ok + 1; informe := informe || E'\nOK     S12 admin_cancel_booking sin forzar: igual que producción';
  else informe := informe || E'\nFALLA  S12 admin_cancel_booking sin forzar'; end if;

  -- ── S13. Un socio (no admin) no puede quitar a nadie ───────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  total := total + 1;
  begin
    r := admin_quitar_de_clase(v_user, v_clase, v_base + 13, 'prueba');
    informe := informe || E'\nFALLA  S13 un no-admin pudo usar admin_quitar_de_clase';
  exception when others then
    if sqlerrm like '%permisos de administrador%' and exists (select 1 from bookings where class_id = v_clase and booking_date = v_base + 13) then
      ok := ok + 1; informe := informe || E'\nOK     S13 no-admin rechazado, la reserva sigue';
    else informe := informe || E'\nFALLA  S13 error inesperado: ' || sqlerrm; end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);

  -- ── S17. Aparatos con acceso vigente: no se toca nada y el aviso dice hasta cuándo ──
  r := admin_quitar_de_clase(v_user, v_clase_ap, v_base + 14, 'prueba');
  v_txt := format('El gimnasio te quitó de PRUEBA APARATOS de las 23:00 del %s. %s no usa créditos: tu acceso sigue igual hasta el %s.',
                  to_char(v_base + 14, 'DD/MM/YYYY'), v_nombre_ap,
                  to_char(((select expires_at from user_credits where id = la) at time zone c_zona)::date, 'DD/MM/YYYY'));
  total := total + 1;
  if r->>'motivo' = 'aparatos_sin_creditos' and not (r->>'reintegrado')::boolean
     and r->>'mensaje_socio' = v_txt
     and r->>'mensaje_admin' like '%no usa créditos, no había nada que devolver; su acceso sigue igual hasta el%'
     and (select remaining_credits is null and expires_at > now() + interval '14 days' from user_credits where id = la)
     and exists (select 1 from notifications where target_user_id = v_user and created_at = now() and body = v_txt) then
    ok := ok + 1; informe := informe || E'\nOK     S17 Aparatos con acceso: no se suma nada, aviso con la fecha de acceso';
  else informe := informe || E'\nFALLA  S17 Aparatos con acceso: ' || r::text; end if;

  -- ── S18. Aparatos sin acceso vigente (clase del día): lo dice, y va aparte del resumen ──
  r := admin_cancelar_clase_dia_v2(v_clase_ap2, v_base + 15);
  total := total + 1;
  if (r->>'cancelados')::int = 1 and (r->>'reintegrados')::int = 0
     and jsonb_array_length(r->'no_reintegrados') = 0 and jsonb_array_length(r->'aparatos') = 1
     and r->'aparatos'->0->>'mensaje_socio' = format('PRUEBA APARATOS 2 de las 23:00 del %s fue cancelada por el gimnasio. %s no usa créditos y hoy no tenés acceso vigente a %s. Consultá con el gimnasio.',
                                                    to_char(v_base + 15, 'DD/MM/YYYY'), v_nombre_ap2, v_nombre_ap2)
     and r->'aparatos'->0->>'mensaje_admin' like '%no tiene acceso vigente a%'
     and not exists (select 1 from user_credits where user_id = v_user and discipline_id = v_disc_ap2) then
    ok := ok + 1; informe := informe || E'\nOK     S18 Aparatos sin acceso: lo dice, no crea nada, aparte de no_reintegrados';
  else informe := informe || E'\nFALLA  S18 Aparatos sin acceso: ' || r::text; end if;

  -- ── S14. Permisos ───────────────────────────────────────────────────────────────────────
  total := total + 1;
  if not has_function_privilege('anon', 'public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)', 'execute')
     and not has_function_privilege('authenticated', 'public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)', 'execute')
     and (select proacl is not null from pg_proc where oid = 'public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)'::regprocedure)
     and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                     where p.oid = 'public._cancelar_reserva_por_gimnasio(uuid, uuid, date, text, text)'::regprocedure and a.grantee = 0)
     and has_function_privilege('authenticated', 'public.admin_quitar_de_clase(uuid, uuid, date, text)', 'execute')
     and has_function_privilege('authenticated', 'public.admin_cancelar_clase_dia_v2(uuid, date)', 'execute')
     and not has_function_privilege('anon', 'public.admin_quitar_de_clase(uuid, uuid, date, text)', 'execute')
     and not has_function_privilege('anon', 'public.admin_cancelar_clase_dia_v2(uuid, date)', 'execute')
     and has_function_privilege('authenticated', 'public.admin_cancel_booking(uuid, uuid, date, text, boolean)', 'execute')
     and has_function_privilege('authenticated', 'public.admin_cancelar_clase_dia(uuid, date)', 'execute') then
    ok := ok + 1; informe := informe || E'\nOK     S14 permisos: interna sin EXECUTE (public/anon/authenticated); admin_* con authenticated';
  else informe := informe || E'\nFALLA  S14 permisos'; end if;

  -- ── S15. cancel_booking (PWA) sin cambios ──────────────────────────────────────────────
  select md5(pg_get_functiondef(oid)) into v_txt from pg_proc where proname = 'cancel_booking';
  total := total + 1;
  if v_txt = 'afcc5c25de7f16c3f5a657254c9937ba' then
    ok := ok + 1; informe := informe || E'\nOK     S15 cancel_booking igual (md5 afcc5c25...)';
  else informe := informe || E'\nFALLA  S15 cancel_booking cambió: ' || coalesce(v_txt, 'null'); end if;

  -- ── S16. Los créditos REALES de la cuenta de test no cambiaron ────────────────────────
  select coalesce(md5(string_agg(id::text || ':' || coalesce(remaining_credits, -1) || ':' || coalesce(expires_at::text, ''), ',' order by id)), '-')
    into v_huella_real_despues
  from user_credits where user_id = v_user and id not in (l1, l2, l3, l4, l6, la);
  total := total + 1;
  if v_huella_real_despues = v_huella_real_antes then
    ok := ok + 1; informe := informe || E'\nOK     S16 créditos reales de la cuenta de test intactos';
  else informe := informe || E'\nFALLA  S16 cambiaron créditos reales'; end if;

  -- ── Fin: SIEMPRE con error, para deshacer todo. ───────────────────────────────────────
  raise exception 'PRUEBA TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
