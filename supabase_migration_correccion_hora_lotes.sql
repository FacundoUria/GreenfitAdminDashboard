-- =====================================================================================
-- CORRECCIÓN DE HORA -- los lotes VIGENTES que vencen a una hora distinta de 23:59 AR pasan a
-- las 23:59:59.999999 AR del día que muestra la app.
-- Corrida en producción el 15/11/2026. Consulta (G): 57 lotes / 48 socios / huella
-- 6c50aeb26c59e5a05a45e990562eed9e. Consulta (I): 0 filas. Prueba
-- (prueba_correccion_hora_lotes.sql): 8 de 8.
--
-- Contexto: la Regla A (15/11/2026) arregló los lotes NUEVOS. Quedan los viejos: 57 lotes de
-- 48 socios el 15/11 ((E)/(F) de investigacion_pendientes_y_regla_a.sql), de dos tipos:
--   * hora exacta de la compra (11:05, 15:48...): el socio pierde el resto de ese día.
--   * 00:00 (cobros con fecha de inicio anteriores a T2): el socio pierde el día ENTERO que
--     le muestran la app y la ficha.
--
-- La regla (UNA para los dos tipos):
--   nuevo expires_at = ((ultimo_dia_plan(expires_at) + 1)::timestamp at time zone AR) - 1 µs
--   o sea, el final del día que muestra la app (ultimo_dia_plan = el día AR de expires_at).
--   * Hora exacta del 20/12 11:05 -> 20/12 23:59:59.999999 (gana horas del mismo día).
--   * 00:00 del 17/11            -> 17/11 23:59:59.999999 (gana el 17, el día que la app y la
--     ficha le prometieron). NO el 16/11 23:59:59.999999: eso es 1 µs ANTES de lo que ya
--     tiene, así que no le arregla nada, y la app pasaría a mostrarle el 16 (perdería un día
--     a la vista). Ver investigacion_correccion_hora_lotes.sql, consulta (H).
--   Con esta regla el DÍA de cada lote no cambia: no hay que tocar socios.fecha_vencimiento,
--   ni lo que muestra la PWA, y el candado T7 ve exactamente los mismos días que antes.
--
-- Qué toca: SOLO user_credits.expires_at de los lotes de la lista (vigentes: expires_at >
-- now(), y hora AR <> 23:59). Los vencidos, socios, pagos y reservas no se tocan.
--
-- Guardas (si alguna falla, no se aplica nada):
--   0) Regla A aplicada (respaldo.regla_a_funciones con 6 funciones): no se crean lotes
--      nuevos con hora mientras tanto.
--   1) LA LISTA EXACTA: cantidad de lotes, de socios y huella = las de la consulta (G),
--      pegadas abajo (c_lotes, c_socios, c_huella). Correr (G) justo antes: si un lote de la
--      lista venció entre (G) y esto, la huella cambia y frena -- volver a correr (G).
--      Mientras corre, user_credits queda en SHARE ROW EXCLUSIVE (las escrituras esperan
--      milisegundos; las lecturas no): la lista no cambia entre la guarda y el UPDATE.
--   2) No aplicada todavía (no existe respaldo.correccion_hora_lotes).
--   3) ANTES: cada socio de la lista tiene UNA sola fecha (día AR) entre lo que puede usar (T7).
--   4) Cada lote: nuevo >= antes (nadie pierde), mismo día AR, y gana menos de 1 día.
--   5) DESPUÉS: el UPDATE tocó EXACTAMENTE c_lotes filas; el candado T7 corre YA (SET
--      CONSTRAINTS ... IMMEDIATE), sin errores; cada socio sigue con UNA fecha y es la MISMA
--      que antes (día de fecha_plan_socio igual); 0 lotes vigentes con hora <> 23:59; cada
--      fila del respaldo tiene hoy su expires_at nuevo.
--
-- Respaldo: respaldo.correccion_hora_lotes (lote, socio, expires_at antes y nuevo). El
-- rollback (rollback_correccion_hora_lotes.sql) vuelve EXACTAMENTE a los de antes.
-- Prueba: prueba_correccion_hora_lotes.sql (la parte con la cuenta de test se puede correr
-- antes y después; la parte sobre los datos reales, después).
-- =====================================================================================

begin;

set local lock_timeout = '5s';

-- La lista no cambia entre la guarda 1 y el UPDATE.
lock table public.user_credits in share row exclusive mode;

