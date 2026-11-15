-- =====================================================================================
-- PRUEBA de supabase_migration_correccion_hora_lotes.sql. Cuenta de test DNI 44537978.
--
-- NO DEJA NADA: es un único bloque DO que termina SIEMPRE con un error a propósito
-- ("PRUEBA CORRECCIÓN DE HORA TERMINADA -- se deshizo todo"). El mensaje de ese error ES el
-- informe: "N de M OK" y una línea por chequeo.
--
-- Dos partes:
--   (S) SIMULACIÓN con la cuenta de test, dentro de una subtransacción que se deshace: se le
--       arman lotes a hora exacta, a las 00:00, vencidos y ya corregidos, y se les aplica LA
--       MISMA regla y el MISMO criterio de lista que la migración (pg_temp.ch_corregir, solo
--       sobre la cuenta de test). Se puede correr ANTES de la migración para ver la regla.
--   (R) DATOS REALES, solo lectura: si la migración ya se aplicó (existe
--       respaldo.correccion_hora_lotes), verifica cada lote corregido. Antes de aplicarla,
--       esta parte se informa como AVISO "no aplicada", no como FALLA.
--
-- Lo que se prueba: ningún socio pierde días (nuevo >= antes y el día AR no cambia); a lo
-- sumo gana horas del día que muestra la app (menos de 1 día); el candado T7 pasa; los
-- vencidos no se tocan; los socios quedan con una sola fecha, la misma de antes.
-- Fechas relativas a HOY en Argentina. Evitar correrla justo alrededor de las 00:00.
-- =====================================================================================

do $prueba$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  c_fin_casos constant text := 'FIN_CASOS_CH';
  c_deshacer constant text := 'DESHACER_CASO_CH';
  c_dni constant text := '44537978';
  v_user uuid;
  v_aparatos uuid;
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_a uuid;
  v_b uuid;
  l_exacta uuid;
  l_aparatos uuid;
  l_cero_hs uuid;
  l_saldo0 uuid;
  l_vencido uuid;
  l_ok uuid;
  v_exacta timestamptz;
  v_cero_hs timestamptz;
  v_vencido timestamptz;
  v_corte20 timestamptz;
  v_corte10 timestamptz;
  v_dia_antes date;
  v_ok boolean;
  v_err text;
  v_txt text;
  v_n int;
  v_huella_antes text;
  v_huella_despues text;
  ok int := 0;
  total int := 0;
  informe text := '';
