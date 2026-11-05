-- =====================================================================================
-- TANDA B -- "hoy" es el día de Argentina, no el de UTC. NO SE CORRIÓ TODAVÍA.
-- ESTAMOS EN PRODUCCIÓN.
--
-- De acá en adelante, todo "hoy" = (now() at time zone 'America/Argentina/Mendoza')::date.
-- Los pagos viejos (los 26 con fecha del día siguiente) NO se tocan: ningún UPDATE, DELETE
-- ni INSERT sobre datos existentes.
--
-- 1) DEFAULTS DE COLUMNA (alter column ... set default: no toca ninguna fila):
--      asistencias.fecha, pagos_socio.fecha, socios.ultimo_pago, xp_events.event_date
--      CURRENT_DATE  ->  ((now() at time zone 'America/Argentina/Mendoza')::date)
--
-- 2) FUNCIONES (current_date en el CÓDIGO), reemplazadas con create or replace:
--      registrar_hoy_entrene()            2 current_date (cuenta del día + insert)
--      mp_process_payment(...)            2 current_date (periodo_desde / periodo_hasta)
--      admin_resetear_ranking()           1 current_date (event_date de la reversión)
--      community_ranking_mes(uuid)        2 current_date (desde el 1 del mes hasta hoy)
--    El cuerpo NO se reescribe a mano: se toma la definición ACTUAL de producción
--    (pg_get_functiondef) y se cambia SOLO cada current_date por la expresión de Argentina.
--    Todo lo demás (lógica, comentarios, security definer, permisos) queda idéntico.
--    NO se tocan: acreditar_pack y admin_acreditar_creditos_manual (current_date solo en
--    comentarios; la guarda 4 lo confirma).
--
-- 3) RESPALDO: esquema `respaldo` (no expuesto por la API, sin permisos para anon ni
--    authenticated) con la definición original de cada función, sus huellas y permisos, y
--    el default original de cada columna. rollback_tanda_b.sql vuelve EXACTAMENTE a eso.
--
-- Guardas (si alguna falla, no se aplica nada):
--   0) HORARIO: frena SOLO si el día UTC y el de Argentina son distintos (21:00 a 23:59 de
--      Argentina). Fuera de esa franja se puede correr.
--   0bis) HUELLA EXACTA (sin espacios) de las 4 funciones = la de producción (consulta A).
--      Son las que se pegaron al aplicarla en producción (05/11/2026).
--   1) Tanda B no aplicada todavía (no existe el esquema respaldo).
--   2) Los 4 defaults son EXACTAMENTE 'CURRENT_DATE'.
--   3) Cada función existe con esa firma exacta y es la única con ese nombre.
--   4) Cada función tiene EXACTAMENTE la cantidad de current_date de arriba (contando
--      comentarios), acreditar_pack y admin_acreditar_creditos_manual tienen 0 en el código,
--      y ninguna otra función de public (plpgsql o sql) tiene current_date en el código.
--   5) DESPUÉS: huella sin espacios de cada función = la de su definición original con solo
--      la fecha cambiada; 0 current_date; permisos, security definer, volatilidad y config
--      EXACTAMENTE iguales; los 4 defaults nuevos dan el día de Argentina.
--
-- Prueba: prueba_tanda_b.sql (DESPUÉS de esta migración, fuera de 21:00-23:59).
-- Rollback: rollback_tanda_b.sql.
--
-- APLICADA EN PRODUCCIÓN el 05/11/2026 (con las 4 huellas pegadas en la guarda 0bis).
-- Prueba: 12 de 13 OK. El caso (8) falla por un bug PREVIO, no de Tanda B:
-- mp_process_payment hace `on conflict (mercado_pago_payment_id) do nothing`, pero el
-- índice único idx_pagos_socio_mp_payment_id es parcial (where mercado_pago_payment_id is
-- not null) y no sirve para ese on conflict ("there is no unique or exclusion constraint
-- matching the ON CONFLICT specification"). Se arregla en la tanda MP.
--
-- Corrección A MANO, aparte de esta migración: antes de aplicarla, se cambiaron 2 filas de
-- xp_events grabadas el 04/11 entre las 21:00 y las 23:59 de Argentina con el día UTC
-- (ids cb2bdbf6… y 1c43fc22…): event_date 2026-11-05 -> 2026-11-04.
-- =====================================================================================

begin;

-- No quedarse esperando detrás de otra transacción larga (y trabar a todos los demás).
set local lock_timeout = '5s';

-- ── Guarda 0: horario ─────────────────────────────────────────────────────────────────
do $horario$
begin
  if current_date <> (now() at time zone 'America/Argentina/Mendoza')::date
     or (now() at time zone 'UTC')::date <> (now() at time zone 'America/Argentina/Mendoza')::date then
    raise exception 'Tanda B: entre las 21:00 y las 23:59 de Argentina no se puede aplicar (el día UTC ya es el siguiente). No se aplicó nada.';
  end if;
end;
$horario$;

-- ── Guardas 1 a 4 ─────────────────────────────────────────────────────────────────────
do $guarda$
declare
  v_txt text;
begin
  -- 0bis) HUELLA EXACTA de producción (sin espacios, la columna huella_sin_espacios de la
  --       consulta A), las que se pegaron al aplicarla en producción. Si no coincide, frena.
  select string_agg(x.firma || ' (esperada ' || x.esperada || ', hay '
                    || coalesce(md5(regexp_replace(pg_get_functiondef(to_regprocedure(x.firma)), '\s+', '', 'g')), 'no existe') || ')', ', ')
    into v_txt
  from (values
    ('public.registrar_hoy_entrene()', '356e925289191e0453b3424843814495'),
    ('public.mp_process_payment(uuid, uuid, jsonb, boolean, integer, uuid, numeric, text, text, text)', 'b8b8e7f51dead44f127532689b996c59'),
    ('public.admin_resetear_ranking()', 'e8bbeb71e9b0ec6b1ccbfd59ef58e9fa'),
    ('public.community_ranking_mes(uuid)', 'f989930e04a96937aeed7dad7f10f352')
  ) as x(firma, esperada)
  where to_regprocedure(x.firma) is null
     or md5(regexp_replace(pg_get_functiondef(to_regprocedure(x.firma)), '\s+', '', 'g')) <> x.esperada;
  if v_txt is not null then
    raise exception 'Tanda B: estas funciones no tienen la huella exacta de producción (o falta pegarla): %. No se aplicó nada.', v_txt;
  end if;

  -- 1) Tanda B no aplicada.
  if exists (select 1 from pg_namespace where nspname = 'respaldo') then
    raise exception 'Tanda B: ya existe el esquema respaldo (¿Tanda B ya aplicada?). No se aplicó nada.';
  end if;

  -- 2) Defaults exactos.
  select string_agg(x.tabla || '.' || x.columna || ' = ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '(sin default)'), ', ')
    into v_txt
  from (values ('asistencias', 'fecha'), ('pagos_socio', 'fecha'), ('socios', 'ultimo_pago'), ('xp_events', 'event_date')) as x(tabla, columna)
  left join pg_attribute a on a.attrelid = to_regclass('public.' || x.tabla) and a.attname = x.columna and not a.attisdropped
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum is null or d.adbin is null or pg_get_expr(d.adbin, d.adrelid) <> 'CURRENT_DATE';
  if v_txt is not null then
    raise exception 'Tanda B: estos defaults no son CURRENT_DATE (o no existen): %. No se aplicó nada.', v_txt;
  end if;

  -- 3) y 4) Firma exacta, única, y cantidad exacta de current_date.
  select string_agg(x.firma || ' (esperado ' || x.esperadas || ', hay '
                    || coalesce((select count(*) from regexp_matches(pg_get_functiondef(to_regprocedure(x.firma)), '\mcurrent_date\M', 'gi'))::text, 'no existe')
                    || ')', ', ')
    into v_txt
  from (values
    ('public.registrar_hoy_entrene()', 'registrar_hoy_entrene', 2),
    ('public.mp_process_payment(uuid, uuid, jsonb, boolean, integer, uuid, numeric, text, text, text)', 'mp_process_payment', 2),
    ('public.admin_resetear_ranking()', 'admin_resetear_ranking', 1),
    ('public.community_ranking_mes(uuid)', 'community_ranking_mes', 2)
  ) as x(firma, nombre, esperadas)
  where to_regprocedure(x.firma) is null
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = x.nombre) <> 1
     or (select count(*) from regexp_matches(pg_get_functiondef(to_regprocedure(x.firma)), '\mcurrent_date\M', 'gi')) <> x.esperadas
     or (select count(*) from regexp_matches((select prosrc from pg_proc where oid = to_regprocedure(x.firma)), '\mcurrent_date\M', 'gi')) <> x.esperadas;
  if v_txt is not null then
    raise exception 'Tanda B: estas funciones no son las esperadas (no existen, tienen otra versión con el mismo nombre, o cambió la cantidad de current_date): %. No se aplicó nada.', v_txt;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_txt
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
    and l.lanname in ('plpgsql', 'sql')
    and p.proname not in ('registrar_hoy_entrene', 'mp_process_payment', 'admin_resetear_ranking', 'community_ranking_mes')
    and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\m(current_date|localtimestamp|localtime)\M|now\(\)\s*::\s*date';
  if v_txt is not null then
    raise exception 'Tanda B: hay otras funciones con "hoy" en UTC en el código que esta migración no contempla: %. No se aplicó nada.', v_txt;
  end if;
