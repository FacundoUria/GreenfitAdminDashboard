-- =====================================================================================
-- REGLA A -- los lotes NUEVOS vencen al final del día en Argentina, no a la hora exacta de la
-- compra.
-- Corrida en producción el 15/11/2026. Prueba (prueba_regla_a_corte_fin_de_dia.sql): 16 de 16.
-- Es la v2: la v1 frenó sola en la guarda 5 (no aplicó nada) porque buscaba current_date en
-- la definición entera, y acreditar_pack y admin_acreditar_creditos_manual lo nombran en
-- comentarios. La v2 lo busca solo en el código y nombra qué chequeo falla en cada función.
--
-- Regla A: vence pago + 30 días (o los días del pack), se usa TODO ese día, corte al final del
-- día en Argentina: ((dia + 1)::timestamp at time zone 'America/Argentina/Mendoza') - 1 µs.
-- Es la misma convención que ya usan admin_editar_fecha_vencimiento_socio (T2) y el cobro con
-- fecha de inicio (rama "else" de admin_acreditar_creditos_manual, T2).
--
-- El bug: en los últimos 20 días hay lotes con expires_at a las 11:05, 15:48, 18:14 (AR): la
-- app y la ficha muestran "hasta el dd/mm", pero el socio pierde el lote ese día a la hora en
-- que compró.
--
-- Las 6 funciones que calculaban la fecha del plan nuevo con now() + días (barrido completo de
-- los .sql del repo; la guarda 3 repite el barrido en la base y frena si aparece una 7ª):
--   acreditar_pack                     now() + (coalesce(v_dias_vigencia, 30) || ' days')::interval
--        -> la usan admin_aprobar_comprobante, la acreditación automática del comprobante
--           (crear_pago_pendiente_transferencia) y mp_process_payment: se arreglan las 3 con esta.
--   admin_acreditar_creditos_manual    now() + (p_dias_vigencia || ' days')::interval
--        -> SOLO la rama sin p_fecha_inicio (la otra ya era fin de día desde T2).
--   resolver_fecha_plan_actual         coalesce(fecha_plan_socio(...), now() + interval '30 days')
--   admin_fijar_creditos_disciplina    coalesce(v_fecha_existente, now() + interval '30 days')
--   admin_ajustar_credito_disciplina   coalesce(v_fecha_existente, now() + interval '30 days')
--   admin_agregar_aparatos_socio       coalesce(v_fecha_existente, now() + interval '30 days')
-- Cada una pasa a:
--   (((now() at time zone 'America/Argentina/Mendoza')::date + <días> + 1)::timestamp
--      at time zone 'America/Argentina/Mendoza') - interval '1 microsecond'
--
-- El DÍA no cambia: (now() + N días) en Argentina y (hoy AR + N) son el mismo día calendario
-- (Argentina no tiene horario de verano). Lo que se ve en la app, la ficha (fecha_vencimiento),
-- lo que devuelven las funciones y lo que compara admin_revertir_comprobante (por día) queda
-- igual. Solo se corre la hora de corte: de la hora de la compra a las 23:59:59.999999.
--
-- Solo lotes NUEVOS: ningún UPDATE/DELETE/INSERT sobre user_credits ni socios. Los lotes que
-- ya existen quedan como están. OJO: fijar/ajustar/agregar Aparatos sobre un plan vigente
-- SIGUEN copiando la fecha exacta de ese plan (fecha_plan_socio): si el plan vence a las 11:05,
-- el lote agregado también. Es a propósito (una sola fecha, y los existentes no se tocan).
--
-- Candado T7 (una sola fecha vigente): NO choca. El candado compara por DÍA en Argentina
-- (ultimo_dia_plan = (expires_at at time zone AR)::date), no por instante: un lote a las 11:05
-- del 15/12 y otro a las 23:59:59.999999 del 15/12 son UNA fecha. Y ningún flujo mezcla un
-- lote nuevo de fin de día con un plan de OTRO día: acreditar_pack y el cobro manual vencen
-- todo lo anterior antes de acreditar; fijar/ajustar/agregar usan la fecha del plan vigente y
-- solo inventan hoy + 30 cuando no hay ninguno. La prueba lo verifica (casos T7a a T7d).
--
-- Igual que Tanda B: el cuerpo NO se reescribe a mano. Se toma la definición ACTUAL de
-- producción (pg_get_functiondef) y se cambia SOLO esa expresión. Todo lo demás (lógica,
-- comentarios, security definer, permisos) queda idéntico. Respaldo en
-- respaldo.regla_a_funciones (no expuesto por la API); rollback_regla_a_corte_fin_de_dia.sql
-- vuelve EXACTAMENTE a la versión de antes.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) HUELLA sin espacios de las 6 = la de producción (la consulta (A) de
--      investigacion_pendientes_y_regla_a.sql): T1 / T2 / T3.
--   2) No aplicada todavía (no existe respaldo.regla_a_funciones).
--   3) BARRIDO: entre las funciones de public (plpgsql/sql) que mencionan user_credits,
--      expires_at, fecha_plan o fecha_vencimiento, las que suman días a now() en el código (sin
--      comentarios) son EXACTAMENTE estas 6, y cada una lo hace UNA sola vez.
--   4) La expresión a cambiar aparece EXACTAMENTE 1 vez en cada una (contando comentarios) y la
--      nueva 0 veces.
--   5) DESPUÉS: huella sin espacios = la de la definición original con solo la expresión
--      cambiada; la vieja 0 veces y la nueva 1 vez; permisos (proacl EXACTO), security definer,
--      volatilidad y config EXACTAMENTE iguales; el barrido da 0; sin current_date en el
--      código (sin comentarios: acreditar_pack y el cobro manual lo nombran en comentarios); y
--      el error nombra qué chequeo falló en cada función; y
--      resolver_fecha_plan_actual de un socio sin nada da el fin del día hoy + 30 en Argentina.
--
-- Sin guarda de horario: "hoy" sale de now() en Argentina, no del día UTC.
-- Prueba: prueba_regla_a_corte_fin_de_dia.sql (DESPUÉS de esta migración).
-- Rollback: rollback_regla_a_corte_fin_de_dia.sql.
-- =====================================================================================

