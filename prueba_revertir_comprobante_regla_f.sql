-- =====================================================================================
-- PRUEBA de supabase_migration_fix_revertir_comprobante_regla_f.sql (regla F).
-- Cuenta de prueba (socio): Facundo Uria, DNI 44537978.
--
-- CÓMO CORRERLO
--   * Pegar TODO el archivo en el SQL Editor y ejecutar UNA vez. El resultado es la ÚLTIMA
--     grilla (una línea OK/FALLA por chequeo y un resumen al final).
--   * Sirve ANTES y DESPUÉS de migrar. Antes, los chequeos marcados "(falla con la función
--     actual)" tienen que dar FALLA; después de migrar, TODO tiene que dar OK. La línea 0
--     dice qué versión de la función está instalada.
--
-- NO DEJA NADA EN LA BASE
--   * Cada caso arranca "limpiando" el plan de la cuenta de prueba, crea packs temporales
--     "ZZ PRUEBA REVERTIR ...", sube comprobantes con crear_pago_pendiente_transferencia
--     (el mismo camino que la PWA) y revierte como admin, todo adentro de una
--     subtransacción que se DESHACE SIEMPRE. Recién después se anota el resultado.
--   * Corre en REPEATABLE READ: ve una foto fija de la base, así lo que hagan los socios
--     reales mientras corre no se confunde con un cambio del script.
--   * El chequeo FINAL confirma que la cuenta de prueba (créditos, pagos, ficha, reservas,
--     notificaciones) y el catálogo de packs quedaron idénticos.
--
-- CASOS
--   0  Qué versión de admin_revertir_comprobante está instalada (nota)
--   1  Pago créditos + Aparatos, recién hecho
--   2  Había un plan anterior con Aparatos: revertir NO lo restaura
--   3  Pago hecho después de las 21:00 ART
--   4  Créditos parcialmente usados + reserva futura pagada con ese lote
--   5  Revertir dos veces el mismo pago
--   6  Pago sin Aparatos (el plan anterior sí tenía)
--   7  Pago solo con Aparatos
--   8  Aparatos con la fecha cambiada a mano después del pago
--   9  Comprobante viejo sin lote_id en el detalle
--   10 Créditos cargados a mano DESPUÉS del pago (no son del pago: quedan, y se avisa)
--   11 Revertir un pago viejo ya reemplazado por otro: el nuevo no se toca
--   12 Lote que no creó este pago: error claro y no cambia nada
-- =====================================================================================
begin isolation level repeatable read;
set local timezone = 'UTC'; -- igual que las llamadas que llegan por la API

drop table if exists pg_temp._log;
drop table if exists pg_temp._ctx;
drop table if exists pg_temp._antes;
create temp table _log (n bigserial primary key, caso text, linea text);

create temp table _ctx as
select
  (select id from profiles where dni = '44537978') as u,
  (select id from profiles where role = 'admin' order by id limit 1) as admin,
  (select id from disciplines where kind = 'membership' limit 1) as aparatos,
  (select id from disciplines where kind = 'credits' and lower(name) = 'crossfit' limit 1) as crossfit,
  (select id from disciplines where kind = 'credits' and lower(name) = 'boxeo' limit 1) as boxeo,
  (select c.id from classes c join disciplines d on d.id = c.discipline_id
    where d.kind = 'credits' and lower(d.name) = 'crossfit' order by c.id limit 1) as clase,
  (now() at time zone 'America/Argentina/Mendoza')::date as hoy;

-- ---- helpers ----

