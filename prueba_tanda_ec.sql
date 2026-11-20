-- =====================================================================================
-- PRUEBA de Tanda EC (supabase_migration_tanda_ec_clase_en_curso.sql). Correr DESPUÉS.
-- Cuenta de test DNI 44537978. Correrla entre las 02:00 y las 21:00 de Argentina (arma
-- clases de hoy alrededor de la hora actual, dentro del mismo día) y un día no cerrado.
--
-- NO DEJA NADA EN LA BASE: los casos van en una subtransacción que se deshace SIEMPRE. Solo
-- crean filas PROPIAS (una disciplina oculta e inactiva, clases "PRUEBA EC ...", un lote de
-- créditos de prueba, un día cerrado de prueba y reservas en esas clases). Ninguna fila real
-- se actualiza ni se borra. El caso (z) lo confirma. Lo único que sobrevive es el log
-- (tabla temporal de la sesión).
-- La sesión simulada es la del socio de test (book_class, cancel_booking_detalle) o la del
-- primer admin de profiles (admin_book_class), con request.jwt.claims local a la transacción.
--
-- CASOS
--   (a) Permisos de book_class: anon no, authenticated sí (no cambiaron).
--   (b) Clase en curso (empezó hace 10 min, termina en 50) -> book_class reserva.
--   (c) Clase terminada (de hace 70 a hace 10 min) -> 'Esta clase ya terminó: no se puede reservar.'
--   (d) Clase que termina en 2 min (en curso) -> reserva.
--   (e) Sin end_time, empezó hace 5 min -> 'Esta clase ya empezó: no se puede reservar.'
--       (SALTEADO si la base no deja end_time null).
--   (f) end_time anterior a start_time, empezó hace 5 min -> 'Esta clase ya empezó: ...'
--       (SALTEADO si la base no lo deja cargar).
--   (g) Lo de la Tanda RP sigue igual: fecha pasada -> 'No se puede reservar una fecha que ya
--       pasó.'; día cerrado -> 'El gimnasio está cerrado ese día.'
--   (h) admin_book_class sin cambios: la clase terminada y una fecha pasada -> reserva las dos.
--   (i) Cancelar la reserva en curso de (b) como el socio (cancel_booking_detalle, la que usa
--       la PWA) -> la rechaza por el límite; la reserva sigue. Se muestra el mensaje exacto.
--   (z) No quedó nada.
-- Resultado esperado: 10 OK, 0 FALLA (o con (e)/(f) SALTEADO si la base no permite esos datos).
-- =====================================================================================
begin;

drop table if exists pg_temp._log;
create temp table _log (n bigserial primary key, caso text, linea text);

do $prueba$
declare
  c_fin       constant text := 'FIN_CASOS_EC';
  c_termino   constant text := 'Esta clase ya terminó: no se puede reservar.';
  c_empezo    constant text := 'Esta clase ya empezó: no se puede reservar.';
  c_paso      constant text := 'No se puede reservar una fecha que ya pasó.';
  c_cerrado   constant text := 'El gimnasio está cerrado ese día.';
  c_todos     constant int[] := array[0, 1, 2, 3, 4, 5, 6];
  v_user  uuid;
  v_admin uuid;
  v_ahora_ar timestamp := now() at time zone 'America/Argentina/Mendoza';
  v_hoy   date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_vence timestamptz;
  v_cerrado date;
  v_huella_antes text;
  v_huella_despues text;
  v_disc uuid;
  v_c uuid; v_en_curso uuid; v_terminada uuid;
  r1 text; r2 text;
  v_ok boolean;
  v_txt text;
  v_estado text;
  -- El log se junta en arrays (ok null = SALTEADO): sobreviven a la subtransacción.
  v_casos  text[]    := '{}';
  v_oks    boolean[] := '{}';
  v_textos text[]    := '{}';
