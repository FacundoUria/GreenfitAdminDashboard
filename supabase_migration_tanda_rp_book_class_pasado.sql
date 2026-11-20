-- =====================================================================================
-- TANDA RP -- book_class deja de aceptar fechas pasadas, clases ya empezadas y días cerrados.
-- Corrida en producción el 20/11/2026 (prueba 9 de 9). Diagnóstico de ese día: huella de
-- book_class abajo, punto de inserción 1 vez, sin las reglas; closed_days.fecha date UNIQUE,
-- dueño postgres, RLS no forzada, 0 días cerrados. Últimos 90 días: socios 21 de 1206 reservas
-- con la clase ya empezada (máx. 553 min), Seba 10 de 16 (máx. 69 min). QUERY 5: solo
-- admin_book_class, por su comentario "mismo guard que book_class()" (no la llama).
--
-- Por qué: book_class() no mira la hora. La PWA esconde las clases que ya empezaron, pero un
-- socio logueado puede llamar supabase.rpc('book_class', ...) desde la consola con cualquier
-- fecha: una clase de la semana pasada o una que ya empezó. Le gasta un crédito, le da XP y,
-- como la asistencia se cuenta por fecha, le queda "Asistió". Tampoco mira closed_days: los
-- días cerrados los frena la PWA, el servidor no.
--
-- Qué cambia: SOLO book_class(uuid, date). Se le insertan 3 rechazos en el cuerpo de
-- PRODUCCIÓN (no en una copia del repo), justo después de "La clase no existe" y antes del
-- chequeo de plan/créditos:
--   1) fecha anterior a hoy en Argentina     -> 'No se puede reservar una fecha que ya pasó.'
--   2) la clase ya empezó: fecha + start_time en hora de Argentina <= ahora
--                                             -> 'Esta clase ya empezó: no se puede reservar.'
--   3) la fecha está en closed_days           -> 'El gimnasio está cerrado ese día.'
-- El resto del cuerpo queda igual, letra por letra (G6): créditos, XP, cupo, fecha única, día
-- de semana y cancelaciones puntuales no cambian. Misma zona horaria que cancel_booking y el
-- trigger de clases de una sola vez ('America/Argentina/Mendoza').
--
-- Qué NO cambia:
--   * admin_book_class(): sin límite; Seba puede anotar a cualquiera en cualquier caso (G7:
--     definición y permisos idénticos).
--   * La PWA: ya muestra el texto que devuelve el servidor ("No se pudo reservar" + mensaje).
--     El único caso nuevo en uso normal: la Agenda quedó abierta desde antes de que empiece la
--     clase y el socio toca después. Hoy reserva; con esto, avisa "Esta clase ya empezó".
--   * Permisos: create or replace los conserva (anon no, authenticated sí, desde Tanda C).
--
-- Guardas (si alguna falla, no se aplica nada):
--   G1) Huella EXACTA de book_class = la de producción (QUERY 1 del diagnóstico).
--   G2) El punto de inserción ("if not public.esta_habilitado_para_disciplina(v_user_id,
--       v_discipline_id) then") aparece UNA sola vez en el cuerpo.
--   G3) El cuerpo todavía no tiene las reglas nuevas.
--   G4) closed_days.fecha existe y es de tipo date.
--   G5) Permisos de book_class: anon no puede ejecutarla; authenticated sí.
--   DESPUÉS:
--   G6) El cuerpo nuevo es EXACTAMENTE el de producción con el bloque insertado; mismo dueño,
--       permisos, security definer, volatilidad y config; anon sigue sin poder, authenticated sí.
--   G7) admin_book_class: definición y permisos idénticos a los de antes.
--
-- Respaldo: definición de antes y de después en respaldo.tanda_rp_funciones. El rollback
-- vuelve a ejecutar la de antes, tal cual.
-- Prueba:   prueba_tanda_rp.sql (DESPUÉS de esta migración: 9 de 9).
-- Rollback: rollback_tanda_rp.sql.
-- =====================================================================================

begin;

-- Qué se toca y cómo. El bloque termina en una línea en blanco + la sangría de la línea que
-- sigue, así el "if not public.esta_habilitado..." de producción queda en su lugar.
create temp table _rp on commit drop as
select 'public.book_class(uuid, date)'::regprocedure             as book_class,
       'public.admin_book_class(uuid, uuid, date)'::regprocedure  as admin_book_class,
       '5a1e988aa67d6573b5dbbcd46fadaf23'::text                   as huella_esperada,   -- QUERY 1 (20/11/2026)
       'if not public.esta_habilitado_para_disciplina(v_user_id, v_discipline_id) then'::text as ancla,
       $bloque$-- NUEVO (Tanda RP): no se reserva una fecha que ya pasó, una clase que ya empezó
  -- (hora de Argentina) ni un día cerrado. admin_book_class no tiene estas reglas.
  if p_booking_date < (now() at time zone 'America/Argentina/Mendoza')::date then
    raise exception 'No se puede reservar una fecha que ya pasó.';
  end if;

  if exists (
    select 1 from classes c
    where c.id = p_class_id
      and (p_booking_date + c.start_time) at time zone 'America/Argentina/Mendoza' <= now()
  ) then
    raise exception 'Esta clase ya empezó: no se puede reservar.';
  end if;

  if exists (select 1 from closed_days where fecha = p_booking_date) then
    raise exception 'El gimnasio está cerrado ese día.';
  end if;

  $bloque$::text as bloque;

-- ── G1 a G5 ─────────────────────────────────────────────────────────────────────────
do $guarda$
declare
  r record;
  v_def text;
  v_src text;
  v_veces int;