-- auth.uid() lee request.jwt.claims. `true` = solo esta transacción.
create or replace function pg_temp.como(p_user uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end $f$;

create or replace function pg_temp.chk(p_ok boolean, p_texto text) returns text language sql as $f$
  select case when coalesce(p_ok, false) then 'OK        ' else 'FALLA     ' end || p_texto;
$f$;

-- Deja a la cuenta de prueba sin nada vigente ni con fecha futura (solo dentro de cada caso).
create or replace function pg_temp.limpiar() returns void language sql as $f$
  update user_credits
  set expires_at = now() - interval '2 days',
      remaining_credits = case when remaining_credits is null then null else 0 end
  where user_id = (select u from pg_temp._ctx)
    and (expires_at is null or expires_at > now() - interval '2 days');
$f$;

create or replace function pg_temp.pack(p_nombre text, p_creditos jsonb, p_aparatos boolean) returns uuid
language plpgsql as $f$
declare v uuid;
begin
  insert into packs (name, price, creditos, incluye_aparatos, dias_vigencia, is_active)
  values ('ZZ PRUEBA REVERTIR ' || p_nombre, 1, p_creditos, p_aparatos, 30, true)
  returning id into v;
  return v;
end $f$;

create or replace function pg_temp.cred(p_disc uuid, p_n int) returns jsonb language sql as $f$
  select jsonb_build_object('discipline_id', p_disc, 'credits', p_n);
$f$;

-- El socio sube el comprobante: mismo camino que la PWA.
create or replace function pg_temp.pagar(p_pack uuid) returns uuid language plpgsql as $f$
begin
  perform pg_temp.como((select u from pg_temp._ctx));
  return public.crear_pago_pendiente_transferencia(p_pack, 'zz-prueba/revertir.jpg', 1);
end $f$;

-- Corre un pago (y lo que acreditó) a otro instante, como si se hubiera hecho entonces.
create or replace function pg_temp.correr(p_pago uuid, p_hacia timestamptz) returns void
language plpgsql as $f$
declare v_antes timestamptz; v_u uuid := (select u from pg_temp._ctx); v_apa timestamptz;
begin
  select created_at into v_antes from pagos_socio where id = p_pago;
  update user_credits
  set created_at = p_hacia, expires_at = expires_at + (p_hacia - v_antes)
  where user_id = v_u and created_at = v_antes;
  select expires_at into v_apa from user_credits
  where user_id = v_u and created_at = p_hacia and discipline_id = (select aparatos from pg_temp._ctx);
  update pagos_socio
  set created_at = p_hacia,
      detalle_acreditacion = case
        when detalle_acreditacion ? 'aparatos' then jsonb_set(detalle_acreditacion,
          '{aparatos,fecha_vencimiento_despues}',
          to_jsonb((v_apa at time zone 'America/Argentina/Mendoza')::date))
        else detalle_acreditacion end
  where id = p_pago;
end $f$;

create or replace function pg_temp.revertir(p_pago uuid, out ok boolean, out aviso text) language plpgsql as $f$
begin
  perform pg_temp.como((select admin from pg_temp._ctx));
  select r.reversion_ok, r.aparatos_advertencia into ok, aviso from public.admin_revertir_comprobante(p_pago) r;
end $f$;

create or replace function pg_temp.habilitado(p_disc uuid) returns boolean language sql as $f$
  select public.esta_habilitado_para_disciplina((select u from pg_temp._ctx), p_disc);
$f$;

create or replace function pg_temp.filas() returns bigint language sql as $f$
  select count(*) from user_credits where user_id = (select u from pg_temp._ctx);
$f$;

-- Filas vigentes de la cuenta de prueba (con saldo, o Aparatos).
create or replace function pg_temp.vigentes() returns bigint language sql as $f$
  select count(*) from user_credits uc join disciplines d on d.id = uc.discipline_id
  where uc.user_id = (select u from pg_temp._ctx) and uc.expires_at > now()
    and (d.kind = 'membership' or uc.remaining_credits > 0);
$f$;

-- ¿Todo lo que acreditó el pago está vencido y (créditos) en 0?
create or replace function pg_temp.pago_vencido(p_pago uuid) returns boolean language sql as $f$
  select not exists (
    select 1 from user_credits uc
    where uc.user_id = (select u from pg_temp._ctx)
      and uc.created_at = (select created_at from pagos_socio where id = p_pago)
      and (uc.expires_at > now() or coalesce(uc.remaining_credits, 0) > 0));
$f$;

create or replace function pg_temp.huella_pago(p_pago uuid) returns text language sql as $f$
  select md5(
    (select md5(p::text) from pagos_socio p where p.id = p_pago) ||
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from user_credits t
      where t.user_id = (select u from pg_temp._ctx)
        and t.created_at = (select created_at from pagos_socio where id = p_pago)));
$f$;

