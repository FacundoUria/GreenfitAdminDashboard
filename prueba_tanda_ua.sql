-- =====================================================================================
-- PRUEBA de Tanda UA (supabase_migration_tanda_ua_user_id_ajeno.sql). Correr DESPUÉS.
-- Cuenta de test DNI 44537978 (tiene que ser socio activo).
--
-- NO DEJA NADA EN LA BASE: los casos van en una subtransacción que se deshace SIEMPRE; las
-- llamadas como socio, admin o service_role van cada una en su propia subtransacción (también
-- el "set local role"). Solo crean filas PROPIAS: una disciplina oculta e inactiva, una clase,
-- un lote de créditos de prueba, un post y un comentario "PRUEBA UA", un DM de prueba y un pago
-- 'prueba-tanda-ua-...' (paquete 'PRUEBA TANDA UA'). Los perfiles reales solo se LEEN (como
-- autores o destinatarios). Lo único que sobrevive es el log (tabla temporal de la sesión).
--
-- Cómo llega cada uno en la vida real, y cómo se simula acá:
--   PWA    -> rol authenticated + JWT del socio de test.
--   Admin  -> rol authenticated + JWT del primer admin de profiles.
--   Webhook-> JWT con role service_role (Edge Function mp-webhook -> mp_process_payment).
--
-- CASOS
--   (p)  Permisos: esta_habilitado (anon no, authenticated y service_role sí); resolver (anon
--        no, authenticated NO, service_role sí); community_author_names (anon no, authenticated sí).
--   esta_habilitado_para_disciplina:
--   (a1) PWA: el socio de test pregunta por sí mismo -> anda.
--   (a2) El socio de test pregunta por OTRO socio -> 42501 "No autorizado".
--   (a3) Admin (ficha del socio) pregunta por otro -> anda.
--   (a4) Webhook (service_role) pregunta por otro -> anda.
--   (a5) Conexión directa sin JWT (SQL Editor) pregunta por otro -> anda.
--   (a6) PWA reservas: book_class del socio de test -> reserva.
--   (a7) Admin: admin_book_class para el socio de test -> reserva.
--   resolver_fecha_plan_actual:
--   (b1) El socio de test la llama directo -> 42501 (sin permiso).
--   (b2) Webhook: mp_process_payment pending -> approved con un pack activo -> acredita
--        (pagos_socio 'pagado', credito_otorgado = true).
--   community_author_names:
--   (c1) PWA Comunidad: el socio de test pide [autor de un post, autor de un comentario, un
--        socio que no es autor, él mismo] -> devuelve los tres que corresponden, no el otro.
--   (c2) PWA mensajes: con un DM abierto con ese socio que no es autor -> ahora sí lo devuelve.
--   (c3) Admin Comunidad: pide [autor, no autor] -> solo el autor.
--   (c4) Un socio no activo pide nombres -> 0 filas, sin error (SALTEADO si no hay ninguno).
--   (z)  No quedó nada.
-- Resultado esperado: 15 OK, 0 FALLA (o 14 OK y 1 SALTEADO).
-- =====================================================================================
begin;

drop table if exists pg_temp._log;
create temp table _log (n bigserial primary key, caso text, linea text);

do $prueba$
declare
  c_fin       constant text := 'FIN_CASOS_UA';
  c_deshacer  constant text := 'DESHACER_CASO_UA';
  c_paquete   constant text := 'PRUEBA TANDA UA';
  c_hab       constant text := 'public.esta_habilitado_para_disciplina(uuid, uuid)';
  c_res       constant text := 'public.resolver_fecha_plan_actual(uuid)';
  c_aut       constant text := 'public.community_author_names(uuid[])';
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_user uuid; v_admin uuid; v_otro uuid; v_tercero uuid; v_no_autor uuid; v_inactivo uuid;
  v_socio jsonb; v_jwt_admin jsonb; v_jwt_srv jsonb;
  v_disc uuid; v_clase uuid; v_post uuid; v_fecha date; v_vence timestamptz;
  v_aparatos uuid; v_pack record;
  v_mp_id text; v_otorgado boolean; v_estado text;
  r record;
  v_ok boolean; v_txt text; v_esperado text;
  v_huella_antes text; v_huella_despues text;
  -- El log se junta en arrays (ok null = SALTEADO): sobreviven a la subtransacción.
  v_casos text[] := '{}'; v_oks boolean[] := '{}'; v_textos text[] := '{}';
