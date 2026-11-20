-- =====================================================================================
-- TANDA EC -- book_class acepta reservas con la clase en curso, hasta que TERMINA.
-- Corrida en producción el 20/11/2026 (prueba 10 de 10). Diagnóstico de ese día: book_class
-- con la huella que dejó la Tanda RP (0e7a1bbe4e1b8e987d4c8f27410eab04), ida y vuelta exacta,
-- sin la regla nueva; 0 clases sin horario de fin válido; 3 clases de Aparatos de 4 y 7 horas
-- (sala libre: se pueden reservar mientras dura, está bien).
--
-- Decisión de negocio (20/11/2026): el gimnasio es chico, Seba controla en persona quién está
-- y el ranking no preocupa. Se puede reservar con la clase empezada, hasta que termina.
--
-- Qué cambia: SOLO la regla de horario que puso la Tanda RP en book_class(uuid, date):
--   antes: (fecha + start_time) en hora de Argentina <= ahora -> 'Esta clase ya empezó: ...'
--   ahora: (fecha + end_time)   en hora de Argentina <= ahora -> 'Esta clase ya terminó: no se
--          puede reservar.'
--   Sin horario de fin válido (end_time null, o no posterior a start_time -- un "19:00 a 18:00"
--   mal cargado): sigue como antes, hasta que empieza, con el mensaje de antes. No se toma un
--   fin anterior al inicio como "cruza la medianoche": en el gimnasio no hay clases así, y un
--   error de carga dejaría la clase abierta casi un día entero.
--   Fecha pasada y día cerrado: igual que en la Tanda RP.
--
-- Cómo: la definición nueva se arma desde la definición de PRODUCCIÓN de antes de la Tanda RP
-- (respaldo.tanda_rp_funciones.definicion_antes) con el bloque de la RP reescrito, insertado
-- en el mismo lugar (antes del chequeo de plan/créditos). Como hoy book_class es exactamente
-- la que dejó la RP (G1: huella_nueva), el único cambio real es la regla de horario.
--
-- Qué NO cambia:
--   * admin_book_class(): sin límite, como siempre (G6: definición y permisos idénticos).
--   * cancel_booking / cancel_booking_detalle: una reserva hecha con la clase en curso no se
--     puede cancelar (ya pasó el límite). La PWA lo avisa antes: "La clase ya empezó: no podés
--     cancelarla." (botón deshabilitado), así que el texto del servidor no se llega a ver.
--   * Permisos de book_class: create or replace los conserva.
--
-- Guardas (si alguna falla, no se aplica nada):
--   G0) Corre como postgres; existe respaldo.tanda_rp_funciones con book_class.
--   G1) book_class es EXACTAMENTE la que dejó la Tanda RP (md5 = huella_nueva del respaldo).
--   G2) El punto de inserción de la RP aparece 1 vez en la definición de antes de la RP.
--   G3) Todavía no tiene la regla nueva; permisos: anon no, authenticated sí.
--   DESPUÉS:
--   G4) La definición quedó EXACTAMENTE como la armada (antes de la RP + bloque nuevo).
--   G5) Mismo dueño, permisos, security definer, volatilidad y config que antes.
--   G6) admin_book_class idéntica; ninguna otra función de la base cambió.
--
-- Respaldo: definición de antes (la de la RP) y de después en respaldo.tanda_ec_funciones.
-- Prueba:   prueba_tanda_ec.sql (DESPUÉS de esta migración).
-- Rollback: rollback_tanda_ec.sql (vuelve a la versión de la Tanda RP).
-- =====================================================================================

begin;