-- Todo lo de los DEMÁS socios que revertir podría tocar.
create or replace function pg_temp.huella_otros() returns text language sql as $f$
  select md5(
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from user_credits t
      where t.user_id <> (select u from pg_temp._ctx)) ||
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from pagos_socio t
      where t.user_id <> (select u from pg_temp._ctx)) ||
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from socios t
      where t.dni is distinct from '44537978') ||
    (select count(*)::text from notifications t where t.target_user_id is distinct from (select u from pg_temp._ctx)));
$f$;

-- La cuenta de prueba completa + el catálogo de packs (para el chequeo FINAL).
create or replace function pg_temp.huella_cuenta() returns text language sql as $f$
  select md5(
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from user_credits t
      where t.user_id = (select u from pg_temp._ctx)) ||
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from pagos_socio t
      where t.user_id = (select u from pg_temp._ctx)) ||
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from socios t
      where t.dni = '44537978') ||
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from bookings t
      where t.user_id = (select u from pg_temp._ctx)) ||
    (select count(*)::text from notifications t where t.target_user_id = (select u from pg_temp._ctx)) ||
    (select coalesce(string_agg(md5(t::text), '' order by t.id::text), '') from packs t));
$f$;

-- ---- preflight: si algo no está, no se corre nada ----
do $$
declare c record; v_cols text;
begin
  select * into c from pg_temp._ctx;
  if c.u is null then raise exception 'No existe el perfil con DNI 44537978'; end if;
  if not exists (select 1 from socios where dni = '44537978') then raise exception 'No hay ficha en socios con DNI 44537978'; end if;
  if c.admin is null then raise exception 'No hay ningún perfil con role = admin'; end if;
  if c.aparatos is null or c.crossfit is null or c.boxeo is null then raise exception 'Faltan disciplinas (Aparatos, CrossFit o Boxeo)'; end if;
  if c.clase is null then raise exception 'No hay ninguna clase de CrossFit'; end if;
  if exists (select 1 from packs where name like 'ZZ PRUEBA REVERTIR%') then
    raise exception 'Ya hay packs llamados "ZZ PRUEBA REVERTIR..."';
  end if;
  select string_agg(column_name, ', ') into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'packs' and is_nullable = 'NO' and column_default is null
    and column_name not in ('name', 'price', 'creditos', 'incluye_aparatos', 'dias_vigencia', 'is_active');
  if v_cols is not null then raise exception 'packs tiene columnas obligatorias que este script no carga: %', v_cols; end if;
  if coalesce((select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'user_credits' and column_name = 'created_at'), '') not like 'now()%'
     or coalesce((select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'pagos_socio' and column_name = 'created_at'), '') not like 'now()%' then
    raise exception 'created_at de user_credits o pagos_socio no tiene default now(): la identificación del pago no aplica';
  end if;
  perform pg_temp.como(c.u);
  if not public.is_active_socio() then raise exception 'La cuenta de prueba no pasa is_active_socio()'; end if;
end $$;

create temp table _antes as select pg_temp.huella_cuenta() as huella;

-- ── 0: versión instalada ──
insert into _log(caso, linea)
select '0 versión', 'NOTA      ' || case
  when prosrc like '%fecha_vencimiento_antes%' and prosrc like '%insert into user_credits%'
    then 'admin_revertir_comprobante = versión ACTUAL (sin migrar): se esperan FALLA en los chequeos marcados'
  when prosrc like '%filas_vencidas%'
    then 'admin_revertir_comprobante = versión NUEVA (regla F): todo tiene que dar OK'
  else 'admin_revertir_comprobante = versión desconocida' end
from pg_proc where proname = 'admin_revertir_comprobante' and pronamespace = 'public'::regnamespace;

-- Triggers que podrían disparar algo externo al insertar (ej. un push). Si los hay, revisar
-- antes de correr: lo que encolan por pg_net se deshace con la subtransacción, otra cosa no.
insert into _log(caso, linea)
select '0 versión', 'NOTA      triggers en ' || coalesce(string_agg(distinct event_object_table || '.' || trigger_name, ', '), 'ninguno')
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table in ('notifications', 'pagos_socio', 'user_credits', 'bookings', 'socios');

