-- =====================================================================================
-- INVESTIGACIÓN (SOLO LECTURA) -- dos bugs de fechas del 15/11/2026.
--   Bug 1: falsos positivos en "Pagos sin cargar en la app" (admin_socios_pendientes_de_cargar).
--   Bug 2: Regla A -- lotes nuevos que vencen a la hora exacta de la compra (now() + 30 días).
--
-- Todo es SELECT. Ningún INSERT/UPDATE/DELETE, ningún create/replace. Se puede correr entera
-- en el SQL Editor (cada consulta devuelve su propia grilla) o de a una.
--
-- Orden sugerido:
--   (A) y (B) ANTES de las migraciones: confirman que las huellas y la lista de funciones
--       que tienen pegadas las migraciones son las de producción.
--   (C) y (D) antes de supabase_migration_pendientes_desde_ultimo_pago.sql.
--   (E) es la que pediste: cuántos lotes vigentes hoy vencen a una hora distinta de 23:59 AR.
--   (F) el detalle de (E), para decidir si se corrigen a mano.
-- =====================================================================================


-- ── (A) Huellas y permisos de las 7 funciones que se tocan ───────────────────────────
-- Esperado (huella_sin_espacios), lo que tienen pegado las migraciones:
--   admin_socios_pendientes_de_cargar  = 9d21d616161c42cb27e711fbe75b2a20   (T5)
--   acreditar_pack                     = cd4f6062aa6bcf6241a1151e094686ae   (T1)
--   admin_acreditar_creditos_manual    = de302991098cf77f2e60e4a3d41456c8   (T2)
--   resolver_fecha_plan_actual         = 05f63efa8b16c9e5c96f2ef5a21289bf   (T2)
--   admin_fijar_creditos_disciplina    = 32fa31b3ba16f674faf42f68f14fc3e2   (T3)
--   admin_ajustar_credito_disciplina   = a34f0d9b63aed24d3a67747ed89f88cb   (T3)
--   admin_agregar_aparatos_socio       = c93d54418f8ca3e3ac82f7925278b3c6   (T3)
-- Si alguna da distinto, NO correr la migración: avisame y la rehago sobre la de producción.
select x.firma,
       md5(regexp_replace(pg_get_functiondef(to_regprocedure(x.firma)), '\s+', '', 'g')) as huella_sin_espacios,
       x.esperada,
       md5(regexp_replace(pg_get_functiondef(to_regprocedure(x.firma)), '\s+', '', 'g')) = x.esperada as coincide,
       (select coalesce(proacl::text, '(por defecto)') from pg_proc where oid = to_regprocedure(x.firma)) as permisos
from (values
  ('public.admin_socios_pendientes_de_cargar()',                                   '9d21d616161c42cb27e711fbe75b2a20'),
  ('public.acreditar_pack(uuid, uuid, text, text)',                                 'cd4f6062aa6bcf6241a1151e094686ae'),
  ('public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)',   'de302991098cf77f2e60e4a3d41456c8'),
  ('public.resolver_fecha_plan_actual(uuid)',                                       '05f63efa8b16c9e5c96f2ef5a21289bf'),
  ('public.admin_fijar_creditos_disciplina(uuid, uuid, integer)',                   '32fa31b3ba16f674faf42f68f14fc3e2'),
  ('public.admin_ajustar_credito_disciplina(uuid, uuid, integer)',                  'a34f0d9b63aed24d3a67747ed89f88cb'),
  ('public.admin_agregar_aparatos_socio(uuid)',                                     'c93d54418f8ca3e3ac82f7925278b3c6')
) as x(firma, esperada)
order by 1;


-- ── (B) Barrido: TODAS las funciones de public que suman días a now() (o algo parecido) ──
-- Sin filtro: cualquier `now() +`, `make_interval`, `interval ... * n` o `::date +` en el código
-- (sin comentarios). Revisar la lista a ojo: las 6 de Regla A tienen que estar, y ninguna otra
-- que escriba user_credits.expires_at. La migración tiene su propia guarda con el mismo criterio
-- (filtrado a las que mencionan user_credits / expires_at / fecha_plan / fecha_vencimiento) y
-- frena si aparece una 7ª.
select p.oid::regprocedure as funcion,
       regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'user_credits|expires_at|fecha_plan|fecha_vencimiento' as toca_fechas_de_plan,
       regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'insert\s+into\s+(public\.)?user_credits' as inserta_lotes,
       (select string_agg(m[1], '  ||  ')
          from regexp_matches(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'),
                              '(now\(\)\s*\+[^;\n]{0,80}|make_interval[^;\n]{0,60}|::\s*date\s*\+[^;\n]{0,60})', 'gi') as m) as fragmentos
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l on l.oid = p.prolang
where n.nspname = 'public'
  and l.lanname in ('plpgsql', 'sql')
  and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '(now\(\)\s*\+|make_interval|::\s*date\s*\+)'
order by 3 desc, 2 desc, 1::text;


-- ── (C) Los 4 casos de hoy: último pago de la ficha vs. lotes creados ─────────────────
-- Con el arreglo, un socio sale de la lista si tiene AL MENOS UN lote con
-- creado_ar >= 00:00 AR del día de ultimo_pago. Columna `sale_con_el_arreglo`: tiene que dar
-- true en los 4. Si alguno da false (ej. ultimo_pago 16/10 y el lote es del 15/10), avisame
-- antes de migrar: la ficha tiene un último pago POSTERIOR al lote cargado.
select s.id as socio_id,
       s.nombre, s.apellido, s.dni,
       s.ultimo_pago,
       s.fecha_vencimiento,
       uc.id as lote_id,
       d.name as disciplina,
       uc.remaining_credits,
       (uc.created_at at time zone 'America/Argentina/Mendoza') as creado_ar,
       (uc.expires_at at time zone 'America/Argentina/Mendoza') as vence_ar,
       uc.created_at >= (s.ultimo_pago::timestamp at time zone 'America/Argentina/Mendoza') as creado_desde_el_pago,
       exists (select 1 from profiles p2 join user_credits u2 on u2.user_id = p2.id
               where p2.dni = s.dni
                 and u2.created_at >= (s.ultimo_pago::timestamp at time zone 'America/Argentina/Mendoza')) as sale_con_el_arreglo
