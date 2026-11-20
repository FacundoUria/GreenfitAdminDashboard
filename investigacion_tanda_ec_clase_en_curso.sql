-- =====================================================================================
-- TANDA EC -- DIAGNÓSTICO (SOLO LECTURA). Son SELECT: no modifican nada.
-- Correr DE A UNA (el editor muestra solo la última grilla) y pasarme el resultado.
--
-- Para qué: book_class pasa a aceptar reservas con la clase en curso, hasta que TERMINA
-- (end_time en hora de Argentina). Antes: confirmar que book_class sigue siendo la que dejó
-- la Tanda RP, ver qué clases no tienen un horario de fin válido (null o no posterior al
-- inicio: para esas sigue valiendo "hasta que empieza"), si la base permite cargarlas, si hay
-- clases muy largas (con la regla nueva se podrían reservar durante horas), y qué mensaje da
-- hoy el servidor al cancelar.
-- =====================================================================================


-- ============================================================
-- QUERY 1 -- book_class hoy contra lo que dejó la Tanda RP.
--   sin_cambios_desde_rp  -> tiene que dar true (la migración lo exige: guarda G1).
--   ida_y_vuelta_exacta   -> tiene que dar true: confirma que ejecutar una definición y
--                            volver a leerla da el mismo texto (la migración lo usa en G5).
--   tiene_regla_rp        -> true;  ya_tiene_regla_nueva -> false.
-- ============================================================
select p.oid::regprocedure::text                                   as funcion,
       md5(pg_get_functiondef(p.oid))                              as huella_hoy,
       r.huella_nueva                                              as huella_que_dejo_rp,
       md5(pg_get_functiondef(p.oid)) = r.huella_nueva             as sin_cambios_desde_rp,
       md5(r.definicion_nueva) = r.huella_nueva                    as ida_y_vuelta_exacta,
       position('Esta clase ya empezó: no se puede reservar.' in p.prosrc) > 0 as tiene_regla_rp,
       position('ya terminó' in p.prosrc) > 0                      as ya_tiene_regla_nueva,
       coalesce(p.proacl::text, '(por defecto)')                   as permisos
from pg_proc p
left join respaldo.tanda_rp_funciones r on r.funcion = 'public.book_class(uuid, date)'
where p.oid = 'public.book_class(uuid, date)'::regprocedure;


-- ============================================================
-- QUERY 2 -- Clases SIN horario de fin válido. Para estas sigue valiendo "se puede reservar
-- hasta que empieza" (como hoy), en la base y en la PWA.
-- ============================================================
select c.id, c.title, d.name as disciplina, d.is_active, d.show_in_agenda,
       c.days_of_week, c.start_time, c.end_time, c.fecha_unica,
       case when c.end_time is null then 'sin end_time'
            when c.end_time = c.start_time then 'fin igual al inicio'
            else 'fin antes del inicio' end as problema
from public.classes c
left join public.disciplines d on d.id = c.discipline_id
where c.end_time is null or c.end_time <= c.start_time
order by d.name, c.start_time;


-- ============================================================
-- QUERY 3 -- ¿La base deja cargar clases sin fin o con fin anterior al inicio? (El Admin
-- exige "hora fin" pero no que sea posterior al inicio.) Lo usa la prueba para saber si
-- puede armar esos casos.
-- ============================================================
select a.attnotnull as end_time_es_not_null,
       (select string_agg(pg_get_constraintdef(c.oid), '; ')
        from pg_constraint c
        where c.conrelid = 'public.classes'::regclass and c.contype = 'c') as checks_de_classes
from pg_attribute a
where a.attrelid = 'public.classes'::regclass and a.attname = 'end_time' and not a.attisdropped;


-- ============================================================
-- QUERY 4 -- Clases de más de 2 horas (con la regla nueva se pueden reservar hasta que
-- terminan: un fin mal cargado, ej. 08:00 a 20:00, las dejaría abiertas todo el día).
-- ============================================================
select c.id, c.title, d.name as disciplina, c.days_of_week, c.start_time, c.end_time,
       c.end_time - c.start_time as duracion
from public.classes c
left join public.disciplines d on d.id = c.discipline_id
where c.end_time > c.start_time and c.end_time - c.start_time > interval '2 hours'
order by duracion desc;


-- ============================================================
-- QUERY 5 -- Qué dice HOY el servidor al cancelar (cancel_booking_detalle es la que usa la
-- PWA; cancel_booking es el respaldo) y el límite configurado.
-- ============================================================
select p.oid::regprocedure::text as funcion,
       m[1]                      as mensaje,
       (select limite_cancelacion_minutos from public.configuracion where id = 1) as limite_cancelacion_minutos
from pg_proc p,
     regexp_matches(p.prosrc, 'raise exception ''([^'']*)''', 'g') m
where p.oid in ('public.cancel_booking_detalle(uuid, date, text)'::regprocedure,
                'public.cancel_booking(uuid, date, text)'::regprocedure)
order by 1;


-- ============================================================
-- QUERY 6 -- Cuentas para la prueba: la de test (DNI 44537978) y el primer admin.
-- ============================================================
select 'cuenta de test' as que, id, dni, role from profiles where dni = '44537978'
union all
(select 'primer admin', id, dni, role from profiles where role = 'admin' order by created_at limit 1);