create temp table _ec on commit drop as
select 'public.book_class(uuid, date)'::regprocedure             as book_class,
       'public.admin_book_class(uuid, uuid, date)'::regprocedure  as admin_book_class,
       'if not public.esta_habilitado_para_disciplina(v_user_id, v_discipline_id) then'::text as ancla,
       $bloque$-- NUEVO (Tanda RP, cambiado en Tanda EC): no se reserva una fecha que ya pasó, una clase
  -- que ya TERMINÓ (hora de Argentina) ni un día cerrado. Con la clase en curso, sí.
  -- admin_book_class no tiene estas reglas.
  if p_booking_date < (now() at time zone 'America/Argentina/Mendoza')::date then
    raise exception 'No se puede reservar una fecha que ya pasó.';
  end if;

  -- Con horario de fin válido (posterior al inicio): se puede reservar hasta que termina.
  if exists (
    select 1 from classes c
    where c.id = p_class_id
      and c.end_time > c.start_time
      and (p_booking_date + c.end_time) at time zone 'America/Argentina/Mendoza' <= now()
  ) then
    raise exception 'Esta clase ya terminó: no se puede reservar.';
  end if;

  -- Sin horario de fin válido (null, o no posterior al inicio): como antes, hasta que empieza.
  if exists (
    select 1 from classes c
    where c.id = p_class_id
      and not coalesce(c.end_time > c.start_time, false)
      and (p_booking_date + c.start_time) at time zone 'America/Argentina/Mendoza' <= now()
  ) then
    raise exception 'Esta clase ya empezó: no se puede reservar.';
  end if;

  if exists (select 1 from closed_days where fecha = p_booking_date) then
    raise exception 'El gimnasio está cerrado ese día.';
  end if;

  $bloque$::text as bloque;

-- Huella de TODAS las demás funciones (cuerpo y permisos), para la G6.
create function pg_temp.ec_huella_otras() returns text
language sql stable as $f$
  select md5(string_agg(p.oid::text || '=' || coalesce(p.proacl::text, 'NULL') || '=' || md5(coalesce(p.prosrc, '')),
                        ';' order by p.oid))
  from pg_proc p
  where p.oid <> (select book_class::oid from _ec)
    and p.pronamespace not in (select n.oid from pg_namespace n where n.nspname like 'pg_temp%')
$f$;

-- ── G0 a G3 ─────────────────────────────────────────────────────────────────────────
do $guarda$
declare
  r record;
  v_rp record;
  v_veces int;
begin
  select * into r from _ec;

  -- G0
  if current_user <> 'postgres' then
    raise exception 'Tanda EC: hay que correrla como postgres (está corriendo como %). No se aplicó nada.', current_user;
  end if;
  if to_regclass('respaldo.tanda_rp_funciones') is null then
    raise exception 'Tanda EC: no existe respaldo.tanda_rp_funciones (¿se hizo el rollback de la Tanda RP?). No se aplicó nada.';
  end if;
  select * into v_rp from respaldo.tanda_rp_funciones where funcion = 'public.book_class(uuid, date)';
  if not found then
    raise exception 'Tanda EC: el respaldo de la Tanda RP no tiene a book_class. No se aplicó nada.';
  end if;

  -- G1
  if md5(pg_get_functiondef(r.book_class)) is distinct from v_rp.huella_nueva then
    raise exception 'Tanda EC: book_class no es la que dejó la Tanda RP (huella %, se esperaba %). No se aplicó nada.',
      md5(pg_get_functiondef(r.book_class)), v_rp.huella_nueva;
  end if;

  -- G2
  v_veces := (length(v_rp.definicion_antes) - length(replace(v_rp.definicion_antes, r.ancla, ''))) / length(r.ancla);
  if v_veces <> 1 then
    raise exception 'Tanda EC: el punto de inserción aparece % vez/veces en la definición de antes de la RP (se esperaba 1). No se aplicó nada.', v_veces;
  end if;

  -- G3
  if position('ya terminó' in pg_get_functiondef(r.book_class)) > 0 then
    raise exception 'Tanda EC: book_class ya tiene la regla nueva. No se aplicó nada.';
  end if;
  if has_function_privilege('anon', r.book_class, 'EXECUTE')
     or not has_function_privilege('authenticated', r.book_class, 'EXECUTE') then
    raise exception 'Tanda EC: los permisos de book_class no son los esperados (anon no, authenticated sí). No se aplicó nada.';
  end if;
end;
$guarda$;