begin
  -- ── Preparación ──────────────────────────────────────────────────────────────────
  select id into v_user from profiles where dni = c_dni;
  if v_user is null then
    raise exception 'No existe el perfil con DNI 44537978.';
  end if;
  if (select count(*) from disciplines where kind = 'membership') <> 1 then
    raise exception 'PRUEBA CORRECCIÓN DE HORA: tiene que haber exactamente 1 disciplina membership (Aparatos). No se probó nada.';
  end if;
  select id into v_aparatos from disciplines where kind = 'membership';

  v_exacta  := ((v_hoy + 20)::timestamp + time '11:05') at time zone c_zona;
  v_cero_hs := ((v_hoy + 10)::timestamp) at time zone c_zona;            -- 00:00 de hoy + 10
  v_vencido := ((v_hoy - 1)::timestamp + time '15:48') at time zone c_zona;
  v_corte20 := ((v_hoy + 21)::timestamp at time zone c_zona) - interval '1 microsecond';
  v_corte10 := ((v_hoy + 11)::timestamp at time zone c_zona) - interval '1 microsecond';

  select md5(coalesce((select string_agg(concat_ws(':', id, discipline_id, remaining_credits, expires_at, created_at), ',' order by id)
                       from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', s.id, s.creditos, s.fecha_vencimiento), ',' order by s.id)
                                 from socios s where s.dni = c_dni), '-'))
    into v_huella_antes;

  -- ════ (S) Simulación con la cuenta de test ════
  begin
    create function pg_temp.ch_limpiar(p_user uuid) returns void language sql as $f$
      update user_credits set expires_at = least(expires_at, now() - interval '2 days')
      where user_id = p_user and expires_at > now();
    $f$;
    create function pg_temp.ch_lote(p_user uuid, p_disc uuid, p_saldo int, p_vence timestamptz) returns uuid language sql as $f$
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
      values (p_user, p_disc, p_saldo, p_vence) returning id;
    $f$;
    create function pg_temp.ch_candado() returns text language plpgsql as $f$
    begin
      set constraints public.candado_una_fecha_vigente_ins, public.candado_una_fecha_vigente_upd immediate;
      set constraints public.candado_una_fecha_vigente_ins, public.candado_una_fecha_vigente_upd deferred;
      return 'SIN ERROR';
    exception when others then
      return sqlstate || ' ' || sqlerrm;
    end;
    $f$;
    -- LA MISMA lista y LA MISMA regla que la migración, solo sobre p_user.
    create function pg_temp.ch_corregir(p_user uuid) returns int language plpgsql as $f$
    declare v_n int;
    begin
      update user_credits uc
      set expires_at = ((public.ultimo_dia_plan(uc.expires_at) + 1)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond'
      where uc.user_id = p_user
        and uc.expires_at > now()
        and to_char(uc.expires_at at time zone 'America/Argentina/Mendoza', 'HH24:MI') <> '23:59';
      get diagnostics v_n = row_count;
      return v_n;
    end;
    $f$;
    create function pg_temp.ch_vence(p_lote uuid) returns timestamptz language sql as $f$
      select expires_at from user_credits where id = p_lote;
    $f$;
    create function pg_temp.ch_fechas(p_user uuid) returns int language sql as $f$
      select count(distinct public.ultimo_dia_plan(uc.expires_at))::int
      from user_credits uc join disciplines d on d.id = uc.discipline_id
      where uc.user_id = p_user and uc.expires_at > now()
        and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership');
    $f$;

    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA CH A ' || gen_random_uuid(), 'credits', false, false) returning id into v_a;
    insert into disciplines (name, kind, is_active, show_in_agenda)
    values ('PRUEBA CH B ' || gen_random_uuid(), 'credits', false, false) returning id into v_b;
    perform pg_temp.ch_candado();

    -- (S1) Plan a hora exacta (hoy + 20 11:05): créditos con saldo, Aparatos y un lote en 0 del
    --      mismo plan, más un lote VENCIDO a hora exacta y uno que ya vence a 23:59:59.999999.
    --      Después de corregir: los 3 vigentes a hora exacta -> 23:59:59.999999 de hoy + 20;
    --      el vencido y el ya corregido, intactos; el candado pasa; una sola fecha, la misma.
    total := total + 1;
    begin
      perform pg_temp.ch_limpiar(v_user);
      l_exacta   := pg_temp.ch_lote(v_user, v_a, 3, v_exacta);
      l_aparatos := pg_temp.ch_lote(v_user, v_aparatos, null, v_exacta);
      l_saldo0   := pg_temp.ch_lote(v_user, v_b, 0, v_exacta + interval '1 hour');
      l_ok       := pg_temp.ch_lote(v_user, v_b, 2, v_corte20);
      l_vencido  := pg_temp.ch_lote(v_user, v_a, 0, v_vencido);
      perform pg_temp.ch_candado();
      v_dia_antes := public.ultimo_dia_plan(public.fecha_plan_socio(v_user));
      v_n := pg_temp.ch_corregir(v_user);
      v_err := pg_temp.ch_candado();
      v_ok := v_n = 3 and v_err = 'SIN ERROR'
              and pg_temp.ch_vence(l_exacta) = v_corte20
              and pg_temp.ch_vence(l_aparatos) = v_corte20
              and pg_temp.ch_vence(l_saldo0) = v_corte20
              and pg_temp.ch_vence(l_ok) = v_corte20
              and pg_temp.ch_vence(l_vencido) = v_vencido
              and pg_temp.ch_fechas(v_user) = 1
              and public.ultimo_dia_plan(public.fecha_plan_socio(v_user)) = v_dia_antes
              and (select count(distinct expires_at) from user_credits where user_id = v_user and expires_at > now()) = 1;
      v_txt := v_n || ' corregidos / ' || v_err || ' / fechas ' || pg_temp.ch_fechas(v_user)
               || ' / vencido ' || case when pg_temp.ch_vence(l_vencido) = v_vencido then 'intacto' else 'TOCADO' end;
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (S1) hora exacta: los 3 vigentes del plan pasan a 23:59:59.999999 del mismo día; vencido y ya corregido intactos; candado OK; misma fecha';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (S1) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (S1) ERROR: ' || sqlerrm; end if;
    end;

    -- (S2) Lote a las 00:00 de hoy + 10 (la app muestra hoy + 10): pasa a 23:59:59.999999 de
    --      hoy + 10. Gana menos de 1 día, nunca pierde, el día que muestra la app no cambia.
    total := total + 1;
    begin
      perform pg_temp.ch_limpiar(v_user);
      l_cero_hs := pg_temp.ch_lote(v_user, v_a, 4, v_cero_hs);
      perform pg_temp.ch_candado();
      v_n := pg_temp.ch_corregir(v_user);
      v_err := pg_temp.ch_candado();
      v_ok := v_n = 1 and v_err = 'SIN ERROR'
              and pg_temp.ch_vence(l_cero_hs) = v_corte10
              and public.ultimo_dia_plan(pg_temp.ch_vence(l_cero_hs)) = public.ultimo_dia_plan(v_cero_hs)
              and public.ultimo_dia_plan(v_cero_hs) = v_hoy + 10
              and pg_temp.ch_vence(l_cero_hs) > v_cero_hs
              and pg_temp.ch_vence(l_cero_hs) - v_cero_hs < interval '1 day';
      v_txt := v_n || ' corregidos / ' || v_err || ' / vence ' || coalesce((pg_temp.ch_vence(l_cero_hs) at time zone c_zona)::text, 'null');
      raise exception '%', c_deshacer;
    exception when others then
      if sqlerrm = c_deshacer and v_ok then
        ok := ok + 1; informe := informe || E'\nOK     (S2) 00:00 de hoy + 10: pasa a 23:59:59.999999 de hoy + 10 (el día que muestra la app), gana < 1 día';
      elsif sqlerrm = c_deshacer then informe := informe || E'\nFALLA  (S2) ' || coalesce(v_txt, '?');
      else informe := informe || E'\nFALLA  (S2) ERROR: ' || sqlerrm; end if;
    end;

    -- (S3) La regla alternativa (00:00 -> fin del día ANTERIOR) le haría perder: queda 1 µs
    --      ANTES de lo que ya tiene y la app pasaría a mostrar un día menos. Se documenta.
    total := total + 1;
    if ((public.ultimo_dia_plan(v_cero_hs))::timestamp at time zone c_zona) - interval '1 microsecond' < v_cero_hs
       and public.ultimo_dia_plan(((public.ultimo_dia_plan(v_cero_hs))::timestamp at time zone c_zona) - interval '1 microsecond')
           = public.ultimo_dia_plan(v_cero_hs) - 1 then
      ok := ok + 1; informe := informe || E'\nOK     (S3) control: "00:00 -> día anterior" quedaría 1 µs antes y la app mostraría un día menos (por eso no se usa)';
    else informe := informe || E'\nFALLA  (S3) control de la regla alternativa'; end if;

    raise exception '%', c_fin_casos;
  exception when others then
    if sqlerrm <> c_fin_casos then
      total := total + 1;
      informe := informe || E'\nFALLA  ERROR inesperado en la simulación: ' || sqlerrm;
    end if;
  end;

  -- ════ (R) Datos reales (solo lectura), si la migración ya se aplicó ════
  if to_regclass('respaldo.correccion_hora_lotes') is null then
    informe := informe || E'\nAVISO  (R) la corrección todavía no está aplicada: no se revisan datos reales';
  else
    -- (R1) Nadie pierde: nuevo >= antes, mismo día AR, gana < 1 día, y es el fin del día exacto.
    total := total + 1;
    select count(*) into v_n
    from respaldo.correccion_hora_lotes b
    where b.expires_at_nuevo < b.expires_at_antes
       or public.ultimo_dia_plan(b.expires_at_nuevo) <> public.ultimo_dia_plan(b.expires_at_antes)
       or b.expires_at_nuevo - b.expires_at_antes >= interval '1 day'
       or b.expires_at_nuevo <> ((public.ultimo_dia_plan(b.expires_at_antes) + 1)::timestamp at time zone c_zona) - interval '1 microsecond';
    if v_n = 0 then
      ok := ok + 1; informe := informe || E'\nOK     (R1) ' || (select count(*) from respaldo.correccion_hora_lotes)
                     || ' lotes: ninguno pierde, mismo día, ganan < 1 día, todos al fin del día exacto';
    else informe := informe || E'\nFALLA  (R1) ' || v_n || ' lotes pierden tiempo o cambian de día'; end if;

    -- (R2) Hoy siguen con la fecha nueva (los que cambiaron después se informan aparte).
    total := total + 1;
    select count(*) into v_n
    from respaldo.correccion_hora_lotes b
    left join user_credits uc on uc.id = b.lote_id
    where uc.expires_at is distinct from b.expires_at_nuevo;
    if v_n = 0 then
      ok := ok + 1; informe := informe || E'\nOK     (R2) todos los lotes corregidos siguen con su fecha nueva';
    else informe := informe || E'\nAVISO  (R2) ' || v_n || ' lotes cambiaron después de la corrección (cobro, edición): revisar si se piensa hacer el rollback'; total := total - 1; end if;

    -- (R3) Una sola fecha por socio corregido (candado T7).
    total := total + 1;
    select count(*) into v_n
    from (
      select uc.user_id
      from user_credits uc join disciplines d on d.id = uc.discipline_id
      where uc.user_id in (select user_id from respaldo.correccion_hora_lotes)
        and uc.expires_at > now()
        and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership')
      group by uc.user_id
      having count(distinct public.ultimo_dia_plan(uc.expires_at)) > 1
    ) x;
    if v_n = 0 then
      ok := ok + 1; informe := informe || E'\nOK     (R3) los socios corregidos tienen una sola fecha vigente';
    else informe := informe || E'\nFALLA  (R3) ' || v_n || ' socios con más de una fecha'; end if;

    -- (R4) 0 lotes vigentes con hora distinta de 23:59.
    total := total + 1;
    select count(*) into v_n
    from user_credits
    where expires_at > now()
      and to_char(expires_at at time zone c_zona, 'HH24:MI') <> '23:59';
    if v_n = 0 then
      ok := ok + 1; informe := informe || E'\nOK     (R4) 0 lotes vigentes con hora distinta de 23:59 AR';
    else informe := informe || E'\nFALLA  (R4) quedan ' || v_n || ' lotes vigentes con hora distinta de 23:59'; end if;
  end if;

  -- ── (l) Lo real de la cuenta de test quedó igual ──────────────────────────────────
  select md5(coalesce((select string_agg(concat_ws(':', id, discipline_id, remaining_credits, expires_at, created_at), ',' order by id)
                       from user_credits where user_id = v_user), '-')
             || '|' || coalesce((select string_agg(concat_ws(':', s.id, s.creditos, s.fecha_vencimiento), ',' order by s.id)
                                 from socios s where s.dni = c_dni), '-'))
    into v_huella_despues;
  total := total + 1;
  if v_huella_despues = v_huella_antes then
    ok := ok + 1; informe := informe || E'\nOK     (l) créditos y ficha reales de la cuenta de test intactos';
  else informe := informe || E'\nFALLA  (l) cambió algo real de la cuenta de test'; end if;

  raise exception 'PRUEBA CORRECCIÓN DE HORA TERMINADA -- se deshizo todo (este error es a propósito). % de % OK.%', ok, total, informe;
end;
$prueba$;