-- ── 1: pago créditos + Aparatos, recién hecho ──
do $$
declare c record; v_l text[] := '{}'; v_pago uuid; r record; v_filas bigint; v_notif bigint; v_otros text; s record;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_pago := pg_temp.pagar(pg_temp.pack('1', jsonb_build_array(pg_temp.cred(c.crossfit, 8)), true));
    v_l := v_l || pg_temp.chk(pg_temp.habilitado(c.aparatos) and pg_temp.habilitado(c.crossfit), 'control: el pago habilita Aparatos y CrossFit');
    v_filas := pg_temp.filas();
    v_notif := (select count(*) from notifications where target_user_id = c.u);
    v_otros := pg_temp.huella_otros();
    r := pg_temp.revertir(v_pago);
    v_l := v_l || pg_temp.chk(r.ok, 'revertir devuelve reversion_ok = true');
    v_l := v_l || pg_temp.chk(not pg_temp.habilitado(c.aparatos), 'el Aparatos del pago deja de habilitar (falla con la función actual)');
    v_l := v_l || pg_temp.chk(not pg_temp.habilitado(c.crossfit), 'CrossFit deja de habilitar');
    v_l := v_l || pg_temp.chk(pg_temp.pago_vencido(v_pago), 'todo lo del pago quedó vencido y en 0 (falla con la función actual)');
    v_l := v_l || pg_temp.chk(pg_temp.filas() = v_filas, 'no se insertó ninguna fila en user_credits (falla con la función actual)');
    select creditos, fecha_vencimiento into s from socios where dni = '44537978';
    v_l := v_l || pg_temp.chk(s.creditos = 0 and s.fecha_vencimiento < c.hoy,
      format('Admin: créditos 0 y fecha anterior a hoy (quedó %s créditos y %s)', s.creditos, s.fecha_vencimiento));
    v_l := v_l || pg_temp.chk((select estado = 'anulado' and detalle_acreditacion ? 'reversion' from pagos_socio where id = v_pago),
      'el pago queda anulado y con el detalle de la reversión (falla con la función actual)');
    v_l := v_l || pg_temp.chk((select count(*) from notifications where target_user_id = c.u) = v_notif + 1, '1 notificación al socio');
    v_l := v_l || pg_temp.chk(r.aviso is null, format('sin avisos para Seba (vino: %s) (falla con la función actual)', coalesce(r.aviso, 'nada')));
    v_l := v_l || pg_temp.chk(pg_temp.huella_otros() = v_otros, 'no cambió nada de otros socios');
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '1 créditos + Aparatos', unnest(v_l);
end $$;

-- ── 2: había un plan anterior con Aparatos: no se restaura ──
do $$
declare c record; v_l text[] := '{}'; v_a uuid; v_b uuid; r record; v_filas bigint; v_huella_a text;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_a := pg_temp.pagar(pg_temp.pack('2a', jsonb_build_array(pg_temp.cred(c.crossfit, 8)), true));
    perform pg_temp.correr(v_a, now() - interval '10 days');
    v_b := pg_temp.pagar(pg_temp.pack('2b', jsonb_build_array(pg_temp.cred(c.crossfit, 4)), true));
    v_filas := pg_temp.filas();
    v_huella_a := pg_temp.huella_pago(v_a);
    r := pg_temp.revertir(v_b);
    v_l := v_l || pg_temp.chk(r.ok, 'revertir devuelve reversion_ok = true');
    v_l := v_l || pg_temp.chk(pg_temp.vigentes() = 0, format('no queda nada vigente: no se restauró el plan anterior (quedan %s) (falla con la función actual)', pg_temp.vigentes()));
    v_l := v_l || pg_temp.chk(not pg_temp.habilitado(c.aparatos), 'Aparatos no habilita (falla con la función actual)');
    v_l := v_l || pg_temp.chk(pg_temp.filas() = v_filas, 'no se insertó ninguna fila (falla con la función actual)');
    v_l := v_l || pg_temp.chk(pg_temp.huella_pago(v_a) = v_huella_a, 'el pago anterior y sus filas no se tocaron');
    v_l := v_l || pg_temp.chk((select estado from pagos_socio where id = v_a) = 'pagado', 'el pago anterior sigue "pagado"');
    v_l := v_l || pg_temp.chk((select fecha_vencimiento from socios where dni = '44537978') < c.hoy,
      'Admin: fecha anterior a hoy, no la del plan anterior (falla con la función actual)');
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '2 no restaura el anterior', unnest(v_l);
end $$;