end;
$guarda$;

-- ── Respaldo (esquema no expuesto por la API) ─────────────────────────────────────────
create schema respaldo;
revoke all on schema respaldo from public;
revoke all on schema respaldo from anon, authenticated;

create table respaldo.tanda_b_funciones (
  funcion                    text primary key,
  definicion_antes           text not null,
  huella_antes               text not null,
  huella_antes_sin_espacios  text not null,
  definicion_nueva           text not null,
  huella_nueva_sin_espacios  text not null,
  permisos                   text not null,
  security_definer           boolean not null,
  volatilidad                "char" not null,
  config                     text not null,
  guardado_en                timestamptz not null default now()
);

create table respaldo.tanda_b_defaults (
  tabla          text not null,
  columna        text not null,
  default_antes  text not null,
  default_nuevo  text,
  guardado_en    timestamptz not null default now(),
  primary key (tabla, columna)
);

revoke all on all tables in schema respaldo from public, anon, authenticated;

-- ── 1) Funciones: solo current_date -> día de Argentina ───────────────────────────────
do $aplicar$
declare
  r record;
  v_def text;
  v_nueva text;
begin
  for r in
    select p.oid, p.oid::regprocedure::text as funcion, p.proacl, p.prosecdef, p.provolatile, p.proconfig
    from pg_proc p
    where p.oid in ('public.registrar_hoy_entrene()'::regprocedure,
                    'public.mp_process_payment(uuid, uuid, jsonb, boolean, integer, uuid, numeric, text, text, text)'::regprocedure,
                    'public.admin_resetear_ranking()'::regprocedure,
                    'public.community_ranking_mes(uuid)'::regprocedure)
    order by 2
  loop
    v_def := pg_get_functiondef(r.oid);
    v_nueva := regexp_replace(v_def, '\mcurrent_date\M', '(now() at time zone ''America/Argentina/Mendoza'')::date', 'gi');

    insert into respaldo.tanda_b_funciones
      (funcion, definicion_antes, huella_antes, huella_antes_sin_espacios, definicion_nueva, huella_nueva_sin_espacios,
       permisos, security_definer, volatilidad, config)
    values
      (r.funcion, v_def, md5(v_def), md5(regexp_replace(v_def, '\s+', '', 'g')), v_nueva, md5(regexp_replace(v_nueva, '\s+', '', 'g')),
       coalesce(r.proacl::text, '(por defecto)'), r.prosecdef, r.provolatile, coalesce(array_to_string(r.proconfig, ','), ''));

    execute v_nueva;
  end loop;