begin;

set local lock_timeout = '5s';

-- ── Las 6 funciones, su huella de producción y el cambio exacto ───────────────────────
create temp table _regla_a on commit drop as
select x.*
from (values
  ('public.acreditar_pack(uuid, uuid, text, text)',
   'cd4f6062aa6bcf6241a1151e094686ae',
   $r$now\(\)\s*\+\s*\(\s*coalesce\(\s*v_dias_vigencia\s*,\s*30\s*\)\s*\|\|\s*' days'\s*\)\s*::\s*interval$r$,
   $r$(((now() at time zone 'America/Argentina/Mendoza')::date + coalesce(v_dias_vigencia, 30) + 1)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond'$r$),
  ('public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)',
   'de302991098cf77f2e60e4a3d41456c8',
   $r$now\(\)\s*\+\s*\(\s*p_dias_vigencia\s*\|\|\s*' days'\s*\)\s*::\s*interval$r$,
   $r$(((now() at time zone 'America/Argentina/Mendoza')::date + p_dias_vigencia + 1)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond'$r$),
  ('public.resolver_fecha_plan_actual(uuid)',
   '05f63efa8b16c9e5c96f2ef5a21289bf',
   $r$now\(\)\s*\+\s*interval\s*'30 days'$r$,
   $r$(((now() at time zone 'America/Argentina/Mendoza')::date + 30 + 1)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond'$r$),
  ('public.admin_fijar_creditos_disciplina(uuid, uuid, integer)',
   '32fa31b3ba16f674faf42f68f14fc3e2',
   $r$now\(\)\s*\+\s*interval\s*'30 days'$r$,
   $r$(((now() at time zone 'America/Argentina/Mendoza')::date + 30 + 1)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond'$r$),
  ('public.admin_ajustar_credito_disciplina(uuid, uuid, integer)',
   'a34f0d9b63aed24d3a67747ed89f88cb',
   $r$now\(\)\s*\+\s*interval\s*'30 days'$r$,
   $r$(((now() at time zone 'America/Argentina/Mendoza')::date + 30 + 1)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond'$r$),
  ('public.admin_agregar_aparatos_socio(uuid)',
   'c93d54418f8ca3e3ac82f7925278b3c6',
   $r$now\(\)\s*\+\s*interval\s*'30 days'$r$,
   $r$(((now() at time zone 'America/Argentina/Mendoza')::date + 30 + 1)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond'$r$)
) as x(firma, esperada, patron, reemplazo);

-- Mismo criterio de barrido antes y después (guardas 3 y 5).
create or replace function pg_temp.regla_a_barrido() returns table(firma text, veces int) language sql stable as $f$
  select p.oid::regprocedure::text,
         (select count(*)::int
            from regexp_matches(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'),
                                $r$now\(\)\s*\+\s*(interval\s*'[^']*day|\([^;]*day[^;]*\)\s*::\s*interval|make_interval|[a-z_0-9]+\s*\*\s*interval\s*'[^']*day)$r$, 'gi'))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
    and l.lanname in ('plpgsql', 'sql')
    and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'user_credits|expires_at|fecha_plan|fecha_vencimiento'
    and regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
        ~* $r$now\(\)\s*\+\s*(interval\s*'[^']*day|\([^;]*day[^;]*\)\s*::\s*interval|make_interval|[a-z_0-9]+\s*\*\s*interval\s*'[^']*day)$r$;
$f$;

-- Veces que aparece un texto LITERAL (la expresión nueva) en otro.
create or replace function pg_temp.regla_a_veces(p_texto text, p_buscar text) returns int language sql immutable as $f$
  select ((length(p_texto) - length(replace(p_texto, p_buscar, ''))) / length(p_buscar))::int;
$f$;

-- ── Guardas 1 a 4 ─────────────────────────────────────────────────────────────────────
do $guarda$
declare
  v_txt text;
begin
  -- 1) Existen, son únicas con ese nombre y tienen la huella de producción.
  select string_agg(x.firma || ' (esperada ' || x.esperada || ', hay '
                    || coalesce(md5(regexp_replace(pg_get_functiondef(to_regprocedure(x.firma)), '\s+', '', 'g')), 'no existe') || ')', ', ')
    into v_txt
  from _regla_a x
  where to_regprocedure(x.firma) is null
     or md5(regexp_replace(pg_get_functiondef(to_regprocedure(x.firma)), '\s+', '', 'g')) <> x.esperada
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = (select proname from pg_proc where oid = to_regprocedure(x.firma))) <> 1;
  if v_txt is not null then
    raise exception 'Regla A: estas funciones no son la versión de producción conocida (o tienen otra versión con el mismo nombre): %. No se aplicó nada.', v_txt;
  end if;

  -- 2) No aplicada.
  if to_regclass('respaldo.regla_a_funciones') is not null then
    raise exception 'Regla A: ya existe respaldo.regla_a_funciones (¿ya aplicada?). No se aplicó nada.';
  end if;

  -- 3) Barrido: exactamente estas 6, una vez cada una.
  select string_agg(b.firma || ' (' || b.veces || ' vez/veces)', ', ') into v_txt
  from pg_temp.regla_a_barrido() b
  where to_regprocedure(b.firma) not in (select to_regprocedure(firma) from _regla_a)
     or b.veces <> 1;
  if v_txt is not null then
    raise exception 'Regla A: hay funciones que calculan fechas de plan con now() + días y esta migración no contempla (o lo hacen más de una vez): %. No se aplicó nada.', v_txt;
  end if;
  select string_agg(x.firma, ', ') into v_txt
  from _regla_a x
  where to_regprocedure(x.firma) not in (select to_regprocedure(b.firma) from pg_temp.regla_a_barrido() b);
  if v_txt is not null then
    raise exception 'Regla A: el barrido no encuentra now() + días en: %. No se aplicó nada.', v_txt;
  end if;

  -- 4) La expresión vieja 1 vez (contando comentarios) y la nueva 0.
  select string_agg(x.firma || ' (vieja ' || v.viejas || ', nueva ' || v.nuevas || ')', ', ') into v_txt
  from _regla_a x
  cross join lateral (
    select (select count(*) from regexp_matches(pg_get_functiondef(to_regprocedure(x.firma)), x.patron, 'gi'))::int as viejas,
           pg_temp.regla_a_veces(pg_get_functiondef(to_regprocedure(x.firma)), x.reemplazo) as nuevas
  ) v
  where v.viejas <> 1 or v.nuevas <> 0;
  if v_txt is not null then
    raise exception 'Regla A: la expresión a cambiar no aparece exactamente 1 vez (o la nueva ya está): %. No se aplicó nada.', v_txt;
  end if;
end;
$guarda$;

-- ── Respaldo ──────────────────────────────────────────────────────────────────────────
create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

create table respaldo.regla_a_funciones (
  funcion                    text primary key,
  definicion_antes           text not null,
  huella_antes               text not null,
  huella_antes_sin_espacios  text not null,
  definicion_nueva           text not null,
  huella_nueva_sin_espacios  text not null,
  reemplazo                  text not null,
  permisos                   text not null,
  security_definer           boolean not null,
  volatilidad                "char" not null,
  config                     text not null,
  guardado_en                timestamptz not null default now()
);
revoke all on respaldo.regla_a_funciones from public, anon, authenticated;

-- ── El cambio: solo la expresión, sobre la definición de producción ───────────────────
do $aplicar$
declare
  x record;
  r record;
  v_def text;
  v_nueva text;
begin
  for x in select * from _regla_a order by firma loop
    select p.oid, p.oid::regprocedure::text as funcion, p.proacl, p.prosecdef, p.provolatile, p.proconfig into r
    from pg_proc p where p.oid = to_regprocedure(x.firma);

    v_def := pg_get_functiondef(r.oid);
    v_nueva := regexp_replace(v_def, x.patron, x.reemplazo, 'i');

    insert into respaldo.regla_a_funciones
      (funcion, definicion_antes, huella_antes, huella_antes_sin_espacios, definicion_nueva, huella_nueva_sin_espacios,
       reemplazo, permisos, security_definer, volatilidad, config)
    values
      (r.funcion, v_def, md5(v_def), md5(regexp_replace(v_def, '\s+', '', 'g')), v_nueva, md5(regexp_replace(v_nueva, '\s+', '', 'g')),
       x.reemplazo, coalesce(r.proacl::text, '(por defecto)'), r.prosecdef, r.provolatile, coalesce(array_to_string(r.proconfig, ','), ''));

    execute v_nueva;
  end loop;
end;
$aplicar$;

-- ── Guarda 5: verificación DESPUÉS ────────────────────────────────────────────────────
do $verifica$
declare
  v_txt text;
  v_esperado timestamptz;
  v_obtenido timestamptz;
begin
  if (select count(*) from respaldo.regla_a_funciones) <> 6 then
    raise exception 'Regla A: el respaldo no tiene las 6 funciones. No se aplicó nada.';
  end if;

  -- Cada chequeo por separado, y el error dice CUÁL falló en cada función.
  -- current_date se busca solo en el CÓDIGO (sin comentarios): acreditar_pack y
  -- admin_acreditar_creditos_manual lo nombran en comentarios desde antes de Tanda B (la
  -- versión anterior de esta guarda miraba la definición entera y frenó por eso).
  select string_agg(c.funcion || ' [' || array_to_string(c.fallas, ', ') || ']', '; ') into v_txt
  from (
    select b.funcion,
           array_remove(array[
             case when md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', '', 'g')) <> b.huella_nueva_sin_espacios then 'huella' end,
             case when (select count(*) from regexp_matches(pg_get_functiondef(p.oid), x.patron, 'gi')) <> 0 then 'expresión vieja sigue' end,
             case when pg_temp.regla_a_veces(pg_get_functiondef(p.oid), x.reemplazo) <> 1 then 'expresión nueva no aparece 1 vez' end,
             case when regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mcurrent_date\M' then 'current_date en el código' end,
             case when coalesce(p.proacl::text, '(por defecto)') <> b.permisos then 'permisos' end,
             case when p.prosecdef <> b.security_definer
                    or p.provolatile <> b.volatilidad
                    or coalesce(array_to_string(p.proconfig, ','), '') <> b.config then 'atributos' end
           ], null) as fallas
    from respaldo.regla_a_funciones b
    join _regla_a x on to_regprocedure(x.firma) = to_regprocedure(b.funcion)
    join pg_proc p on p.oid = to_regprocedure(b.funcion)
  ) c
  where cardinality(c.fallas) > 0;
  if v_txt is not null then
    raise exception 'Regla A: estas funciones no quedaron como se esperaba: %. No se aplicó nada.', v_txt;
  end if;

  select string_agg(firma, ', ') into v_txt from pg_temp.regla_a_barrido();
  if v_txt is not null then
    raise exception 'Regla A: todavía quedan funciones con now() + días: %. No se aplicó nada.', v_txt;
  end if;

  -- Socio inexistente (sin nada): la fecha del plan nuevo es el fin del día hoy + 30 en AR.
  v_esperado := (((now() at time zone 'America/Argentina/Mendoza')::date + 31)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond';
  v_obtenido := public.resolver_fecha_plan_actual(gen_random_uuid());
  if v_obtenido is distinct from v_esperado then
    raise exception 'Regla A: resolver_fecha_plan_actual da % y se esperaba % (fin del día hoy + 30 en Argentina). No se aplicó nada.', v_obtenido, v_esperado;
  end if;

  select string_agg(funcion || ': antes ' || huella_antes_sin_espacios || ' / después ' || huella_nueva_sin_espacios, ' | ' order by funcion)
    into v_txt
  from respaldo.regla_a_funciones;
  raise notice 'Regla A aplicada. Plan nuevo de hoy vence: % (AR). Huellas sin espacios: %',
    (v_esperado at time zone 'America/Argentina/Mendoza'), v_txt;
end;
$verifica$;

-- Las auxiliares temporales viven en la sesión, no en la transacción: se borran a mano.
drop function pg_temp.regla_a_barrido();
drop function pg_temp.regla_a_veces(text, text);

commit;

-- Después de correrla (solo lectura):
--   select funcion, huella_nueva_sin_espacios,
--          md5(regexp_replace(pg_get_functiondef(funcion::regprocedure), '\s+', '', 'g')) = huella_nueva_sin_espacios as coincide,
--          permisos = coalesce((select proacl::text from pg_proc where oid = funcion::regprocedure), '(por defecto)') as permisos_iguales
--   from respaldo.regla_a_funciones order by 1;
--   + consulta (E) de investigacion_pendientes_y_regla_a.sql al día siguiente: el contador
--     hora_distinta_creados_ult_20_dias no tiene que crecer.
