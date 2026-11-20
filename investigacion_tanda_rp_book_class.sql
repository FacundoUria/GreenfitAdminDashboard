-- =====================================================================================
-- TANDA RP -- DIAGNÓSTICO (SOLO LECTURA). Son SELECT: no modifican nada.
-- Correr DE A UNA (el editor muestra solo la última grilla) y pasarme el resultado.
--
-- Para qué: la migración de Tanda RP le agrega a book_class() tres rechazos (fecha pasada,
-- clase ya empezada en hora de Argentina, día cerrado), insertándolos en el cuerpo de
-- PRODUCCIÓN. Antes hay que tener la huella exacta de ese cuerpo, confirmar el punto de
-- inserción, la tabla closed_days, cuánto habría frenado la regla y que nadie más dentro de
-- la base llame a book_class.
-- =====================================================================================


-- ============================================================
-- QUERY 1 -- HUELLA de producción de book_class (y admin_book_class como referencia).
--   huella               -> va en la guarda G1 de la migración (solo la de book_class).
--   ancla_veces          -> book_class tiene que dar 1 (admin_book_class da 0: usa p_user_id).
--   ya_tiene_reglas      -> tiene que dar false en las dos.
--   definicion           -> pasámela: la comparo contra la del repo (clase_una_sola_vez).
-- ============================================================
select p.oid::regprocedure::text                         as funcion,
       md5(pg_get_functiondef(p.oid))                    as huella,
       coalesce(p.proacl::text, '(por defecto)')         as permisos,
       pg_get_userbyid(p.proowner)                       as duenio,
       p.prosecdef                                       as security_definer,
       coalesce(array_to_string(p.proconfig, ','), '')   as config,
       (length(p.prosrc) - length(replace(p.prosrc,
          'if not public.esta_habilitado_para_disciplina(v_user_id, v_discipline_id) then', '')))
         / length('if not public.esta_habilitado_para_disciplina(v_user_id, v_discipline_id) then') as ancla_veces,
       position('closed_days' in p.prosrc) > 0
         or position('ya empezó' in p.prosrc) > 0
         or position('fecha que ya pasó' in p.prosrc) > 0 as ya_tiene_reglas,
       pg_get_functiondef(p.oid)                         as definicion
from pg_proc p
where p.oid in ('public.book_class(uuid, date)'::regprocedure,
                'public.admin_book_class(uuid, uuid, date)'::regprocedure)
order by 1;


-- ============================================================
-- QUERY 2 -- closed_days: columnas, tipos y restricciones. La migración exige fecha = date.
-- ============================================================
select a.attname                                   as columna,
       format_type(a.atttypid, a.atttypmod)        as tipo,
       a.attnotnull                                as no_nulo,
       pg_get_expr(d.adbin, d.adrelid)             as valor_por_defecto,
       (select string_agg(pg_get_constraintdef(c.oid), '; ')
        from pg_constraint c
        where c.conrelid = a.attrelid and a.attnum = any(c.conkey)) as restricciones
from pg_attribute a
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where a.attrelid = 'public.closed_days'::regclass and a.attnum > 0 and not a.attisdropped
order by a.attnum;


-- ============================================================
-- QUERY 3 -- closed_days: dueño, RLS y cuántas fechas hay (book_class es SECURITY DEFINER de
-- postgres: si la tabla es de postgres y la RLS no está forzada, la lee sin depender de RLS).
-- ============================================================
select pg_get_userbyid(c.relowner)  as duenio,
       c.relrowsecurity             as rls,
       c.relforcerowsecurity        as rls_forzada,
       (select count(*) from public.closed_days) as fechas,
       (select count(*) from public.closed_days
        where fecha::text >= to_char(now() at time zone 'America/Argentina/Mendoza', 'YYYY-MM-DD')) as desde_hoy
from pg_class c
where c.oid = 'public.closed_days'::regclass;


-- ============================================================
-- QUERY 4 -- Qué habría frenado la regla nueva en los últimos 90 días (reservas que siguen
-- vigentes; las canceladas se borran). Separado por quién reservó: el socio (book_class, la
-- regla nueva aplica) o Seba (admin_book_class, no cambia).
--   de_fecha_pasada           -> reservó para un día anterior al día en que reservó.
--   con_la_clase_ya_empezada  -> mismo día o futuro, pero reservó después de que arrancó.
--   en_dia_cerrado            -> la fecha de la reserva está en closed_days.
-- ============================================================
with r as (
  select b.created_at,
         b.booking_date,
         (b.created_at at time zone 'America/Argentina/Mendoza')::date as dia_reserva_ar,
         (b.booking_date + c.start_time) at time zone 'America/Argentina/Mendoza' as inicio_clase,
         case when x.created_by = b.user_id then 'socio (book_class)' else 'Seba (admin_book_class)' end as quien,
         exists (select 1 from public.closed_days cd where cd.fecha::text = b.booking_date::text) as dia_cerrado
  from public.bookings b
  join public.classes c on c.id = b.class_id
  left join public.xp_events x on x.reference_id = b.id and x.event_type = 'reserva'
  where b.created_at >= now() - interval '90 days'
)
select quien,
       count(*)                                                                        as reservas,
       count(*) filter (where booking_date < dia_reserva_ar)                           as de_fecha_pasada,
       count(*) filter (where booking_date >= dia_reserva_ar and created_at >= inicio_clase) as con_la_clase_ya_empezada,
       round(max(extract(epoch from created_at - inicio_clase) / 60)
             filter (where booking_date >= dia_reserva_ar and created_at >= inicio_clase)) as max_minutos_tarde,
       count(*) filter (where dia_cerrado)                                             as en_dia_cerrado
from r
group by quien
order by quien;


-- ============================================================
-- QUERY 5 -- ¿Alguna otra función de la base llama a book_class? (Tiene que dar 0 filas: en
-- los repos solo la llama la Agenda de la PWA.)
-- ============================================================
select p.oid::regprocedure::text as funcion, p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog', 'information_schema')
  and p.proname <> 'book_class'
  and p.prosrc ~* '\mbook_class\s*\('
order by 1;


-- ============================================================
-- QUERY 6 -- Cuentas para la prueba: la de test (DNI 44537978) y el primer admin.
-- ============================================================
select 'cuenta de test' as que, id, dni, role from profiles where dni = '44537978'
union all
(select 'primer admin', id, dni, role from profiles where role = 'admin' order by created_at limit 1);
