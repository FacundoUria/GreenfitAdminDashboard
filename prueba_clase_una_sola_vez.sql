-- =====================================================================================
-- PRUEBA de supabase_migration_clase_una_sola_vez.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA UNA SOLA VEZ TERMINADA -- se deshizo todo"). El mensaje de ese error ES el informe:
-- "N de M OK" y una línea por chequeo.
--
-- Cómo corre:
--   * Se corre DESPUÉS de la migración (antes, casi todo falla).
--   * Los casos van dentro de una subtransacción que se deshace al final. Solo crean filas
--     PROPIAS (una disciplina oculta e inactiva, clases "PRUEBA USV …", un lote de créditos de
--     prueba y reservas en esas clases). No se actualiza ni borra ninguna fila real: la clase
--     Kick (c3328419…) solo se LEE; su caso se reproduce con una clase de prueba igual ({}).
--   * Cada caso va en su propio bloque: si uno revienta, se informa como FALLA y siguen los demás.
--   * La sesión simulada es la del socio de test (book_class) o la del primer admin de profiles
--     (admin_book_class), con request.jwt.claims local a esta transacción.
--   * Fechas siempre relativas a HOY en Argentina: se puede correr cualquier día. Evitar correrla
--     justo alrededor de las 00:00 de Argentina.
--   * Caso (a): reemplazar <PERMISOS_BOOK_CLASS> y <PERMISOS_ADMIN_BOOK_CLASS> con la columna
--     "permisos" de la consulta del encabezado de la migración (corrida ANTES de migrar). Si
--     quedan sin reemplazar, ese caso da FALLA (el resto corre igual).
-- =====================================================================================

do $prueba$
declare
  c_fin_casos constant text := 'FIN_CASOS_USV';
  c_permisos_book constant text := '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
  c_permisos_admin_book constant text := '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
  v_user uuid;
  v_admin uuid;
  v_disc uuid;
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_f1 date;       -- hoy + 7 (mismo día de semana que hoy)
  v_f2 date;       -- hoy + 14 (mismo día de semana que hoy)
  v_otro date;     -- hoy + 8 (otro día de semana)
  v_dow int;       -- día de semana de v_f1
  v_dow_otro int;  -- día de semana de v_otro
  v_c uuid;
  v_c2 uuid;
  v_id uuid;
  v_n int;
  v_err text;
  v_estado text;
  v_txt text;
  v_huella_antes text;
  v_huella_despues text;
  ok int := 0;
  total int := 0;
  informe text := '';