from socios s
left join profiles p on p.dni = s.dni
left join user_credits uc on uc.user_id = p.id
left join disciplines d on d.id = uc.discipline_id
where s.dni in ('47272008', '51090370', '38474983', '27036566')
order by s.dni, uc.created_at desc;


-- ── (D) Quién entra y quién sale de la lista con el arreglo (hoy) ────────────────────
-- Mismo filtro base que la función (activo, ficha vigente, pago en los últimos 35 días, con
-- cuenta). `antes` = criterio actual (nada vigente ahora); `despues` = ningún lote creado
-- desde el día del último pago.
--   sale   -> estaba por un lote ya vencido (falsos positivos como los 4 de hoy).
--   entra  -> tiene un lote vigente de ANTES del último pago y ninguno creado después
--             (ej. Seba registró el pago en la ficha sin cargarle nada). Revisar uno por uno:
--             si son pagos reales sin cargar, está bien que entren; si no, avisame.
with base as (
  select s.id, s.nombre, s.apellido, s.dni, s.ultimo_pago::date as ultimo_pago, s.fecha_vencimiento::date as fecha_vencimiento
  from socios s
  where s.activo is not false
    and s.fecha_vencimiento::date >= (now() at time zone 'America/Argentina/Mendoza')::date
    and s.ultimo_pago::date >= (now() at time zone 'America/Argentina/Mendoza')::date - 35
    and exists (select 1 from profiles p where p.dni = s.dni)
),
criterios as (
  select b.*,
         not exists (select 1 from profiles p join user_credits uc on uc.user_id = p.id
                     where p.dni = b.dni and uc.expires_at > now()) as antes,
         not exists (select 1 from profiles p join user_credits uc on uc.user_id = p.id
                     where p.dni = b.dni
                       and uc.created_at >= (b.ultimo_pago::timestamp at time zone 'America/Argentina/Mendoza')) as despues
  from base b
)
select case when antes and not despues then 'sale'
            when despues and not antes then 'entra'
            else 'sigue' end as cambio,
       id as socio_id, nombre, apellido, dni, ultimo_pago, fecha_vencimiento
from criterios
where antes or despues
order by 1, ultimo_pago desc, id;

-- Lotes sin created_at (con el arreglo no cuentan como "cargado"). Esperado: 0.
select count(*) as lotes_sin_created_at from user_credits where created_at is null;


-- ── (E) LA QUE PEDISTE: lotes vigentes hoy que vencen a una hora distinta de 23:59 AR ──
-- vigentes = expires_at > now(). "usables" = los que cuentan para el candado y la PWA
-- (créditos con saldo > 0, o Aparatos). a_las_00 = cortes a las 00:00 AR (el socio pierde TODO
-- el último día que le muestra la ficha: es el caso de los 4 de hoy).
with v as (
  select uc.user_id, uc.remaining_credits, uc.created_at, d.kind,
         (uc.expires_at at time zone 'America/Argentina/Mendoza') as vence_ar,
         ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership') as usable
  from user_credits uc
  join disciplines d on d.id = uc.discipline_id
  where uc.expires_at > now()
)
select count(*)                                                                            as lotes_vigentes,
       count(*) filter (where to_char(vence_ar, 'HH24:MI') <> '23:59')                     as hora_distinta_de_2359,
       count(*) filter (where to_char(vence_ar, 'HH24:MI') <> '23:59' and usable)          as hora_distinta_usables,
       count(distinct user_id) filter (where to_char(vence_ar, 'HH24:MI') <> '23:59' and usable) as socios_afectados,
       count(*) filter (where to_char(vence_ar, 'HH24:MI:SS.US') = '00:00:00.000000')       as a_las_00,
       count(*) filter (where to_char(vence_ar, 'HH24:MI') <> '23:59'
                          and to_char(vence_ar, 'HH24:MI:SS.US') <> '00:00:00.000000')      as a_hora_exacta_de_compra,
       count(*) filter (where to_char(vence_ar, 'HH24:MI') <> '23:59'
                          and created_at >= now() - interval '20 days')                     as hora_distinta_creados_ult_20_dias
from v;


-- ── (F) Detalle de (E), un renglón por lote ──────────────────────────────────────────
select coalesce(nullif(trim(p.full_name), ''), trim(coalesce(s.nombre, '') || ' ' || coalesce(s.apellido, ''))) as socio,
       p.dni,
       d.name as disciplina,
       d.kind,
       uc.remaining_credits,
       (uc.created_at at time zone 'America/Argentina/Mendoza') as creado_ar,
       (uc.expires_at at time zone 'America/Argentina/Mendoza') as vence_ar,
       public.ultimo_dia_plan(uc.expires_at) as dia_que_muestra_la_app,
       uc.id as lote_id
from user_credits uc
join disciplines d on d.id = uc.discipline_id
left join profiles p on p.id = uc.user_id
left join lateral (select nombre, apellido from socios s where s.dni = p.dni order by s.id limit 1) s on true
where uc.expires_at > now()
  and to_char(uc.expires_at at time zone 'America/Argentina/Mendoza', 'HH24:MI') <> '23:59'
order by uc.expires_at, socio;