begin
  -- ── Preparación (fuera de la subtransacción) ──────────────────────────────────────
  if to_regclass('respaldo.tanda_ec_funciones') is null then
    raise exception 'Falta correr supabase_migration_tanda_ec_clase_en_curso.sql';
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

  -- Lote de prueba: mismo vencimiento que el plan vigente de la cuenta de test (candado T7), o 40 días.
  select coalesce(max(uc.expires_at), now() + interval '40 days') into v_vence
  from user_credits uc
  where uc.user_id = v_user and uc.expires_at > now()
    and (uc.remaining_credits > 0 or uc.remaining_credits is null);

  -- Día cerrado de prueba: el primero libre desde hoy + 20.
  select min(g.d)::date into v_cerrado
  from generate_series(v_hoy + 20, v_hoy + 80, interval '1 day') g(d)
  where not exists (select 1 from closed_days cd where cd.fecha = g.d::date);

  -- Huella de lo real que esto puede tocar.
  select md5(coalesce((select string_agg(concat_ws(':', id, class_id, booking_date, credit_lote_id), ',' order by id)
                       from bookings where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                                 from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select count(*)::text from xp_events where user_id = v_user), '-')
             || '|' || coalesce((select count(*)::text from booking_cancellations where user_id = v_user), '-')
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
    create function pg_temp.ec_como(p_id uuid) returns void language sql as $f$
      select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true),
             set_config('request.jwt.claim.sub', p_id::text, true);
      select null::void;
    $f$;

    create function pg_temp.ec_clase(p_disc uuid, p_inicio time, p_fin time) returns uuid language sql as $f$
      insert into classes (title, discipline_id, instructor, capacity, days_of_week, start_time, end_time)
      values ('PRUEBA EC ' || gen_random_uuid(), p_disc, null, 10, array[0, 1, 2, 3, 4, 5, 6], p_inicio, p_fin)
      returning id;
    $f$;

    -- Reserva como socio (book_class) o como admin (admin_book_class). Devuelve 'reservó' o el
    -- mensaje del error (cada intento en su propia subtransacción; si reserva, queda).
    create function pg_temp.ec_reservar(p_admin boolean, p_user uuid, p_class uuid, p_fecha date) returns text
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

    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA EC ' || gen_random_uuid(), 'credits', false, false)
    returning id into v_disc;
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (v_user, v_disc, 20, v_vence);
    insert into closed_days (fecha, motivo) values (v_cerrado, 'PRUEBA EC');

    -- (b) En curso: empezó hace 10 min, termina en 50.
    begin
      perform pg_temp.ec_como(v_user);
      v_en_curso := pg_temp.ec_clase(v_disc, (v_ahora_ar - interval '10 minutes')::time, (v_ahora_ar + interval '50 minutes')::time);
      r1 := pg_temp.ec_reservar(false, v_user, v_en_curso, v_hoy);
      v_ok := r1 = 'reservó'
              and exists (select 1 from bookings where user_id = v_user and class_id = v_en_curso and booking_date = v_hoy);
      v_txt := 'clase en curso (empezó hace 10 min, termina en 50) -> ' || r1;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'b'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (c) Terminada: de hace 70 a hace 10 min.
    begin
      perform pg_temp.ec_como(v_user);
      v_terminada := pg_temp.ec_clase(v_disc, (v_ahora_ar - interval '70 minutes')::time, (v_ahora_ar - interval '10 minutes')::time);
      r1 := pg_temp.ec_reservar(false, v_user, v_terminada, v_hoy);
      v_ok := r1 = c_termino and not exists (select 1 from bookings where class_id = v_terminada);
      v_txt := 'clase terminada hace 10 min -> ' || r1;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'c'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (d) Termina en 2 min: todavía en curso.
    begin
      perform pg_temp.ec_como(v_user);
      v_c := pg_temp.ec_clase(v_disc, (v_ahora_ar - interval '30 minutes')::time, (v_ahora_ar + interval '2 minutes')::time);
      r1 := pg_temp.ec_reservar(false, v_user, v_c, v_hoy);
      v_ok := r1 = 'reservó';
      v_txt := 'clase que termina en 2 min -> ' || r1;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'd'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (e) Sin end_time, empezó hace 5 min: como antes.
    begin
      perform pg_temp.ec_como(v_user);
      v_c := pg_temp.ec_clase(v_disc, (v_ahora_ar - interval '5 minutes')::time, null);
      r1 := pg_temp.ec_reservar(false, v_user, v_c, v_hoy);
      v_ok := r1 = c_empezo;
      v_txt := 'sin end_time, empezó hace 5 min -> ' || r1;
    exception
      when not_null_violation or check_violation then
        v_ok := null; v_txt := 'la base no deja cargar una clase sin end_time (' || sqlerrm || ')';
      when others then
        v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'e'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (f) end_time anterior a start_time (mal cargada), empezó hace 5 min: como antes.
    begin
      perform pg_temp.ec_como(v_user);
      v_c := pg_temp.ec_clase(v_disc, (v_ahora_ar - interval '5 minutes')::time, (v_ahora_ar - interval '65 minutes')::time);
      r1 := pg_temp.ec_reservar(false, v_user, v_c, v_hoy);
      v_ok := r1 = c_empezo;
      v_txt := 'fin anterior al inicio, empezó hace 5 min -> ' || r1;
    exception
      when check_violation then
        v_ok := null; v_txt := 'la base no deja cargar un fin anterior al inicio (' || sqlerrm || ')';
      when others then
        v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'f'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (g) Fecha pasada y día cerrado: igual que en la Tanda RP.
    begin
      perform pg_temp.ec_como(v_user);
      v_c := pg_temp.ec_clase(v_disc, time '10:00', time '11:00');
      r1 := pg_temp.ec_reservar(false, v_user, v_c, v_hoy - 1);
      r2 := pg_temp.ec_reservar(false, v_user, v_c, v_cerrado);
      v_ok := r1 = c_paso and r2 = c_cerrado;
      v_txt := 'ayer -> ' || r1 || format(' / día cerrado (%s) -> ', to_char(v_cerrado, 'DD/MM')) || r2;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'g'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (h) admin_book_class sin cambios: la clase terminada de (c) y una fecha pasada.
    begin
      perform pg_temp.ec_como(v_admin);
      v_c := pg_temp.ec_clase(v_disc, time '10:00', time '11:00');
      r1 := pg_temp.ec_reservar(true, v_user, v_terminada, v_hoy);
      r2 := pg_temp.ec_reservar(true, v_user, v_c, v_hoy - 1);
      v_ok := r1 = 'reservó' and r2 = 'reservó';
      v_txt := 'admin: clase terminada -> ' || r1 || ' / ayer -> ' || r2;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'h'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

    -- (i) Cancelar la reserva en curso de (b), como el socio.
    begin
      perform pg_temp.ec_como(v_user);
      v_txt := null;
      begin
        perform public.cancel_booking_detalle(v_en_curso, v_hoy, null);
        v_estado := 'CANCELÓ';
      exception when others then
        v_estado := sqlerrm;
      end;
      v_ok := v_estado like 'No podés cancelar%'
              and exists (select 1 from bookings where user_id = v_user and class_id = v_en_curso and booking_date = v_hoy);
      v_txt := 'cancelar la reserva en curso -> ' || v_estado
               || case when exists (select 1 from bookings where user_id = v_user and class_id = v_en_curso and booking_date = v_hoy)
                       then ' (la reserva sigue)' else ' (SE BORRÓ LA RESERVA)' end;
    exception when others then
      v_ok := false; v_txt := 'error inesperado: ' || sqlerrm;
    end;
    v_casos := v_casos || 'i'::text; v_oks := v_oks || v_ok; v_textos := v_textos || v_txt;

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
             || '|' || coalesce((select count(*)::text from booking_cancellations where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', fecha, motivo), ',' order by fecha)
                                 from closed_days), '-'))
    into v_huella_despues;
  v_ok := v_huella_despues = v_huella_antes
          and not exists (select 1 from classes where title like 'PRUEBA EC %')
          and not exists (select 1 from disciplines where name like 'PRUEBA EC %')
          and to_regprocedure('pg_temp.ec_reservar(boolean, uuid, uuid, date)') is null;
  v_casos := v_casos || 'z'::text; v_oks := v_oks || v_ok;
  v_textos := v_textos || case when v_ok
    then 'reservas, lotes, XP y cancelaciones de la cuenta de test y closed_days iguales; no quedó ninguna clase ni disciplina de prueba'
    else 'QUEDÓ ALGO de la prueba o cambió algo real de la cuenta de test o de closed_days' end;

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