-- ── Foto de antes ───────────────────────────────────────────────────────────────────
create temp table _antes on commit drop as
select pg_get_functiondef(p.oid)                        as definicion,
       coalesce(p.proacl::text, 'NULL')                 as permisos,
       p.proowner                                       as duenio,
       p.prosecdef                                      as security_definer,
       p.provolatile                                    as volatilidad,
       coalesce(array_to_string(p.proconfig, ','), '') as config,
       (select md5(pg_get_functiondef(q.oid)) || '|' || coalesce(q.proacl::text, 'NULL')
        from pg_proc q where q.oid = (select admin_book_class from _ec)) as huella_admin,
       pg_temp.ec_huella_otras()                        as huella_otras
from pg_proc p
where p.oid = (select book_class from _ec);

-- ── Respaldo ────────────────────────────────────────────────────────────────────────
create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

-- Sin "if not exists": si ya existe, esta tanda ya se corrió y no se aplica nada.
create table respaldo.tanda_ec_funciones (
  funcion           text primary key,
  definicion_antes  text not null,   -- la versión de la Tanda RP
  huella_antes      text not null,
  definicion_nueva  text not null,
  huella_nueva      text,
  permisos          text not null,
  guardado_en       timestamptz not null default now()
);
revoke all on respaldo.tanda_ec_funciones from public, anon, authenticated;

-- ── El cambio ───────────────────────────────────────────────────────────────────────
do $aplicar$
declare
  r record;
  a record;
  v_rp record;
  v_nueva text;
begin
  select * into r from _ec;
  select * into a from _antes;
  select * into v_rp from respaldo.tanda_rp_funciones where funcion = 'public.book_class(uuid, date)';

  -- Definición de producción de antes de la RP + el bloque reescrito, en el mismo lugar.
  v_nueva := replace(v_rp.definicion_antes, r.ancla, r.bloque || r.ancla);

  insert into respaldo.tanda_ec_funciones (funcion, definicion_antes, huella_antes, definicion_nueva, permisos)
  values ('public.book_class(uuid, date)', a.definicion, md5(a.definicion), v_nueva, a.permisos);

  execute v_nueva;

  update respaldo.tanda_ec_funciones
  set huella_nueva = md5(pg_get_functiondef(r.book_class))
  where funcion = 'public.book_class(uuid, date)';
end;
$aplicar$;

-- ── G4 a G6: después ────────────────────────────────────────────────────────────────
do $despues$
declare
  r record;
  a record;
  e record;
  d record;
begin
  select * into r from _ec;
  select * into a from _antes;
  select * into e from respaldo.tanda_ec_funciones where funcion = 'public.book_class(uuid, date)';

  -- G4
  if pg_get_functiondef(r.book_class) <> e.definicion_nueva then
    raise exception 'Tanda EC: book_class no quedó exactamente como la definición armada. Se deshace todo.';
  end if;
  if position('Esta clase ya terminó: no se puede reservar.' in pg_get_functiondef(r.book_class)) = 0 then
    raise exception 'Tanda EC: book_class no tiene la regla nueva. Se deshace todo.';
  end if;

  -- G5
  select coalesce(p.proacl::text, 'NULL') as permisos, p.proowner as duenio, p.prosecdef as security_definer,
         p.provolatile as volatilidad, coalesce(array_to_string(p.proconfig, ','), '') as config
    into d from pg_proc p where p.oid = r.book_class;
  if d.permisos <> a.permisos or d.duenio <> a.duenio or d.security_definer <> a.security_definer
     or d.volatilidad <> a.volatilidad or d.config <> a.config then
    raise exception 'Tanda EC: cambiaron el dueño, los permisos o los atributos de book_class. Se deshace todo.';
  end if;

  -- G6
  if (select md5(pg_get_functiondef(q.oid)) || '|' || coalesce(q.proacl::text, 'NULL')
      from pg_proc q where q.oid = r.admin_book_class) <> a.huella_admin then
    raise exception 'Tanda EC: cambió admin_book_class. Se deshace todo.';
  end if;
  if pg_temp.ec_huella_otras() <> a.huella_otras then
    raise exception 'Tanda EC: cambió alguna otra función de la base. Se deshace todo.';
  end if;

  raise notice 'Tanda EC aplicada: book_class acepta la clase en curso hasta que termina. Huella nueva: %.', e.huella_nueva;
end;
$despues$;

drop function pg_temp.ec_huella_otras();

commit;