-- ── 3: pago después de las 21:00 ART ──
do $$
declare c record; v_l text[] := '{}'; v_pago uuid; r record; v_cuando timestamptz;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_cuando := ((c.hoy - 1)::timestamp + interval '22 hours 30 minutes') at time zone 'America/Argentina/Mendoza';
    v_pago := pg_temp.pagar(pg_temp.pack('3', jsonb_build_array(pg_temp.cred(c.crossfit, 8)), true));
    perform pg_temp.correr(v_pago, v_cuando);
    v_l := v_l || pg_temp.chk(pg_temp.habilitado(c.aparatos), 'control: pagado ayer 22:30 ART, habilita Aparatos');
    r := pg_temp.revertir(v_pago);
    v_l := v_l || pg_temp.chk(r.ok, 'revertir devuelve reversion_ok = true');
    v_l := v_l || pg_temp.chk(not pg_temp.habilitado(c.aparatos), 'el Aparatos del pago deja de habilitar (falla con la función actual)');
    v_l := v_l || pg_temp.chk(pg_temp.pago_vencido(v_pago), 'todo lo del pago quedó vencido y en 0 (falla con la función actual)');
    v_l := v_l || pg_temp.chk(r.aviso is null, format('sin avisos para Seba (vino: %s) (falla con la función actual)', coalesce(r.aviso, 'nada')));
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '3 pago 22:30 ART', unnest(v_l);
end $$;

-- ── 4: créditos parcialmente usados + reserva futura con ese lote ──
do $$
declare c record; v_l text[] := '{}'; v_pago uuid; r record; v_lote uuid; v_fecha date; v_dias int[]; v_venc timestamptz;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_pago := pg_temp.pagar(pg_temp.pack('4', jsonb_build_array(pg_temp.cred(c.crossfit, 8)), false));
    v_lote := ((select detalle_acreditacion from pagos_socio where id = v_pago)->'creditos'->0->>'lote_id')::uuid;
    select days_of_week into v_dias from classes where id = c.clase;
    select g::date into v_fecha
    from generate_series(c.hoy + 2, c.hoy + 9, interval '1 day') g
    where extract(dow from g)::int = any (v_dias)
      and not exists (select 1 from bookings b where b.user_id = c.u and b.class_id = c.clase and b.booking_date = g::date)
    order by g limit 1;
    if v_fecha is null then raise exception 'La clase de CrossFit no tiene ningún día libre para la cuenta de prueba en la próxima semana'; end if;
    -- Usó 3 de 8: dos clases ya pasadas y una reservada a futuro con este lote.
    update user_credits set remaining_credits = 5 where id = v_lote;
    insert into bookings (user_id, class_id, booking_date, credit_lote_id) values (c.u, c.clase, v_fecha, v_lote);
    r := pg_temp.revertir(v_pago);
    select expires_at into v_venc from user_credits where id = v_lote;
    v_l := v_l || pg_temp.chk((select remaining_credits = 0 and expires_at <= now() from user_credits where id = v_lote),
      'el lote quedó en 0 y vencido (falla con la función actual)');
    v_l := v_l || pg_temp.chk(exists (select 1 from bookings where user_id = c.u and class_id = c.clase and booking_date = v_fecha),
      'la reserva futura NO se cancela');
    v_l := v_l || pg_temp.chk(coalesce(r.aviso, '') like '%reserva%' and coalesce(r.aviso, '') like '%' || to_char(v_fecha, 'DD/MM') || '%',
      format('se le avisa a Seba la reserva futura (vino: %s) (falla con la función actual)', coalesce(r.aviso, 'nada')));
    -- El socio cancela esa reserva: el crédito NO vuelve (el lote quedó vencido).
    perform pg_temp.como(c.u);
    perform public.cancel_booking(c.clase, v_fecha, 'zz prueba');
    v_l := v_l || pg_temp.chk((select remaining_credits = 0 and expires_at is not distinct from v_venc from user_credits where id = v_lote),
      'al cancelar el socio, el lote revertido no revive (falla con la función actual)');
    v_l := v_l || pg_temp.chk(pg_temp.vigentes() = 0, 'y el crédito no aparece en ningún otro lote (falla con la función actual)');
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '4 usados + reserva futura', unnest(v_l);
end $$;

