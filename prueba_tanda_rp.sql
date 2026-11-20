-- =====================================================================================
-- PRUEBA de Tanda RP (supabase_migration_tanda_rp_book_class_pasado.sql). Correr DESPUÉS.
-- Cuenta de test DNI 44537978. Correrla entre las 02:00 y las 21:00 de Argentina (arma
-- clases de hoy a pocos minutos u horas de ahora, dentro del mismo día).
--
-- NO DEJA NADA EN LA BASE: los casos van en una subtransacción que se deshace SIEMPRE. Solo
-- crean filas PROPIAS (una disciplina oculta e inactiva, clases "PRUEBA RP ...", un lote de
-- créditos de prueba, un día cerrado de prueba y reservas en esas clases). Ninguna fila real
-- se actualiza ni se borra. El caso (z) lo confirma. Lo único que sobrevive es el log
-- (tabla temporal de la sesión).
-- La sesión simulada es la del socio de test (book_class) o la del primer admin de profiles
-- (admin_book_class), con request.jwt.claims local a esta transacción.
-- El lote de prueba vence el mismo día que el plan vigente de la cuenta de test (si tiene),
-- para no armarle dos fechas ni por un momento (candado T7).
--
-- CASOS
--   (a) Permisos de book_class: anon no puede, authenticated sí (no cambiaron).
--   (b) Hoy, clase que empieza en 2 horas -> book_class reserva.
--   (c) Hoy, clase que empezó hace 5 minutos -> 'Esta clase ya empezó: no se puede reservar.'
--   (d) Hoy, clase que empieza en 2 minutos -> reserva (todavía no empezó).
--   (e) Ayer y hace 7 días -> 'No se puede reservar una fecha que ya pasó.'
--   (f) Día cerrado -> 'El gimnasio está cerrado ese día.'; el día abierto siguiente reserva.
--   (g) admin_book_class (Seba) en los tres casos frenados (ya empezada, ayer, día cerrado)
--       -> reserva los tres: sin límite.
--   (h) Lo de antes sigue igual: un día en que la clase no se dicta -> 'Esta clase no se
--       dicta ese día.'
--   (z) No quedó nada: reservas, lotes y XP de la cuenta de test y closed_days iguales que
--       antes; ninguna clase ni disciplina de prueba.
-- Resultado esperado: 9 OK, 0 FALLA.
-- =====================================================================================
begin;

drop table if exists pg_temp._log;
create temp table _log (n bigserial primary key, caso text, linea text);

do $prueba$
declare
  c_fin      constant text := 'FIN_CASOS_RP';
  c_empezo   constant text := 'Esta clase ya empezó: no se puede reservar.';
  c_paso     constant text := 'No se puede reservar una fecha que ya pasó.';
  c_cerrado  constant text := 'El gimnasio está cerrado ese día.';
  c_no_dicta constant text := 'Esta clase no se dicta ese día.';
  c_todos    constant int[] := array[0, 1, 2, 3, 4, 5, 6];
  v_user  uuid;
  v_admin uuid;
  v_ahora_ar timestamp := now() at time zone 'America/Argentina/Mendoza';
  v_hoy   date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_vence timestamptz;
  v_cerrado date;
  v_abierto date;
  v_libre date;
  v_huella_antes text;
  v_huella_despues text;
  v_disc uuid;
  v_c uuid; v_c2 uuid; v_c3 uuid;
  r1 text; r2 text; r3 text;
  v_ok boolean;
  v_txt text;
  -- El log se junta en arrays: las variables sobreviven a la subtransacción que se deshace.
  v_casos  text[]    := '{}';
  v_oks    boolean[] := '{}';
  v_textos text[]    := '{}';