create temp table _lista on commit drop as
select uc.id,
       uc.user_id,
       uc.discipline_id,
       uc.remaining_credits,
       uc.expires_at as antes,
       ((public.ultimo_dia_plan(uc.expires_at) + 1)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond' as nuevo
from public.user_credits uc
where uc.expires_at > now()
  and to_char(uc.expires_at at time zone 'America/Argentina/Mendoza', 'HH24:MI') <> '23:59';

-- Día del plan de cada socio ANTES (para comparar en la guarda 5).
create temp table _plan_antes on commit drop as
select s.user_id, public.ultimo_dia_plan(public.fecha_plan_socio(s.user_id)) as dia
from (select distinct user_id from _lista) s;

-- ── Guardas 0 a 4 ─────────────────────────────────────────────────────────────────────
do $guarda$
declare
  -- PEGAR acá lo que da la consulta (G) de investigacion_correccion_hora_lotes.sql:
  c_lotes  constant int  := 57;
  c_socios constant int  := 48;
  c_huella constant text := '6c50aeb26c59e5a05a45e990562eed9e';
  v_lotes int;
  v_socios int;
  v_huella text;
  v_txt text;
begin
  -- 0) Regla A aplicada.
  if to_regclass('respaldo.regla_a_funciones') is null
     or (select count(*) from respaldo.regla_a_funciones) <> 6 then
    raise exception 'Corrección de hora: la Regla A no está aplicada (falta respaldo.regla_a_funciones con 6 funciones). No se aplicó nada.';
  end if;

  -- 1) La lista exacta.
  if c_huella !~ '^[0-9a-f]{32}$' then
    raise exception 'Corrección de hora: falta pegar la huella de la consulta (G) en c_huella. No se aplicó nada.';
  end if;
  select count(*), count(distinct user_id),
         md5(string_agg(id::text || ':' || to_char(antes at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), ',' order by id))
    into v_lotes, v_socios, v_huella
  from _lista;
  if v_lotes <> c_lotes or v_socios <> c_socios or v_huella is distinct from c_huella then
    raise exception 'Corrección de hora: la lista no es la de la consulta (G): hay % lotes de % socios (huella %), se esperaban % de % (huella %). Volver a correr (G). No se aplicó nada.',
      v_lotes, v_socios, coalesce(v_huella, '-'), c_lotes, c_socios, c_huella;
  end if;

  -- 2) No aplicada.
  if to_regclass('respaldo.correccion_hora_lotes') is not null then
    raise exception 'Corrección de hora: ya existe respaldo.correccion_hora_lotes (¿ya aplicada?). No se aplicó nada.';
  end if;

  -- 3) Una sola fecha por socio, antes.
  select string_agg(x.user_id::text || ' (' || x.dias || ')', ', ') into v_txt
  from (
    select uc.user_id, string_agg(distinct to_char(public.ultimo_dia_plan(uc.expires_at), 'DD/MM/YYYY'), ' y ') as dias
    from public.user_credits uc
    join public.disciplines d on d.id = uc.discipline_id
    where uc.user_id in (select user_id from _lista)
      and uc.expires_at > now()
      and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership')
    group by uc.user_id
    having count(distinct public.ultimo_dia_plan(uc.expires_at)) > 1
  ) x;
  if v_txt is not null then
    raise exception 'Corrección de hora: estos socios YA tienen más de una fecha vigente (hay que resolverlos aparte): %. No se aplicó nada.', v_txt;
  end if;

  -- 4) Nadie pierde, mismo día, menos de 1 día de ganancia.
  select string_agg(id::text, ', ') into v_txt
  from _lista
  where nuevo < antes
     or public.ultimo_dia_plan(nuevo) <> public.ultimo_dia_plan(antes)
     or nuevo - antes >= interval '1 day';
  if v_txt is not null then
    raise exception 'Corrección de hora: estos lotes perderían tiempo o cambiarían de día: %. No se aplicó nada.', v_txt;
  end if;
end;
$guarda$;

-- ── Respaldo ──────────────────────────────────────────────────────────────────────────
create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

create table respaldo.correccion_hora_lotes (
  lote_id            uuid primary key,
  user_id            uuid not null,
  discipline_id      uuid,
  remaining_credits  integer,
  expires_at_antes   timestamptz not null,
  expires_at_nuevo   timestamptz not null,
  guardado_en        timestamptz not null default now()
);
revoke all on respaldo.correccion_hora_lotes from public, anon, authenticated;