end;
$aplicar$;

-- ── 2) Defaults de columna (no toca filas) ────────────────────────────────────────────
insert into respaldo.tanda_b_defaults (tabla, columna, default_antes)
values ('asistencias', 'fecha', 'CURRENT_DATE'),
       ('pagos_socio', 'fecha', 'CURRENT_DATE'),
       ('socios', 'ultimo_pago', 'CURRENT_DATE'),
       ('xp_events', 'event_date', 'CURRENT_DATE');

alter table public.asistencias alter column fecha       set default ((now() at time zone 'America/Argentina/Mendoza')::date);
alter table public.pagos_socio alter column fecha       set default ((now() at time zone 'America/Argentina/Mendoza')::date);
alter table public.socios      alter column ultimo_pago set default ((now() at time zone 'America/Argentina/Mendoza')::date);
alter table public.xp_events   alter column event_date  set default ((now() at time zone 'America/Argentina/Mendoza')::date);

update respaldo.tanda_b_defaults b
set default_nuevo = pg_get_expr(d.adbin, d.adrelid)
from pg_attribute a
join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where a.attrelid = ('public.' || b.tabla)::regclass and a.attname = b.columna;

-- ── Guarda 5: verificación DESPUÉS ────────────────────────────────────────────────────
do $verifica$
declare
  v_txt text;
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_fecha date;
  r record;
