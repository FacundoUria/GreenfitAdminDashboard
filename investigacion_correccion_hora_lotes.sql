-- =====================================================================================
-- INVESTIGACIÓN (SOLO LECTURA) -- corrección de los lotes vigentes que vencen a una hora
-- distinta de 23:59 AR (57 lotes de 48 socios según (E)/(F) de
-- investigacion_pendientes_y_regla_a.sql, el 15/11/2026).
--
-- Todo es SELECT. Correr justo ANTES de supabase_migration_correccion_hora_lotes.sql:
--   (G) da los 3 valores que hay que pegar en la guarda 1 de la migración.
--   (H) es para decidir la regla de los lotes de las 00:00 (qué día muestra la app, qué dice
--       la ficha y cuál es el último día que el socio realmente puede usar).
--   (I) confirma que hoy cada socio de la lista tiene una sola fecha (candado T7).
--
-- La lista (mismo criterio en todos lados, igual que (E)/(F)):
--   expires_at > now()  y  hora AR (HH24:MI) <> '23:59'
-- La huella usa la hora UTC con microsegundos: no depende del TimeZone de la sesión.
-- =====================================================================================


-- ── (G) Lo que se pega en la migración ───────────────────────────────────────────────
select count(*)                 as lotes,
       count(distinct user_id)  as socios,
       md5(string_agg(id::text || ':' || to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), ',' order by id)) as huella
from user_credits
where expires_at > now()
  and to_char(expires_at at time zone 'America/Argentina/Mendoza', 'HH24:MI') <> '23:59';


-- ── (H) Lote por lote: qué día muestra la app, qué dice la ficha, cuál es el real ────
--   dia_app          = ultimo_dia_plan(expires_at): el que muestran la PWA y el Admin.
--   ultimo_dia_real  = el último día en que el lote todavía se puede usar en algún momento
--                      ((expires_at - 1 µs) en AR). Para las 00:00 es el día ANTERIOR.
--   ficha            = socios.fecha_vencimiento (el espejo; acreditar_pack y T2/T3 lo escriben
--                      como el día AR de expires_at = dia_app).
--   tipo             = '00:00' o 'hora exacta'.
--   nuevo_corte      = lo que propone la migración: fin del día dia_app.
--   gana             = nuevo_corte - expires_at (nunca negativo).
select coalesce(nullif(trim(p.full_name), ''), trim(coalesce(s.nombre, '') || ' ' || coalesce(s.apellido, ''))) as socio,
       p.dni,
       d.name as disciplina,
       uc.remaining_credits,
       case when to_char(uc.expires_at at time zone 'America/Argentina/Mendoza', 'HH24:MI:SS.US') = '00:00:00.000000'
            then '00:00' else 'hora exacta' end as tipo,
       (uc.expires_at at time zone 'America/Argentina/Mendoza') as vence_ar,
       public.ultimo_dia_plan(uc.expires_at) as dia_app,
       ((uc.expires_at - interval '1 microsecond') at time zone 'America/Argentina/Mendoza')::date as ultimo_dia_real,
       s.fecha_vencimiento as ficha,
       s.fecha_vencimiento = public.ultimo_dia_plan(uc.expires_at) as ficha_igual_app,
       (uc.created_at at time zone 'America/Argentina/Mendoza') as creado_ar,
       ((public.ultimo_dia_plan(uc.expires_at) + 1)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond' as nuevo_corte,
       (((public.ultimo_dia_plan(uc.expires_at) + 1)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond') - uc.expires_at as gana,
       uc.id as lote_id
from user_credits uc
join disciplines d on d.id = uc.discipline_id
left join profiles p on p.id = uc.user_id
left join lateral (select nombre, apellido, fecha_vencimiento from socios s where s.dni = p.dni order by s.id limit 1) s on true
where uc.expires_at > now()
  and to_char(uc.expires_at at time zone 'America/Argentina/Mendoza', 'HH24:MI') <> '23:59'
order by tipo, uc.expires_at, socio;

-- Resumen de (H): para los 00:00, ¿la ficha coincide con el día de la app o con el real?
select case when to_char(uc.expires_at at time zone 'America/Argentina/Mendoza', 'HH24:MI:SS.US') = '00:00:00.000000'
            then '00:00' else 'hora exacta' end as tipo,
       count(*) as lotes,
       count(*) filter (where s.fecha_vencimiento = public.ultimo_dia_plan(uc.expires_at)) as ficha_igual_dia_app,
       count(*) filter (where s.fecha_vencimiento = ((uc.expires_at - interval '1 microsecond') at time zone 'America/Argentina/Mendoza')::date
                          and s.fecha_vencimiento <> public.ultimo_dia_plan(uc.expires_at)) as ficha_igual_dia_anterior,
       count(*) filter (where s.fecha_vencimiento is null) as sin_ficha_o_sin_fecha,
       count(*) filter (where s.fecha_vencimiento is not null
                          and s.fecha_vencimiento <> public.ultimo_dia_plan(uc.expires_at)
                          and s.fecha_vencimiento <> ((uc.expires_at - interval '1 microsecond') at time zone 'America/Argentina/Mendoza')::date) as ficha_otra_fecha
from user_credits uc
left join profiles p on p.id = uc.user_id
left join lateral (select fecha_vencimiento from socios s where s.dni = p.dni order by s.id limit 1) s on true
where uc.expires_at > now()
  and to_char(uc.expires_at at time zone 'America/Argentina/Mendoza', 'HH24:MI') <> '23:59'
group by 1
order by 1;


-- ── (I) Candado T7 hoy: socios de la lista con más de una fecha entre lo que pueden usar ──
-- Esperado: 0 filas (la migración frena si hay alguno).
with lista as (
  select distinct user_id from user_credits
  where expires_at > now()
    and to_char(expires_at at time zone 'America/Argentina/Mendoza', 'HH24:MI') <> '23:59'
)
select l.user_id,
       array_agg(distinct public.ultimo_dia_plan(uc.expires_at) order by public.ultimo_dia_plan(uc.expires_at)) as dias
from lista l
join user_credits uc on uc.user_id = l.user_id
join disciplines d on d.id = uc.discipline_id
where uc.expires_at > now()
  and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership')
group by l.user_id
having count(distinct public.ultimo_dia_plan(uc.expires_at)) > 1;