-- ── 5: revertir dos veces ──
do $$
declare c record; v_l text[] := '{}'; v_pago uuid; r1 record; r2 record; v_h text;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_pago := pg_temp.pagar(pg_temp.pack('5', jsonb_build_array(pg_temp.cred(c.crossfit, 8)), true));
    r1 := pg_temp.revertir(v_pago);
    v_h := pg_temp.huella_cuenta();
    r2 := pg_temp.revertir(v_pago);
    v_l := v_l || pg_temp.chk(r1.ok and not r2.ok, 'la 1ª devuelve true y la 2ª false');
    v_l := v_l || pg_temp.chk(pg_temp.huella_cuenta() = v_h, 'la 2ª no cambia nada (ni créditos, ni pago, ni ficha, ni notificaciones)');
    v_l := v_l || pg_temp.chk(coalesce(r2.aviso, '') like '%ya estaba revertido%',
      format('la 2ª explica por qué (vino: %s) (falla con la función actual)', coalesce(r2.aviso, 'nada')));
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '5 dos veces', unnest(v_l);
end $$;

-- ── 6: pago sin Aparatos (el plan anterior sí tenía) ──
do $$
declare c record; v_l text[] := '{}'; v_a uuid; v_b uuid; r record; v_filas bigint;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_a := pg_temp.pagar(pg_temp.pack('6a', jsonb_build_array(pg_temp.cred(c.crossfit, 8)), true));
    perform pg_temp.correr(v_a, now() - interval '10 days');
    v_b := pg_temp.pagar(pg_temp.pack('6b', jsonb_build_array(pg_temp.cred(c.crossfit, 4)), false));
    v_filas := pg_temp.filas();
    r := pg_temp.revertir(v_b);
    v_l := v_l || pg_temp.chk(r.ok, 'revertir devuelve reversion_ok = true');
    v_l := v_l || pg_temp.chk(not pg_temp.habilitado(c.aparatos), 'no vuelve el Aparatos del plan anterior');
    v_l := v_l || pg_temp.chk(pg_temp.pago_vencido(v_b), 'los créditos del pago quedaron vencidos y en 0 (falla con la función actual)');
    v_l := v_l || pg_temp.chk(pg_temp.vigentes() = 0, 'no queda nada vigente');
    v_l := v_l || pg_temp.chk(pg_temp.filas() = v_filas, 'no se insertó ninguna fila');
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '6 sin Aparatos', unnest(v_l);
end $$;

-- ── 7: pago solo con Aparatos ──
do $$
declare c record; v_l text[] := '{}'; v_pago uuid; r record; v_filas bigint;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_pago := pg_temp.pagar(pg_temp.pack('7', '[]'::jsonb, true));
    v_filas := pg_temp.filas();
    r := pg_temp.revertir(v_pago);
    v_l := v_l || pg_temp.chk(r.ok, 'revertir devuelve reversion_ok = true');
    v_l := v_l || pg_temp.chk(not pg_temp.habilitado(c.aparatos), 'el Aparatos del pago deja de habilitar (falla con la función actual)');
    v_l := v_l || pg_temp.chk(pg_temp.filas() = v_filas, 'no se insertó ninguna fila (falla con la función actual)');
    v_l := v_l || pg_temp.chk((select fecha_vencimiento from socios where dni = '44537978') < c.hoy,
      'Admin: fecha anterior a hoy');
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '7 solo Aparatos', unnest(v_l);
end $$;

-- ── 8: Aparatos con la fecha cambiada a mano después del pago ──
do $$
declare c record; v_l text[] := '{}'; v_pago uuid; r record;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_pago := pg_temp.pagar(pg_temp.pack('8', jsonb_build_array(pg_temp.cred(c.crossfit, 8)), true));
    perform pg_temp.como(c.admin);
    perform public.admin_editar_fecha_vencimiento_socio(c.u, c.hoy + 45);
    r := pg_temp.revertir(v_pago);
    v_l := v_l || pg_temp.chk(r.ok, 'revertir devuelve reversion_ok = true');
    v_l := v_l || pg_temp.chk(not pg_temp.habilitado(c.aparatos), 'el Aparatos del pago deja de habilitar aunque se le cambió la fecha (falla con la función actual)');
    v_l := v_l || pg_temp.chk(not pg_temp.habilitado(c.crossfit), 'CrossFit deja de habilitar');
    v_l := v_l || pg_temp.chk(coalesce(r.aviso, '') like '%cambiada a mano%',
      format('se le avisa a Seba que tenía la fecha cambiada (vino: %s) (falla con la función actual)', coalesce(r.aviso, 'nada')));
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '8 fecha a mano', unnest(v_l);
end $$;