begin
  select * into r from _rp;

  if r.huella_esperada like 'PEGAR_%' then
    raise exception 'Tanda RP: falta pegar la huella de book_class de la QUERY 1 del diagnóstico. No se aplicó nada.';
  end if;

  v_def := pg_get_functiondef(r.book_class);
  select p.prosrc into v_src from pg_proc p where p.oid = r.book_class;

  -- G1
  if md5(v_def) <> r.huella_esperada then
    raise exception 'Tanda RP: book_class no es la versión de producción del diagnóstico (huella %, se esperaba %). No se aplicó nada.',
      md5(v_def), r.huella_esperada;
  end if;

  -- G2
  v_veces := (length(v_src) - length(replace(v_src, r.ancla, ''))) / length(r.ancla);
  if v_veces <> 1 then
    raise exception 'Tanda RP: el punto de inserción aparece % vez/veces en book_class (se esperaba 1). No se aplicó nada.', v_veces;
  end if;

  -- G3
  if position('closed_days' in v_src) > 0 or position('ya empezó' in v_src) > 0
     or position('fecha que ya pasó' in v_src) > 0 then
    raise exception 'Tanda RP: book_class ya tiene alguna de las reglas nuevas. No se aplicó nada.';
  end if;

  -- G4
  if not exists (select 1 from pg_attribute a
                 where a.attrelid = to_regclass('public.closed_days') and a.attname = 'fecha'
                   and not a.attisdropped and a.atttypid = 'date'::regtype) then
    raise exception 'Tanda RP: no existe closed_days.fecha de tipo date. No se aplicó nada.';
  end if;

  -- G5
  if has_function_privilege('anon', r.book_class, 'EXECUTE')
     or not has_function_privilege('authenticated', r.book_class, 'EXECUTE') then
    raise exception 'Tanda RP: los permisos de book_class no son los esperados (anon no, authenticated sí). No se aplicó nada.';
  end if;
end;
$guarda$;

-- ── Foto de antes ───────────────────────────────────────────────────────────────────
create temp table _antes on commit drop as
select pg_get_functiondef(p.oid)                        as definicion,
       p.prosrc                                         as prosrc,
       coalesce(p.proacl::text, 'NULL')                 as permisos,
       p.proowner                                       as duenio,
       p.prosecdef                                      as security_definer,
       p.provolatile                                    as volatilidad,
       coalesce(array_to_string(p.proconfig, ','), '') as config,
       (select md5(pg_get_functiondef(q.oid)) || '|' || coalesce(q.proacl::text, 'NULL')
        from pg_proc q where q.oid = (select admin_book_class from _rp)) as huella_admin
from pg_proc p
where p.oid = (select book_class from _rp);

-- ── Respaldo ────────────────────────────────────────────────────────────────────────
create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

-- Sin "if not exists": si ya existe, esta tanda ya se corrió y no se aplica nada.
create table respaldo.tanda_rp_funciones (
  funcion           text primary key,
  definicion_antes  text not null,
  huella_antes      text not null,
  definicion_nueva  text not null,
  huella_nueva      text,
  permisos          text not null,
  guardado_en       timestamptz not null default now()
);
revoke all on respaldo.tanda_rp_funciones from public, anon, authenticated;

-- ── El cambio: el bloque, insertado en la definición de producción ───────────────────
do $aplicar$
declare
  r record;
  a record;
  v_nueva text;
begin
  select * into r from _rp;
  select * into a from _antes;

  v_nueva := replace(a.definicion, r.ancla, r.bloque || r.ancla);

  insert into respaldo.tanda_rp_funciones (funcion, definicion_antes, huella_antes, definicion_nueva, permisos)
  values ('public.book_class(uuid, date)', a.definicion, md5(a.definicion), v_nueva, a.permisos);

  execute v_nueva;

  update respaldo.tanda_rp_funciones
  set huella_nueva = md5(pg_get_functiondef(r.book_class))
  where funcion = 'public.book_class(uuid, date)';
end;
$aplicar$;

-- ── G6, G7: después ─────────────────────────────────────────────────────────────────
do $despues$
declare
  r record;
  a record;
  d record;
begin
  select * into r from _rp;
  select * into a from _antes;
  select p.prosrc, coalesce(p.proacl::text, 'NULL') as permisos, p.proowner as duenio,
         p.prosecdef as security_definer, p.provolatile as volatilidad,
         coalesce(array_to_string(p.proconfig, ','), '') as config
    into d
  from pg_proc p where p.oid = r.book_class;

  -- G6
  if d.prosrc <> replace(a.prosrc, r.ancla, r.bloque || r.ancla) then
    raise exception 'Tanda RP: el cuerpo nuevo de book_class no es el de producción + el bloque. Se deshace todo.';
  end if;
  if d.permisos <> a.permisos or d.duenio <> a.duenio or d.security_definer <> a.security_definer
     or d.volatilidad <> a.volatilidad or d.config <> a.config then
    raise exception 'Tanda RP: cambió el dueño, los permisos o los atributos de book_class. Se deshace todo.';
  end if;
  if has_function_privilege('anon', r.book_class, 'EXECUTE')
     or not has_function_privilege('authenticated', r.book_class, 'EXECUTE') then
    raise exception 'Tanda RP: después, los permisos de book_class no son anon no / authenticated sí. Se deshace todo.';
  end if;

  -- G7
  if (select md5(pg_get_functiondef(q.oid)) || '|' || coalesce(q.proacl::text, 'NULL')
      from pg_proc q where q.oid = r.admin_book_class) <> a.huella_admin then
    raise exception 'Tanda RP: cambió admin_book_class. Se deshace todo.';
  end if;

  raise notice 'Tanda RP aplicada: book_class rechaza fechas pasadas, clases ya empezadas y días cerrados. Huella nueva: %.',
    md5(pg_get_functiondef(r.book_class));
end;
$despues$;

commit;