insert into respaldo.correccion_hora_lotes (lote_id, user_id, discipline_id, remaining_credits, expires_at_antes, expires_at_nuevo)
select id, user_id, discipline_id, remaining_credits, antes, nuevo from _lista;

-- ── El cambio ─────────────────────────────────────────────────────────────────────────
do $aplicar$
declare
  v_n int;
begin
  update public.user_credits uc
  set expires_at = l.nuevo
  from _lista l
  where uc.id = l.id
    and uc.expires_at = l.antes;
  get diagnostics v_n = row_count;
  if v_n <> (select count(*) from _lista) then
    raise exception 'Corrección de hora: se actualizaron % lotes y la lista tiene %. No se aplicó nada.', v_n, (select count(*) from _lista);
  end if;
end;
$aplicar$;

-- El candado T7 corre YA (igual que al COMMIT): si alguien quedara con 2 fechas, falla acá.
set constraints public.candado_una_fecha_vigente_ins, public.candado_una_fecha_vigente_upd immediate;

-- ── Guarda 5: verificación DESPUÉS ────────────────────────────────────────────────────
do $verifica$
declare
  v_txt text;
  v_n int;
  v_horas int;
begin
  -- Cada fila del respaldo tiene hoy su expires_at nuevo.
  select count(*) into v_n
  from respaldo.correccion_hora_lotes b
  join public.user_credits uc on uc.id = b.lote_id
  where uc.expires_at = b.expires_at_nuevo;
  if v_n <> (select count(*) from respaldo.correccion_hora_lotes) then
    raise exception 'Corrección de hora: % de % lotes quedaron con la fecha nueva. No se aplicó nada.', v_n, (select count(*) from respaldo.correccion_hora_lotes);
  end if;

  -- 0 lotes vigentes con hora distinta de 23:59 (en toda la tabla).
  select count(*) into v_n
  from public.user_credits
  where expires_at > now()
    and to_char(expires_at at time zone 'America/Argentina/Mendoza', 'HH24:MI') <> '23:59';
  if v_n <> 0 then
    raise exception 'Corrección de hora: quedan % lotes vigentes con hora distinta de 23:59. No se aplicó nada.', v_n;
  end if;

  -- Cada socio: UNA fecha, y la MISMA que antes.
  select string_agg(a.user_id::text || ' (antes ' || coalesce(a.dia::text, 'null') || ', ahora '
                    || coalesce(public.ultimo_dia_plan(public.fecha_plan_socio(a.user_id))::text, 'null') || ')', ', ')
    into v_txt
  from _plan_antes a
  where public.ultimo_dia_plan(public.fecha_plan_socio(a.user_id)) is distinct from a.dia
     or (select count(distinct public.ultimo_dia_plan(uc.expires_at))
         from public.user_credits uc join public.disciplines d on d.id = uc.discipline_id
         where uc.user_id = a.user_id and uc.expires_at > now()
           and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership')) > 1;
  if v_txt is not null then
    raise exception 'Corrección de hora: estos socios cambiaron de fecha o quedaron con más de una: %. No se aplicó nada.', v_txt;
  end if;

  -- Informativo: socios cuyos lotes usables no quedaron todos con el MISMO instante (mismo día,
  -- pero alguno ya estaba a 23:59:xx sin los microsegundos). Esperado: 0.
  select count(*) into v_horas
  from (
    select uc.user_id
    from public.user_credits uc join public.disciplines d on d.id = uc.discipline_id
    where uc.user_id in (select user_id from _plan_antes) and uc.expires_at > now()
      and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership')
    group by uc.user_id
    having count(distinct uc.expires_at) > 1
  ) x;

  raise notice 'Corrección de hora aplicada: % lotes de % socios pasaron al fin del día que muestra la app. Socios con más de un instante (mismo día): % (esperado 0).',
    (select count(*) from respaldo.correccion_hora_lotes),
    (select count(distinct user_id) from respaldo.correccion_hora_lotes),
    v_horas;
end;
$verifica$;

commit;

-- Después de correrla (solo lectura):
--   select count(*), count(distinct user_id) from respaldo.correccion_hora_lotes;   -- 57 / 48
--   + (E) de investigacion_pendientes_y_regla_a.sql: hora_distinta_de_2359 = 0.
--   + prueba_correccion_hora_lotes.sql: todo OK.