-- ── 9: comprobante viejo sin lote_id ──
do $$
declare c record; v_l text[] := '{}'; v_pago uuid; r record; v_filas bigint;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_pago := pg_temp.pagar(pg_temp.pack('9', jsonb_build_array(pg_temp.cred(c.crossfit, 8), pg_temp.cred(c.boxeo, 4)), false));
    update pagos_socio
    set detalle_acreditacion = jsonb_set(detalle_acreditacion, '{creditos}',
      (select jsonb_agg(e - 'lote_id') from jsonb_array_elements(detalle_acreditacion->'creditos') e))
    where id = v_pago;
    v_filas := pg_temp.filas();
    r := pg_temp.revertir(v_pago);
    v_l := v_l || pg_temp.chk(r.ok, 'revertir devuelve reversion_ok = true');
    v_l := v_l || pg_temp.chk(pg_temp.filas() = v_filas, 'no se insertó ninguna fila (falla con la función actual)');
    v_l := v_l || pg_temp.chk(pg_temp.pago_vencido(v_pago), 'los dos lotes del pago quedaron vencidos y en 0 (falla con la función actual)');
    v_l := v_l || pg_temp.chk(not pg_temp.habilitado(c.crossfit) and not pg_temp.habilitado(c.boxeo), 'CrossFit y Boxeo dejan de habilitar (falla con la función actual)');
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '9 sin lote_id', unnest(v_l);
end $$;

-- ── 10: créditos cargados a mano DESPUÉS del pago ──
do $$
declare c record; v_l text[] := '{}'; v_pago uuid; r record; v_boxeo timestamptz; s record;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_pago := pg_temp.pagar(pg_temp.pack('10', jsonb_build_array(pg_temp.cred(c.crossfit, 8)), true));
    -- Dentro de una transacción now() no cambia: sin esto la carga manual quedaría con el mismo
    -- created_at que el pago. En la vida real son transacciones distintas.
    perform pg_temp.correr(v_pago, now() - interval '1 hour');
    perform pg_temp.como(c.admin);
    perform public.admin_fijar_creditos_disciplina(c.u, c.boxeo, 3);
    select expires_at into v_boxeo from user_credits
    where user_id = c.u and discipline_id = c.boxeo and remaining_credits = 3 and expires_at > now();
    r := pg_temp.revertir(v_pago);
    v_l := v_l || pg_temp.chk(not pg_temp.habilitado(c.aparatos) and not pg_temp.habilitado(c.crossfit), 'Aparatos y CrossFit del pago dejan de habilitar (falla con la función actual)');
    v_l := v_l || pg_temp.chk(pg_temp.habilitado(c.boxeo), 'Boxeo cargado a mano después NO se toca');
    v_l := v_l || pg_temp.chk(coalesce(r.aviso, '') like '%Sigue vigente%Boxeo (3 créditos)%',
      format('se le avisa a Seba qué sigue vigente (vino: %s) (falla con la función actual)', coalesce(r.aviso, 'nada')));
    select creditos, fecha_vencimiento into s from socios where dni = '44537978';
    v_l := v_l || pg_temp.chk(s.creditos = 3 and s.fecha_vencimiento = (v_boxeo at time zone 'America/Argentina/Mendoza')::date,
      format('Admin: 3 créditos y la fecha de Boxeo (quedó %s y %s) (falla con la función actual)', s.creditos, s.fecha_vencimiento));
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '10 manual después', unnest(v_l);
end $$;