begin
  -- ── Preparación (fuera de la subtransacción) ──────────────────────────────────────
  select id into v_user from profiles where dni = '44537978';
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  select id into v_admin from profiles where role = 'admin' order by created_at limit 1;
  if v_admin is null then
    raise exception 'No hay ningún perfil admin.';
  end if;

  v_f1 := v_hoy + 7;
  v_f2 := v_hoy + 14;
  v_otro := v_hoy + 8;
  v_dow := extract(dow from v_f1)::int;
  v_dow_otro := extract(dow from v_otro)::int;

  -- Huella de lo real de la cuenta de test que esto puede tocar (reservas, lotes, XP).
  select md5(coalesce((select string_agg(concat_ws(':', id, class_id, booking_date, credit_lote_id), ',' order by id)
                       from bookings where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                                 from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select count(*)::text from xp_events where user_id = v_user), '-'))
    into v_huella_antes;

  -- ── (0) Estructura ─────────────────────────────────────────────────────────────────
  total := total + 1;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'classes' and column_name = 'fecha_unica'
               and data_type = 'date' and is_nullable = 'YES')
     and exists (select 1 from pg_constraint where conname = 'classes_fecha_unica_dia_check' and convalidated)
     and exists (select 1 from pg_trigger where tgname = 'classes_validar_fecha_unica' and tgenabled = 'O')
     and not has_function_privilege('anon', 'public.classes_validar_fecha_unica()', 'execute')
     and not has_function_privilege('authenticated', 'public.classes_validar_fecha_unica()', 'execute') then
    ok := ok + 1; informe := informe || E'\nOK     (0) columna date null, CHECK validado, trigger activo, función del trigger sin execute para anon/authenticated';
  else informe := informe || E'\nFALLA  (0) estructura incompleta (columna / CHECK / trigger / permisos de la función del trigger)'; end if;

  -- ── (a) Permisos de book_class / admin_book_class iguales a los de antes ────────────
  total := total + 1;
  select coalesce(p.proacl::text, '(por defecto)') into v_txt
  from pg_proc p where p.oid = 'public.book_class(uuid, date)'::regprocedure;
  select coalesce(p.proacl::text, '(por defecto)') into v_err
  from pg_proc p where p.oid = 'public.admin_book_class(uuid, uuid, date)'::regprocedure;
  if v_txt = c_permisos_book and v_err = c_permisos_admin_book then
    ok := ok + 1; informe := informe || E'\nOK     (a) permisos de book_class y admin_book_class iguales a los de antes';
  else informe := informe || E'\nFALLA  (a) permisos: book_class = ' || v_txt || ' / admin_book_class = ' || v_err; end if;

  -- ── (m) Kick real: solo lectura ──────────────────────────────────────────────────────
  total := total + 1;
  select count(*) into v_n from classes
  where id::text like 'c3328419%' and days_of_week = '{}'::int[] and fecha_unica is null;
  if v_n = 1 then
    ok := ok + 1; informe := informe || E'\nOK     (m) Kick real intacta: days_of_week = {} y fecha_unica null (cumple el CHECK)';
  else informe := informe || E'\nFALLA  (m) Kick real: se esperaba 1 fila con {} y fecha_unica null, hay ' || v_n; end if;

  -- ── Casos: subtransacción que se deshace al final ─────────────────────────────────
  begin
    -- Auxiliares temporales (se deshacen con la subtransacción).
    create function pg_temp.usv_como(p_id uuid) returns void language sql as $f$
      select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true),
             set_config('request.jwt.claim.sub', p_id::text, true);
      select null::void;
    $f$;
    create function pg_temp.usv_clase(p_disc uuid, p_dias int[], p_fecha date) returns uuid language sql as $f$
      insert into classes (title, discipline_id, instructor, capacity, days_of_week, start_time, end_time, fecha_unica)
      values ('PRUEBA USV ' || gen_random_uuid(), p_disc, null, 10, p_dias, '10:00', '11:00', p_fecha)
      returning id;
    $f$;
    create function pg_temp.usv_reserva(p_user uuid, p_class uuid, p_fecha date) returns uuid language sql as $f$
      insert into bookings (user_id, class_id, booking_date) values (p_user, p_class, p_fecha) returning id;
    $f$;

    -- Disciplina de prueba (oculta e inactiva) + un lote de créditos de prueba vigente.
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA USV ' || gen_random_uuid(), 'credits', false, false)
    returning id into v_disc;
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (v_user, v_disc, 20, now() + interval '40 days');

    -- (b) R1: una clase de una sola vez con fecha de ayer no se puede crear; con hoy, sí.
    total := total + 1;
    begin
      v_err := null;
      begin
        perform pg_temp.usv_clase(v_disc, array[extract(dow from v_hoy - 1)::int], v_hoy - 1);
      exception when others then v_err := sqlerrm;
      end;
      v_id := null;
      begin
        v_id := pg_temp.usv_clase(v_disc, array[extract(dow from v_hoy)::int], v_hoy);
      exception when others then v_txt := sqlerrm;
      end;
      if v_err like '%no puede ser anterior a hoy%' and v_id is not null then
        ok := ok + 1; informe := informe || E'\nOK     (b) R1: fecha de ayer rechazada, fecha de hoy aceptada';
      else informe := informe || E'\nFALLA  (b) R1 -- ayer: ' || coalesce(v_err, 'SE CREÓ') || ' / hoy: ' || coalesce(v_id::text, v_txt); end if;
    exception when others then
      informe := informe || E'\nFALLA  (b) error inesperado: ' || sqlerrm;
    end;

    -- (c) CHECK: days_of_week tiene que ser exactamente {dow(fecha_unica)}.
    total := total + 1;
    begin
      v_err := null; v_estado := null;
      begin
        perform pg_temp.usv_clase(v_disc, array[v_dow_otro], v_f1);
      exception when others then v_estado := sqlstate;
      end;
      begin
        perform pg_temp.usv_clase(v_disc, array[v_dow, v_dow_otro], v_f1);
      exception when others then v_err := sqlstate;
      end;
      if v_estado = '23514' and v_err = '23514' then
        ok := ok + 1; informe := informe || E'\nOK     (c) CHECK: día distinto y día de más rechazados (23514)';
      else informe := informe || E'\nFALLA  (c) CHECK -- día distinto: ' || coalesce(v_estado, 'SE CREÓ') || ' / día de más: ' || coalesce(v_err, 'SE CREÓ'); end if;
    exception when others then
      informe := informe || E'\nFALLA  (c) error inesperado: ' || sqlerrm;
    end;

    -- (d) book_class (sesión del socio): una sola vez -> solo su fecha.
    total := total + 1;
    begin
      perform pg_temp.usv_como(v_user);
      v_c := pg_temp.usv_clase(v_disc, array[v_dow], v_f1);
      v_id := public.book_class(v_c, v_f1);
      v_err := null;
      begin
        perform public.book_class(v_c, v_f2);
      exception when others then v_err := sqlerrm;
      end;
      v_txt := null;
      begin
        perform public.book_class(v_c, v_otro);
      exception when others then v_txt := sqlerrm;
      end;
      if v_id is not null
         and v_err = 'Esta clase es solo del ' || to_char(v_f1, 'DD/MM')
         and v_txt = 'Esta clase es solo del ' || to_char(v_f1, 'DD/MM') then
        ok := ok + 1; informe := informe || E'\nOK     (d) book_class: reserva en su fecha; otra semana y otro día -> "Esta clase es solo del ' || to_char(v_f1, 'DD/MM') || '"';
      else informe := informe || E'\nFALLA  (d) book_class -- su fecha: ' || coalesce(v_id::text, 'null') || ' / otra semana: ' || coalesce(v_err, 'RESERVÓ') || ' / otro día: ' || coalesce(v_txt, 'RESERVÓ'); end if;
    exception when others then
      informe := informe || E'\nFALLA  (d) error inesperado: ' || sqlerrm;
    end;

    -- (e) admin_book_class (sesión del admin): misma regla.
    total := total + 1;
    begin
      perform pg_temp.usv_como(v_admin);
      v_c := pg_temp.usv_clase(v_disc, array[v_dow], v_f1);
      v_id := public.admin_book_class(v_user, v_c, v_f1);
      v_err := null;
      begin
        perform public.admin_book_class(v_user, v_c, v_f2);
      exception when others then v_err := sqlerrm;
      end;
      if v_id is not null and v_err = 'Esta clase es solo del ' || to_char(v_f1, 'DD/MM') then
        ok := ok + 1; informe := informe || E'\nOK     (e) admin_book_class: reserva en su fecha; otra semana rechazada';
      else informe := informe || E'\nFALLA  (e) admin_book_class -- su fecha: ' || coalesce(v_id::text, 'null') || ' / otra semana: ' || coalesce(v_err, 'RESERVÓ'); end if;
    exception when others then
      informe := informe || E'\nFALLA  (e) error inesperado: ' || sqlerrm;
    end;

    -- (f) Semanal sin cambios: se reserva cualquier semana; otro día sigue "no se dicta".
    total := total + 1;
    begin
      perform pg_temp.usv_como(v_user);
      v_c := pg_temp.usv_clase(v_disc, array[v_dow], null);
      perform public.book_class(v_c, v_f1);
      perform public.book_class(v_c, v_f2);
      v_err := null;
      begin
        perform public.book_class(v_c, v_otro);
      exception when others then v_err := sqlerrm;
      end;
      select count(*) into v_n from bookings where class_id = v_c;
      if v_n = 2 and v_err = 'Esta clase no se dicta ese día.' then
        ok := ok + 1; informe := informe || E'\nOK     (f) semanal igual que antes: 2 semanas reservadas, otro día "no se dicta"';
      else informe := informe || E'\nFALLA  (f) semanal -- reservas: ' || v_n || ' / otro día: ' || coalesce(v_err, 'RESERVÓ'); end if;
    exception when others then
      informe := informe || E'\nFALLA  (f) error inesperado: ' || sqlerrm;
    end;

    -- (g) R2 semanal -> una sola vez: frena si queda una reserva futura en otra fecha.
    total := total + 1;
    begin
      v_c := pg_temp.usv_clase(v_disc, array[v_dow], null);
      perform pg_temp.usv_reserva(v_user, v_c, v_f1);
      v_id := pg_temp.usv_reserva(v_user, v_c, v_f2);
      v_err := null;
      begin
        update classes set fecha_unica = v_f1 where id = v_c;
      exception when others then v_err := sqlerrm;
      end;
      select count(*) into v_n from classes where id = v_c and fecha_unica is null;
      delete from bookings where id = v_id;  -- reserva de PRUEBA (fila creada en este caso)
      update classes set fecha_unica = v_f1 where id = v_c;
      if v_err like '%' || to_char(v_f2, 'DD/MM') || ' (1)%' and v_err not like '%' || to_char(v_f1, 'DD/MM') || '%'
         and v_n = 1
         and exists (select 1 from classes where id = v_c and fecha_unica = v_f1) then
        ok := ok + 1; informe := informe || E'\nOK     (g) semanal -> una sola vez: frena por la reserva del ' || to_char(v_f2, 'DD/MM') || '; sin ella, pasa';
      else informe := informe || E'\nFALLA  (g) semanal -> una sola vez: ' || coalesce(v_err, 'NO FRENÓ'); end if;
    exception when others then
      informe := informe || E'\nFALLA  (g) error inesperado: ' || sqlerrm;
    end;

    -- (h) Las reservas pasadas no frenan nada.
    total := total + 1;
    begin
      v_c := pg_temp.usv_clase(v_disc, array[v_dow], null);
      perform pg_temp.usv_reserva(v_user, v_c, v_hoy - 7);
      update classes set fecha_unica = v_f1 where id = v_c;
      ok := ok + 1; informe := informe || E'\nOK     (h) una reserva pasada no frena el cambio a una sola vez';
    exception when others then
      informe := informe || E'\nFALLA  (h) frenó por una reserva pasada: ' || sqlerrm;
    end;

    -- (i) R2 una sola vez -> semanal: el día de la fecha tiene que seguir incluido.
    total := total + 1;
    begin
      v_c := pg_temp.usv_clase(v_disc, array[v_dow], v_f1);
      perform pg_temp.usv_reserva(v_user, v_c, v_f1);
      v_err := null;
      begin
        update classes set fecha_unica = null, days_of_week = array[v_dow_otro] where id = v_c;
      exception when others then v_err := sqlerrm;
      end;
      update classes set fecha_unica = null, days_of_week = array[v_dow, v_dow_otro] where id = v_c;
      if v_err like '%' || to_char(v_f1, 'DD/MM') || ' (1)%' then
        ok := ok + 1; informe := informe || E'\nOK     (i) una sola vez -> semanal: sin su día frena, con su día pasa';
      else informe := informe || E'\nFALLA  (i) una sola vez -> semanal: ' || coalesce(v_err, 'NO FRENÓ'); end if;
    exception when others then
      informe := informe || E'\nFALLA  (i) error inesperado: ' || sqlerrm;
    end;

    -- (j) R2 cambiar la fecha de una clase de una sola vez: con reserva frena, sin reserva pasa.
    total := total + 1;
    begin
      v_c := pg_temp.usv_clase(v_disc, array[v_dow], v_f1);
      perform pg_temp.usv_reserva(v_user, v_c, v_f1);
      v_c2 := pg_temp.usv_clase(v_disc, array[v_dow], v_f1);
      v_err := null;
      begin
        update classes set fecha_unica = v_otro, days_of_week = array[v_dow_otro] where id = v_c;
      exception when others then v_err := sqlerrm;
      end;
      update classes set fecha_unica = v_otro, days_of_week = array[v_dow_otro] where id = v_c2;
      if v_err like '%' || to_char(v_f1, 'DD/MM') || ' (1)%'
         and exists (select 1 from classes where id = v_c2 and fecha_unica = v_otro) then
        ok := ok + 1; informe := informe || E'\nOK     (j) cambio de fecha: con reserva frena, sin reserva pasa';
      else informe := informe || E'\nFALLA  (j) cambio de fecha: ' || coalesce(v_err, 'NO FRENÓ'); end if;
    exception when others then
      informe := informe || E'\nFALLA  (j) error inesperado: ' || sqlerrm;
    end;

    -- (k) R2 también tapa el agujero de antes: sacarle un día con reservas a una semanal.
    total := total + 1;
    begin
      v_c := pg_temp.usv_clase(v_disc, array[v_dow, v_dow_otro], null);
      perform pg_temp.usv_reserva(v_user, v_c, v_otro);
      v_err := null;
      begin
        update classes set days_of_week = array[v_dow] where id = v_c;
      exception when others then v_err := sqlerrm;
      end;
      if v_err like '%' || to_char(v_otro, 'DD/MM') || ' (1)%' then
        ok := ok + 1; informe := informe || E'\nOK     (k) semanal: sacarle un día con reserva futura frena';
      else informe := informe || E'\nFALLA  (k) semanal sin el día: ' || coalesce(v_err, 'NO FRENÓ'); end if;
    exception when others then
      informe := informe || E'\nFALLA  (k) error inesperado: ' || sqlerrm;
    end;

    -- (l) Como Kick: days_of_week = {} con una reserva futura (ya fuera de la plantilla).
    --     Editar título/cupo y agregarle un día no frena: el cambio no la deja peor.
    total := total + 1;
    begin
      v_c := pg_temp.usv_clase(v_disc, '{}'::int[], null);
      perform pg_temp.usv_reserva(v_user, v_c, v_f1);
      update classes set title = title || ' editada', capacity = 12 where id = v_c;
      update classes set days_of_week = array[v_dow_otro] where id = v_c;
      update classes set days_of_week = '{}'::int[] where id = v_c;
      ok := ok + 1; informe := informe || E'\nOK     (l) clase con {} (como Kick) y reserva huérfana: se edita y se le cambian los días sin frenar';
    exception when others then
      informe := informe || E'\nFALLA  (l) clase con {} frenó: ' || sqlerrm;
    end;

    -- (n) R1 al cambiar: mover la fecha al pasado frena; editar el título de una de hoy, no.
    total := total + 1;
    begin
      v_c := pg_temp.usv_clase(v_disc, array[extract(dow from v_hoy)::int], v_hoy);
      update classes set title = title || ' editada' where id = v_c;
      v_err := null;
      begin
        update classes set fecha_unica = v_hoy - 7 where id = v_c;
      exception when others then v_err := sqlerrm;
      end;
      if v_err like '%no puede ser anterior a hoy%' then
        ok := ok + 1; informe := informe || E'\nOK     (n) editar el título de una de hoy pasa; mover su fecha al pasado frena';
      else informe := informe || E'\nFALLA  (n) mover al pasado: ' || coalesce(v_err, 'NO FRENÓ'); end if;
    exception when others then
      informe := informe || E'\nFALLA  (n) error inesperado: ' || sqlerrm;
    end;

    raise exception '%', c_fin_casos;
  exception when others then
    if sqlerrm <> c_fin_casos then
      total := total + 1;
      informe := informe || E'\nFALLA  ERROR inesperado en los casos: ' || sqlerrm;
    end if;
  end;

  -- ── (z) Ya deshecha la subtransacción: no quedó ningún rastro ─────────────────────
  select md5(coalesce((select string_agg(concat_ws(':', id, class_id, booking_date, credit_lote_id), ',' order by id)
                       from bookings where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', id, remaining_credits, expires_at), ',' order by id)
                                 from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select count(*)::text from xp_events where user_id = v_user), '-'))
    into v_huella_despues;
  total := total + 1;
  if v_huella_despues = v_huella_antes
     and not exists (select 1 from classes where title like 'PRUEBA USV %')
     and not exists (select 1 from disciplines where name like 'PRUEBA USV %') then
    ok := ok + 1; informe := informe || E'\nOK     (z) reservas, lotes y XP de la cuenta de test intactos; no quedó ninguna clase ni disciplina de prueba';
  else informe := informe || E'\nFALLA  (z) quedó algo de la prueba o cambió algo real de la cuenta de test'; end if;

  -- ── Fin: SIEMPRE con error, para deshacer todo. ─────────────────────────────────────
  raise exception 'PRUEBA UNA SOLA VEZ TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