begin
  -- ── Preparación (fuera de la subtransacción) ──────────────────────────────────────
  if to_regclass('respaldo.tanda_ua_funciones') is null then
    raise exception 'Falta correr supabase_migration_tanda_ua_user_id_ajeno.sql';
  end if;
  select id into v_user from profiles where dni = '44537978';
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  if not exists (select 1 from profiles where id = v_user and role = 'socio' and active = true) then
    raise exception 'La cuenta de test (DNI 44537978) no es socio activo: los casos de Comunidad no aplicarían.';
  end if;
  select id into v_admin from profiles where role = 'admin' order by created_at limit 1;
  select id into v_otro from profiles
  where role = 'socio' and id not in (v_user, v_admin) order by created_at limit 1;
  select id into v_tercero from profiles
  where role = 'socio' and id not in (v_user, v_admin, v_otro) order by created_at limit 1;
  -- Un socio que NO es autor de nada y no tiene DM ni con el de test ni con el admin.
  select p.id into v_no_autor from profiles p
  where p.role = 'socio' and p.id not in (v_user, v_admin, v_otro, v_tercero)
    and not exists (select 1 from community_posts x where x.author_id = p.id)
    and not exists (select 1 from community_comments x where x.author_id = p.id)
    and not exists (select 1 from community_dm_threads t
                    where (t.user_a = p.id and t.user_b in (v_user, v_admin))
                       or (t.user_b = p.id and t.user_a in (v_user, v_admin)))
  order by p.created_at limit 1;
  select id into v_inactivo from profiles
  where role = 'socio' and active is not true and id not in (v_user, v_otro, v_tercero, v_no_autor)
  order by created_at limit 1;
  if v_admin is null or v_otro is null or v_tercero is null or v_no_autor is null then
    raise exception 'Faltan perfiles para la prueba (admin %, otro %, tercero %, no autor %).', v_admin, v_otro, v_tercero, v_no_autor;
  end if;

  v_socio     := jsonb_build_object('sub', v_user,  'role', 'authenticated');
  v_jwt_admin := jsonb_build_object('sub', v_admin, 'role', 'authenticated');
  v_jwt_srv   := jsonb_build_object('role', 'service_role');

  -- Un día futuro abierto para reservar (Tanda RP rechaza días cerrados).
  select min(g.d)::date into v_fecha
  from generate_series(v_hoy + 3, v_hoy + 60, interval '1 day') g(d)
  where not exists (select 1 from closed_days cd where cd.fecha = g.d::date);
  -- Lote de prueba: mismo vencimiento que el plan vigente de la cuenta de test (candado T7), o 40 días.
  select coalesce(max(uc.expires_at), now() + interval '40 days') into v_vence
  from user_credits uc
  where uc.user_id = v_user and uc.expires_at > now() and (uc.remaining_credits > 0 or uc.remaining_credits is null);
  -- Para el webhook: lo mismo que usó la prueba de Tanda MP.
  select id into v_aparatos from disciplines where kind = 'membership' order by id limit 1;
  select id, name, price, creditos, incluye_aparatos, dias_vigencia into v_pack
  from packs where is_active is distinct from false order by id limit 1;

  -- Huella de lo real que esto puede tocar.
  select md5(coalesce((select string_agg(concat_ws(':', id, class_id, booking_date, credit_lote_id), ',' order by id)
                       from bookings where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                                 from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select count(*)::text from xp_events where user_id = v_user), '-')
             || '|' || coalesce((select count(*)::text from pagos_socio
                                 where paquete = c_paquete or mercado_pago_payment_id like 'prueba-tanda-ua-%'), '-')
             || '|' || coalesce((select count(*)::text from community_dm_threads
                                 where v_user in (user_a, user_b)), '-'))
    into v_huella_antes;

  -- ── (p) Permisos ────────────────────────────────────────────────────────────────────
  v_ok := not has_function_privilege('anon', c_hab, 'EXECUTE')
          and has_function_privilege('authenticated', c_hab, 'EXECUTE')
          and has_function_privilege('service_role', c_hab, 'EXECUTE')
          and not has_function_privilege('anon', c_res, 'EXECUTE')
          and not has_function_privilege('authenticated', c_res, 'EXECUTE')
          and has_function_privilege('service_role', c_res, 'EXECUTE')
          and not has_function_privilege('anon', c_aut, 'EXECUTE')
          and has_function_privilege('authenticated', c_aut, 'EXECUTE');
  v_txt := format('esta_habilitado: anon %s, authenticated %s, service_role %s / resolver: anon %s, authenticated %s, service_role %s / author_names: anon %s, authenticated %s',
    has_function_privilege('anon', c_hab, 'EXECUTE'), has_function_privilege('authenticated', c_hab, 'EXECUTE'),
    has_function_privilege('service_role', c_hab, 'EXECUTE'), has_function_privilege('anon', c_res, 'EXECUTE'),
    has_function_privilege('authenticated', c_res, 'EXECUTE'), has_function_privilege('service_role', c_res, 'EXECUTE'),
    has_function_privilege('anon', c_aut, 'EXECUTE'), has_function_privilege('authenticated', c_aut, 'EXECUTE'));
  v_casos := v_casos || 'p'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

  -- ── Casos: subtransacción que se deshace al final ─────────────────────────────────
  begin
    -- Llama p_sql con el rol p_rol (null = sin cambiar de rol) y el JWT p_claims (null = sin
    -- JWT), en una subtransacción que se deshace siempre. resultado: 'anda' o el SQLSTATE.
    create function pg_temp.ua_llamar(p_rol text, p_claims jsonb, p_sql text, out resultado text, out valor text)
    language plpgsql as $f$
    begin
      begin
        if p_rol is not null then
          execute format('set local role %I', p_rol);
        end if;
        perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
        execute p_sql into valor;
        resultado := 'anda';
        raise exception 'DESHACER' using errcode = 'P0999';
      exception
        when sqlstate 'P0999' then null;
        when others then
          get stacked diagnostics resultado = returned_sqlstate, valor = message_text;
      end;
    end $f$;

    create function pg_temp.ua_txt(p_resultado text, p_valor text) returns text
    language sql immutable as $f$
      select case when p_resultado = 'anda' then 'anduvo, devolvió ' || coalesce(p_valor, '(nada)')
                  else format('error %s: %s', p_resultado, p_valor) end
    $f$;

    -- Datos propios de la prueba.
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA UA ' || gen_random_uuid(), 'credits', false, false)
    returning id into v_disc;
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (v_user, v_disc, 20, v_vence);
    insert into classes (title, discipline_id, instructor, capacity, days_of_week, start_time, end_time)
    values ('PRUEBA UA ' || gen_random_uuid(), v_disc, null, 10, array[0, 1, 2, 3, 4, 5, 6], '10:00', '11:00')
    returning id into v_clase;
    insert into community_posts (author_id, body) values (v_otro, 'PRUEBA UA') returning id into v_post;
    insert into community_comments (post_id, author_id, body) values (v_post, v_tercero, 'PRUEBA UA');

    -- (a1) PWA: por sí mismo.
    select * into r from pg_temp.ua_llamar('authenticated', v_socio,
      format('select public.esta_habilitado_para_disciplina(%L, %L)::text', v_user, v_disc));
    v_casos := v_casos || 'a1'::text; v_oks := v_oks || (r.resultado = 'anda');
    v_textos := v_textos || ('socio de test, su propio id -> ' || pg_temp.ua_txt(r.resultado, r.valor));

    -- (a2) Por otro socio.
    select * into r from pg_temp.ua_llamar('authenticated', v_socio,
      format('select public.esta_habilitado_para_disciplina(%L, %L)::text', v_otro, v_disc));
    v_casos := v_casos || 'a2'::text; v_oks := v_oks || (r.resultado = '42501' and r.valor like 'No autorizado%');
    v_textos := v_textos || ('socio de test, id de otro socio -> ' || pg_temp.ua_txt(r.resultado, r.valor));

    -- (a3) Admin (ficha del socio).
    select * into r from pg_temp.ua_llamar('authenticated', v_jwt_admin,
      format('select public.esta_habilitado_para_disciplina(%L, %L)::text', v_otro, v_disc));
    v_casos := v_casos || 'a3'::text; v_oks := v_oks || (r.resultado = 'anda');
    v_textos := v_textos || ('admin, id de otro socio -> ' || pg_temp.ua_txt(r.resultado, r.valor));

    -- (a4) Webhook (service_role).
    select * into r from pg_temp.ua_llamar(null, v_jwt_srv,
      format('select public.esta_habilitado_para_disciplina(%L, %L)::text', v_otro, v_disc));
    v_casos := v_casos || 'a4'::text; v_oks := v_oks || (r.resultado = 'anda');
    v_textos := v_textos || ('service_role, id de otro socio -> ' || pg_temp.ua_txt(r.resultado, r.valor));

    -- (a5) Conexión directa sin JWT.
    select * into r from pg_temp.ua_llamar(null, null,
      format('select public.esta_habilitado_para_disciplina(%L, %L)::text', v_otro, v_disc));
    v_casos := v_casos || 'a5'::text; v_oks := v_oks || (r.resultado = 'anda');
    v_textos := v_textos || ('sin JWT (SQL Editor), id de otro socio -> ' || pg_temp.ua_txt(r.resultado, r.valor));

    -- (a6) PWA reservas.
    select * into r from pg_temp.ua_llamar('authenticated', v_socio,
      format('select public.book_class(%L, %L)::text', v_clase, v_fecha));
    v_casos := v_casos || 'a6'::text; v_oks := v_oks || (r.resultado = 'anda');
    v_textos := v_textos || (format('PWA: book_class del socio de test para el %s -> ', to_char(v_fecha, 'DD/MM'))
                             || pg_temp.ua_txt(r.resultado, r.valor));

    -- (a7) Admin anota al socio de test.
    select * into r from pg_temp.ua_llamar('authenticated', v_jwt_admin,
      format('select public.admin_book_class(%L, %L, %L)::text', v_user, v_clase, v_fecha));
    v_casos := v_casos || 'a7'::text; v_oks := v_oks || (r.resultado = 'anda');
    v_textos := v_textos || ('Admin: admin_book_class para el socio de test -> ' || pg_temp.ua_txt(r.resultado, r.valor));

    -- (b1) resolver_fecha_plan_actual directo, como socio.
    select * into r from pg_temp.ua_llamar('authenticated', v_socio,
      format('select public.resolver_fecha_plan_actual(%L)::text', v_user));
    v_casos := v_casos || 'b1'::text; v_oks := v_oks || (r.resultado = '42501' and r.valor like 'permission denied%');
    v_textos := v_textos || ('socio de test llama resolver_fecha_plan_actual -> ' || pg_temp.ua_txt(r.resultado, r.valor));

    -- (b2) Webhook: mp_process_payment pending -> approved, con JWT de service_role.
    v_ok := false; v_txt := null;
    begin
      if v_pack.id is null then
        raise exception 'no hay ningún pack activo para probar la acreditación';
      end if;
      v_mp_id := 'prueba-tanda-ua-' || gen_random_uuid()::text;
      perform set_config('request.jwt.claims', v_jwt_srv::text, true);
      perform public.mp_process_payment(v_user, v_pack.id, coalesce(v_pack.creditos::jsonb, '[]'::jsonb),
                                        coalesce(v_pack.incluye_aparatos, false), v_pack.dias_vigencia,
                                        case when v_pack.incluye_aparatos then v_aparatos end,
                                        v_pack.price, c_paquete, v_mp_id, 'pending');
      select credito_otorgado into v_otorgado
      from public.mp_process_payment(v_user, v_pack.id, coalesce(v_pack.creditos::jsonb, '[]'::jsonb),
                                     coalesce(v_pack.incluye_aparatos, false), v_pack.dias_vigencia,
                                     case when v_pack.incluye_aparatos then v_aparatos end,
                                     v_pack.price, c_paquete, v_mp_id, 'approved');
      select estado into v_estado from pagos_socio where mercado_pago_payment_id = v_mp_id;
      v_ok := v_otorgado is true and v_estado = 'pagado';
      v_txt := format('webhook (service_role): pack "%s" pending -> approved: estado %s, otorgado %s',
                      v_pack.name, coalesce(v_estado, 'null'), coalesce(v_otorgado::text, 'null'));
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm <> c_deshacer then
        v_ok := false; v_txt := 'webhook: error ' || sqlerrm;
      end if;
    end;
    v_casos := v_casos || 'b2'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (c1) PWA Comunidad: autor de post, autor de comentario, no autor, él mismo.
    select string_agg(x::text, ',' order by x) into v_esperado from unnest(array[v_otro, v_tercero, v_user]) x;
    select * into r from pg_temp.ua_llamar('authenticated', v_socio,
      format('select string_agg(id::text, '','' order by id) from public.community_author_names(%L::uuid[])',
             array[v_otro, v_tercero, v_no_autor, v_user]::text));
    v_casos := v_casos || 'c1'::text; v_oks := v_oks || (r.resultado = 'anda' and r.valor = v_esperado);
    v_textos := v_textos || ('socio de test pide [autor de post, autor de comentario, no autor, él mismo] -> '
      || case when r.resultado = 'anda' and r.valor = v_esperado then 'los 3 que corresponden, sin el no autor'
              else pg_temp.ua_txt(r.resultado, r.valor) || ' (se esperaba ' || v_esperado || ')' end);

    -- (c2) PWA mensajes: con un DM abierto con el no autor, ahora sí.
    v_ok := false; v_txt := null;
    begin
      insert into community_dm_threads (user_a, user_b) values (v_user, v_no_autor);
      select * into r from pg_temp.ua_llamar('authenticated', v_socio,
        format('select string_agg(id::text, '','' order by id) from public.community_author_names(%L::uuid[])',
               array[v_no_autor]::text));
      v_ok := r.resultado = 'anda' and r.valor = v_no_autor::text;
      v_txt := 'con un DM abierto, el socio de test pide al no autor -> '
        || case when v_ok then 'lo devuelve' else pg_temp.ua_txt(r.resultado, r.valor) end;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm <> c_deshacer then
        v_ok := false; v_txt := 'DM: error ' || sqlerrm;
      end if;
    end;
    v_casos := v_casos || 'c2'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (c3) Admin Comunidad: autor y no autor.
    select * into r from pg_temp.ua_llamar('authenticated', v_jwt_admin,
      format('select string_agg(id::text, '','' order by id) from public.community_author_names(%L::uuid[])',
             array[v_otro, v_no_autor]::text));
    v_casos := v_casos || 'c3'::text; v_oks := v_oks || (r.resultado = 'anda' and r.valor = v_otro::text);
    v_textos := v_textos || ('admin pide [autor, no autor] -> '
      || case when r.resultado = 'anda' and r.valor = v_otro::text then 'solo el autor'
              else pg_temp.ua_txt(r.resultado, r.valor) end);

    -- (c4) Socio no activo.
    if v_inactivo is null then
      v_casos := v_casos || 'c4'::text; v_oks := v_oks || null::boolean;
      v_textos := v_textos || 'no hay ningún socio no activo para probar'::text;
    else
      select * into r from pg_temp.ua_llamar('authenticated', jsonb_build_object('sub', v_inactivo, 'role', 'authenticated'),
        format('select string_agg(id::text, '','' order by id) from public.community_author_names(%L::uuid[])',
               array[v_otro, v_user]::text));
      v_casos := v_casos || 'c4'::text; v_oks := v_oks || (r.resultado = 'anda' and r.valor is null);
      v_textos := v_textos || ('socio no activo pide [autor, otro] -> '
        || case when r.resultado = 'anda' and r.valor is null then '0 filas, sin error'
                else pg_temp.ua_txt(r.resultado, r.valor) end);
    end if;

    raise exception '%', c_fin;
  exception when others then
    if sqlerrm <> c_fin then
      v_casos := v_casos || '!'::text; v_oks := v_oks || false;
      v_textos := v_textos || ('ERROR inesperado preparando los casos: ' || sqlerrm);
    end if;
  end;

  -- ── (z) Ya deshecha la subtransacción: no quedó nada ───────────────────────────────
  select md5(coalesce((select string_agg(concat_ws(':', id, class_id, booking_date, credit_lote_id), ',' order by id)
                       from bookings where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                                 from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select count(*)::text from xp_events where user_id = v_user), '-')
             || '|' || coalesce((select count(*)::text from pagos_socio
                                 where paquete = c_paquete or mercado_pago_payment_id like 'prueba-tanda-ua-%'), '-')
             || '|' || coalesce((select count(*)::text from community_dm_threads
                                 where v_user in (user_a, user_b)), '-'))
    into v_huella_despues;
  v_ok := v_huella_despues = v_huella_antes
          and not exists (select 1 from classes where title like 'PRUEBA UA %')
          and not exists (select 1 from disciplines where name like 'PRUEBA UA %')
          and not exists (select 1 from community_posts where body = 'PRUEBA UA')
          and not exists (select 1 from community_comments where body = 'PRUEBA UA')
          and to_regprocedure('pg_temp.ua_llamar(text, jsonb, text)') is null;
  v_casos := v_casos || 'z'::text; v_oks := v_oks || v_ok;
  v_textos := v_textos || case when v_ok
    then 'reservas, lotes, XP, pagos y DMs de la cuenta de test iguales; no quedó ninguna clase, disciplina, post ni comentario de prueba'
    else 'QUEDÓ ALGO de la prueba o cambió algo real de la cuenta de test' end;

  insert into pg_temp._log (caso, linea)
  select u.caso,
         case when u.ok is null then 'SALTEADO  ' when u.ok then 'OK        ' else 'FALLA     ' end
         || '(' || u.caso || ') ' || u.texto
  from unnest(v_casos, v_oks, v_textos) with ordinality as u(caso, ok, texto, i)
  order by u.i;
end;
$prueba$;

insert into _log (caso, linea)
select 'RESUMEN', format('%s OK, %s FALLA, %s SALTEADO',
  count(*) filter (where linea like 'OK%'), count(*) filter (where linea like 'FALLA%'),
  count(*) filter (where linea like 'SALTEADO%'))
from _log;

commit;

select caso, linea from pg_temp._log order by n;