-- ── 11: revertir un pago viejo ya reemplazado por otro ──
do $$
declare c record; v_l text[] := '{}'; v_a uuid; v_b uuid; r record; v_huella_b text; v_otros text; v_fecha_b date;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_a := pg_temp.pagar(pg_temp.pack('11a', jsonb_build_array(pg_temp.cred(c.crossfit, 8)), true));
    perform pg_temp.correr(v_a, now() - interval '10 days');
    v_b := pg_temp.pagar(pg_temp.pack('11b', jsonb_build_array(pg_temp.cred(c.crossfit, 4)), true));
    v_huella_b := pg_temp.huella_pago(v_b);
    v_otros := pg_temp.huella_otros();
    v_fecha_b := (select (expires_at at time zone 'America/Argentina/Mendoza')::date from user_credits
                  where user_id = c.u and discipline_id = c.aparatos and created_at = (select created_at from pagos_socio where id = v_b));
    r := pg_temp.revertir(v_a);
    v_l := v_l || pg_temp.chk(r.ok, 'revertir devuelve reversion_ok = true');
    v_l := v_l || pg_temp.chk(pg_temp.huella_pago(v_b) = v_huella_b, 'el pago nuevo y sus filas no se tocaron');
    v_l := v_l || pg_temp.chk(pg_temp.habilitado(c.aparatos) and pg_temp.habilitado(c.crossfit), 'el socio sigue habilitado por el pago nuevo');
    v_l := v_l || pg_temp.chk(coalesce(r.aviso, '') like '%ya estaba vencido%' and coalesce(r.aviso, '') like '%Sigue vigente%',
      format('se le avisa a Seba que no había nada para quitar y qué sigue vigente (vino: %s) (falla con la función actual)', coalesce(r.aviso, 'nada')));
    v_l := v_l || pg_temp.chk((select creditos = 4 and fecha_vencimiento = v_fecha_b from socios where dni = '44537978'),
      'Admin: queda con los créditos y la fecha del pago nuevo');
    v_l := v_l || pg_temp.chk(pg_temp.huella_otros() = v_otros, 'no cambió nada de otros socios');
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '11 pago viejo reemplazado', unnest(v_l);
end $$;

-- ── 12: lote que no creó este pago -> error claro, no cambia nada ──
do $$
declare c record; v_l text[] := '{}'; v_pago uuid; r record; v_h text; v_error text;
begin
  begin
    select * into c from pg_temp._ctx;
    perform pg_temp.limpiar();
    v_pago := pg_temp.pagar(pg_temp.pack('12', jsonb_build_array(pg_temp.cred(c.crossfit, 8)), false));
    -- Como en los comprobantes de antes del 10/09, cuando el crédito se sumaba a un lote existente.
    update user_credits set created_at = created_at - interval '3 days'
    where id = ((select detalle_acreditacion from pagos_socio where id = v_pago)->'creditos'->0->>'lote_id')::uuid;
    v_h := pg_temp.huella_cuenta();
    begin
      r := pg_temp.revertir(v_pago);
      v_error := null;
    exception when others then
      v_error := sqlerrm;
    end;
    v_l := v_l || pg_temp.chk(v_error like 'No se pudo revertir%No se cambió nada%',
      format('da error claro (vino: %s) (falla con la función actual)', coalesce(v_error, 'sin error')));
    v_l := v_l || pg_temp.chk(pg_temp.huella_cuenta() = v_h, 'no cambió nada (falla con la función actual)');
    v_l := v_l || pg_temp.chk((select estado from pagos_socio where id = v_pago) = 'pagado', 'el pago sigue "pagado" (falla con la función actual)');
    raise exception 'DESHACER' using errcode = 'P0999';
  exception when sqlstate 'P0999' then null;
    when others then v_l := v_l || ('FALLA     ERROR INESPERADO: ' || sqlerrm);
  end;
  insert into pg_temp._log(caso, linea) select '12 lote no identificable', unnest(v_l);
end $$;

-- ── FINAL ──
insert into _log(caso, linea)
select 'FINAL', pg_temp.chk((select huella from _antes) = pg_temp.huella_cuenta(),
  'la cuenta de prueba (créditos, pagos, ficha, reservas, notificaciones) y los packs quedaron idénticos');

insert into _log(caso, linea)
select 'RESUMEN', format('%s OK, %s FALLA',
  count(*) filter (where linea like 'OK%'), count(*) filter (where linea like 'FALLA%'))
from _log;

commit;

select caso, linea from pg_temp._log order by n;