begin
  -- Funciones: quedó exactamente la definición nueva, sin current_date, mismos permisos y atributos.
  select string_agg(b.funcion, ', ') into v_txt
  from respaldo.tanda_b_funciones b
  join pg_proc p on p.oid = b.funcion::regprocedure
  where md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', '', 'g')) <> b.huella_nueva_sin_espacios
     or pg_get_functiondef(p.oid) ~* '\mcurrent_date\M'
     or pg_get_functiondef(p.oid) !~ 'America/Argentina/Mendoza'
     or coalesce(p.proacl::text, '(por defecto)') <> b.permisos
     or p.prosecdef <> b.security_definer
     or p.provolatile <> b.volatilidad
     or coalesce(array_to_string(p.proconfig, ','), '') <> b.config;
  if v_txt is not null then
    raise exception 'Tanda B: estas funciones no quedaron como se esperaba (huella, current_date, permisos o atributos): %. No se aplicó nada.', v_txt;
  end if;
  if (select count(*) from respaldo.tanda_b_funciones) <> 4 then
    raise exception 'Tanda B: el respaldo no tiene las 4 funciones. No se aplicó nada.';
  end if;

  -- Defaults: sin current_date y dan el día de Argentina.
  for r in select tabla, columna, default_nuevo from respaldo.tanda_b_defaults loop
    if r.default_nuevo is null or r.default_nuevo ~* 'current_date' or r.default_nuevo !~ 'America/Argentina/Mendoza' then
      raise exception 'Tanda B: el default de %.% quedó como %. No se aplicó nada.', r.tabla, r.columna, coalesce(r.default_nuevo, '(nada)');
    end if;
    execute 'select (' || r.default_nuevo || ')::date' into v_fecha;
    if v_fecha is distinct from v_hoy then
      raise exception 'Tanda B: el default de %.% da % y hoy en Argentina es %. No se aplicó nada.', r.tabla, r.columna, v_fecha, v_hoy;
    end if;
  end loop;

  -- Barrido final: ninguna función plpgsql/sql de public con "hoy" en UTC en el código.
  select string_agg(p.oid::regprocedure::text, ', ') into v_txt
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
    and l.lanname in ('plpgsql', 'sql')
    and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\m(current_date|localtimestamp|localtime)\M|now\(\)\s*::\s*date';
  if v_txt is not null then
    raise exception 'Tanda B: todavía quedan funciones con "hoy" en UTC: %. No se aplicó nada.', v_txt;
  end if;

  select string_agg(funcion || ': antes ' || huella_antes || ' / después ' || md5(pg_get_functiondef(funcion::regprocedure)), ' | ')
    into v_txt
  from respaldo.tanda_b_funciones;
  raise notice 'Tanda B aplicada. Hoy en Argentina: %. Huellas exactas: %', v_hoy, v_txt;
end;
$verifica$;

commit;