begin
  -- ── Preparación (fuera de la subtransacción) ──────────────────────────────────────
  if to_regclass('respaldo.tanda_rp_funciones') is null then
    raise exception 'Falta correr supabase_migration_tanda_rp_book_class_pasado.sql';
  end if;
  select id into v_user from profiles where dni = '44537978';
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  select id into v_admin from profiles where role = 'admin' order by created_at limit 1;
  if v_admin is null then
    raise exception 'No hay ningún perfil admin.';
  end if;
  if v_ahora_ar::time < time '02:00' or v_ahora_ar::time > time '21:00' then
    raise exception 'Correla entre las 02:00 y las 21:00 de Argentina (ahora son las %).', to_char(v_ahora_ar, 'HH24:MI');
  end if;
  if exists (select 1 from closed_days where fecha = v_hoy) then
    raise exception 'Hoy es un día cerrado en closed_days: los casos de "hoy" darían "cerrado". Correla otro día.';
  end if;

  -- Vencimiento del lote de prueba: el del plan vigente de la cuenta de test, o 40 días.
  select coalesce(max(uc.expires_at), now() + interval '40 days') into v_vence
  from user_credits uc
  where uc.user_id = v_user and uc.expires_at > now()
    and (uc.remaining_credits > 0 or uc.remaining_credits is null);

  -- Día cerrado de prueba: el primero libre desde hoy + 20; y el siguiente día libre.
  select min(g.d)::date into v_cerrado
  from generate_series(v_hoy + 20, v_hoy + 80, interval '1 day') g(d)
  where not exists (select 1 from closed_days cd where cd.fecha = g.d::date);
  select min(g.d)::date into v_abierto
  from generate_series(v_cerrado + 1, v_cerrado + 60, interval '1 day') g(d)
  where not exists (select 1 from closed_days cd where cd.fecha = g.d::date);
  -- Para (h): un día futuro que no esté cerrado (si no, la regla nueva frenaría antes).
  select min(g.d)::date into v_libre
  from generate_series(v_hoy + 2, v_hoy + 60, interval '1 day') g(d)
  where not exists (select 1 from closed_days cd where cd.fecha = g.d::date);

  -- Huella de lo real que esto puede tocar: reservas, lotes y XP de la cuenta de test, y closed_days.
  select md5(coalesce((select string_agg(concat_ws(':', id, class_id, booking_date, credit_lote_id), ',' order by id)
                       from bookings where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                                 from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select count(*)::text from xp_events where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', fecha, motivo), ',' order by fecha)
                                 from closed_days), '-'))
    into v_huella_antes;

  -- ── (a) Permisos ────────────────────────────────────────────────────────────────────
  v_ok := not has_function_privilege('anon', 'public.book_class(uuid, date)', 'EXECUTE')
          and has_function_privilege('authenticated', 'public.book_class(uuid, date)', 'EXECUTE');
  v_casos := v_casos || 'a'::text; v_oks := v_oks || v_ok;
  v_textos := v_textos || ('book_class -> anon '
    || case when has_function_privilege('anon', 'public.book_class(uuid, date)', 'EXECUTE') then 'PUEDE' else 'no puede' end
    || ', authenticated '
    || case when has_function_privilege('authenticated', 'public.book_class(uuid, date)', 'EXECUTE') then 'puede' else 'NO PUEDE' end);

  -- ── Casos: subtransacción que se deshace al final ─────────────────────────────────
  begin
    create function pg_temp.rp_como(p_id uuid) returns void language sql as $f$
      select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true),
             set_config('request.jwt.claim.sub', p_id::text, true);
      select null::void;
    $f$;

    create function pg_temp.rp_clase(p_disc uuid, p_dias int[], p_hora time) returns uuid language sql as $f$
      insert into classes (title, discipline_id, instructor, capacity, days_of_week, start_time, end_time)
      values ('PRUEBA RP ' || gen_random_uuid(), p_disc, null, 10, p_dias, p_hora, p_hora + interval '30 minutes')
      returning id;
    $f$;

    -- Reserva como socio (book_class) o como admin (admin_book_class). Devuelve 'reservó' o el
    -- mensaje del error (cada intento en su propia subtransacción).
    create function pg_temp.rp_reservar(p_admin boolean, p_user uuid, p_class uuid, p_fecha date) returns text
    language plpgsql as $f$
    begin
      if p_admin then
        perform public.admin_book_class(p_user, p_class, p_fecha);
      else
        perform public.book_class(p_class, p_fecha);
      end if;
      return 'reservó';
    exception when others then
      return sqlerrm;
    end $f$;

    -- Disciplina de prueba (oculta e inactiva), un lote de prueba y el día cerrado de prueba.
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA RP ' || gen_random_uuid(), 'credits', false, false)
    returning id into v_disc;
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (v_user, v_disc, 20, v_vence);
    insert into closed_days (fecha, motivo) values (v_cerrado, 'PRUEBA RP');

    -- (b) Hoy, en 2 horas -> reserva.
    begin
      perform pg_temp.rp_como(v_user);
      v_c := pg_temp.rp_clase(v_disc, c_todos, (v_ahora_ar + interval '2 hours')::time);
      r1 := pg_temp.rp_reservar(false, v_user, v_c, v_hoy);
      v_ok := r1 = 'reservó'
              and exists (select 1 from bookings where user_id = v_user and class_id = v_c and booking_date = v_hoy);
      v_txt := 'hoy, clase en 2 horas -> ' || r1;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'b'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (c) Hoy, empezó hace 5 minutos -> rechazo.
    begin
      perform pg_temp.rp_como(v_user);
      v_c := pg_temp.rp_clase(v_disc, c_todos, (v_ahora_ar - interval '5 minutes')::time);
      r1 := pg_temp.rp_reservar(false, v_user, v_c, v_hoy);
      v_ok := r1 = c_empezo
              and not exists (select 1 from bookings where class_id = v_c);
      v_txt := 'hoy, clase que empezó hace 5 min -> ' || r1;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'c'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (d) Hoy, en 2 minutos -> reserva (todavía no empezó).
    begin
      perform pg_temp.rp_como(v_user);
      v_c := pg_temp.rp_clase(v_disc, c_todos, (v_ahora_ar + interval '2 minutes')::time);
      r1 := pg_temp.rp_reservar(false, v_user, v_c, v_hoy);
      v_ok := r1 = 'reservó';
      v_txt := 'hoy, clase en 2 min -> ' || r1;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'd'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (e) Ayer y hace 7 días -> rechazo.
    begin
      perform pg_temp.rp_como(v_user);
      v_c := pg_temp.rp_clase(v_disc, c_todos, time '10:00');
      r1 := pg_temp.rp_reservar(false, v_user, v_c, v_hoy - 1);
      r2 := pg_temp.rp_reservar(false, v_user, v_c, v_hoy - 7);
      v_ok := r1 = c_paso and r2 = c_paso and not exists (select 1 from bookings where class_id = v_c);
      v_txt := 'ayer -> ' || r1 || ' / hace 7 días -> ' || r2;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'e'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (f) Día cerrado -> rechazo; el día abierto siguiente -> reserva.
    begin
      perform pg_temp.rp_como(v_user);
      v_c := pg_temp.rp_clase(v_disc, c_todos, time '10:00');
      r1 := pg_temp.rp_reservar(false, v_user, v_c, v_cerrado);
      r2 := pg_temp.rp_reservar(false, v_user, v_c, v_abierto);
      v_ok := r1 = c_cerrado and r2 = 'reservó';
      v_txt := format('día cerrado (%s) -> %s / día abierto (%s) -> %s',
                      to_char(v_cerrado, 'DD/MM'), r1, to_char(v_abierto, 'DD/MM'), r2);
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'f'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (g) admin_book_class en los tres casos frenados -> reserva los tres.
    begin
      perform pg_temp.rp_como(v_admin);
      v_c  := pg_temp.rp_clase(v_disc, c_todos, (v_ahora_ar - interval '5 minutes')::time);
      v_c2 := pg_temp.rp_clase(v_disc, c_todos, time '10:00');
      v_c3 := pg_temp.rp_clase(v_disc, c_todos, time '10:00');
      r1 := pg_temp.rp_reservar(true, v_user, v_c, v_hoy);
      r2 := pg_temp.rp_reservar(true, v_user, v_c2, v_hoy - 1);
      r3 := pg_temp.rp_reservar(true, v_user, v_c3, v_cerrado);
      v_ok := r1 = 'reservó' and r2 = 'reservó' and r3 = 'reservó';
      v_txt := 'admin: ya empezada -> ' || r1 || ' / ayer -> ' || r2 || ' / día cerrado -> ' || r3;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'g'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (h) Lo de antes: un día en que la clase no se dicta -> el mensaje de siempre.
    begin
      perform pg_temp.rp_como(v_user);
      v_c := pg_temp.rp_clase(v_disc, array[extract(dow from v_libre - 1)::int], time '10:00');
      r1 := pg_temp.rp_reservar(false, v_user, v_c, v_libre);
      v_ok := r1 = c_no_dicta;
      v_txt := 'clase de otro día de la semana -> ' || r1;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'h'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

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
             || '|' || coalesce((select string_agg(concat_ws(':', fecha, motivo), ',' order by fecha)
                                 from closed_days), '-'))
    into v_huella_despues;
  v_ok := v_huella_despues = v_huella_antes
          and not exists (select 1 from classes where title like 'PRUEBA RP %')
          and not exists (select 1 from disciplines where name like 'PRUEBA RP %')
          and to_regprocedure('pg_temp.rp_reservar(boolean, uuid, uuid, date)') is null;
  v_casos := v_casos || 'z'::text; v_oks := v_oks || v_ok;
  v_textos := v_textos || case when v_ok
    then 'reservas, lotes y XP de la cuenta de test y closed_days iguales; no quedó ninguna clase ni disciplina de prueba'
    else 'QUEDÓ ALGO de la prueba o cambió algo real de la cuenta de test o de closed_days' end;

  insert into pg_temp._log (caso, linea)
  select u.caso, case when u.ok then 'OK        ' else 'FALLA     ' end || '(' || u.caso || ') ' || u.texto
  from unnest(v_casos, v_oks, v_textos) with ordinality as u(caso, ok, texto, i)
  order by u.i;
end;
$prueba$;

insert into _log (caso, linea)
select 'RESUMEN', format('%s OK, %s FALLA',
  count(*) filter (where linea like 'OK%'), count(*) filter (where linea like 'FALLA%'))
from _log;

commit;

select caso, linea from pg_temp._log order by n;
