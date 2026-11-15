-- =====================================================================================
-- PENDIENTES-UP -- "Pagos sin cargar en la app" deja de listar a socios a los que SÍ se les
-- cargó el pago.
-- Corrida en producción el 15/11/2026. Prueba (prueba_pendientes_desde_ultimo_pago.sql): 13 de 13.
--
-- El bug (producción, 15/11/2026): Camila Carrizo (47272008), Malena Carrizo (51090370),
-- Antonela Ponce (38474983) y Silvana Ferron (27036566) aparecían en la lista. Los 4 tenían
-- lotes cargados el 15-16/10, que vencieron el 15/11 a las 00:00 AR. La ficha dice "hasta el
-- 15/11" (fecha_vencimiento >= hoy) y la función pedía "ningún lote VIGENTE ahora": el día que
-- vence un plan cargado, el socio vuelve a la lista. Si Seba aprieta "Cargar créditos", le
-- regala 30 días.
--
-- El cambio (UNA condición de admin_socios_pendientes_de_cargar; el resto queda igual):
--   antes:   y en user_credits no tiene NADA con expires_at > now()
--   ahora:   y en user_credits no tiene NINGÚN lote creado desde el día de su último pago
--            (uc.created_at >= 00:00 AR del día socios.ultimo_pago), vigente o no, con saldo
--            o en 0, de cualquier disciplina (Aparatos incluido).
-- Sigue igual: solo admin (42501), con cuenta (profiles.dni = socios.dni), no dada de baja,
-- ficha con fecha vigente (>= hoy AR), último pago en los últimos 35 días, mismas columnas y
-- mismo orden. Misma firma, STABLE, SECURITY DEFINER, mismo search_path.
--
-- Efecto de lado, a propósito (pediste el criterio literal): un socio con un lote vigente de
-- ANTES de su último pago y ninguno creado después AHORA SÍ aparece (pagó de nuevo y no se le
-- cargó). Antes quedaba escondido. La consulta (D) de investigacion_pendientes_y_regla_a.sql
-- muestra quién entra y quién sale hoy, antes de correr esto.
--
-- El Admin no filtra nada por su cuenta: Socios.jsx usa los socio_id que devuelve la función
-- (filtro "Pagos sin cargar en la app") y PendientesDeCargarAviso.jsx los dibuja. Solo cambian
-- comentarios del Admin (sin cambio de comportamiento, no hace falta desplegarlo).
--
-- Solo reemplaza una función: ningún UPDATE/DELETE/INSERT sobre datos (el único INSERT es al
-- respaldo). Respaldo en respaldo.pendientes_up_funciones (mismo esquema que Tanda MP, no
-- expuesto por la API) con la definición exacta de antes: rollback_pendientes_desde_ultimo_pago.sql
-- vuelve EXACTAMENTE a ella.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) HUELLA: admin_socios_pendientes_de_cargar() tiene la huella sin espacios de T5
--      (9d21d616161c42cb27e711fbe75b2a20, la que verifica prueba_t5.sql).
--   2) No aplicada todavía (no existe respaldo.pendientes_up_funciones).
--   3) Tipos: user_credits.created_at es timestamptz y socios.ultimo_pago es date.
--   4) DESPUÉS: el cuerpo (prosrc) es EXACTAMENTE el de abajo (la huella real queda en el
--      respaldo, y el NOTICE final la muestra para pegarla en la prueba); usa created_at y ya no
--      "expires_at > now()"; permisos (proacl EXACTO), security definer, volatilidad y config
--      EXACTAMENTE iguales; sin EXECUTE para public ni anon; authenticated sí.
--
-- Sin guarda de horario: no escribe fechas (el "hoy" ya es el de Argentina).
-- Prueba: prueba_pendientes_desde_ultimo_pago.sql (DESPUÉS de esta migración).
-- Rollback: rollback_pendientes_desde_ultimo_pago.sql.
-- =====================================================================================

begin;

set local lock_timeout = '5s';

-- ── Guardas 1 a 3 ─────────────────────────────────────────────────────────────────────
do $guarda$
declare
  c_funcion constant text := 'public.admin_socios_pendientes_de_cargar()';
  v_huella text;
  v_tipo text;
begin
  if to_regprocedure(c_funcion) is null then
    raise exception 'Pendientes-UP: no existe %. No se aplicó nada.', c_funcion;
  end if;

  -- 1) Huella de T5.
  v_huella := md5(regexp_replace(pg_get_functiondef(to_regprocedure(c_funcion)), '\s+', '', 'g'));
  if v_huella <> '9d21d616161c42cb27e711fbe75b2a20' then
    raise exception 'Pendientes-UP: admin_socios_pendientes_de_cargar no es la versión de T5 (huella sin espacios %, esperada 9d21d616161c42cb27e711fbe75b2a20). No se aplicó nada.', v_huella;
  end if;

  -- 2) No aplicada.
  if to_regclass('respaldo.pendientes_up_funciones') is not null then
    raise exception 'Pendientes-UP: ya existe respaldo.pendientes_up_funciones (¿ya aplicada?). No se aplicó nada.';
  end if;

  -- 3) Tipos.
  select format_type(a.atttypid, a.atttypmod) into v_tipo
  from pg_attribute a
  where a.attrelid = 'public.user_credits'::regclass and a.attname = 'created_at' and not a.attisdropped;
  if v_tipo is distinct from 'timestamp with time zone' then
    raise exception 'Pendientes-UP: user_credits.created_at es % (se esperaba timestamp with time zone). No se aplicó nada.', coalesce(v_tipo, 'inexistente');
  end if;
  select format_type(a.atttypid, a.atttypmod) into v_tipo
  from pg_attribute a
  where a.attrelid = 'public.socios'::regclass and a.attname = 'ultimo_pago' and not a.attisdropped;
  if v_tipo is distinct from 'date' then
    raise exception 'Pendientes-UP: socios.ultimo_pago es % (se esperaba date). No se aplicó nada.', coalesce(v_tipo, 'inexistente');
  end if;
end;
$guarda$;

-- ── Respaldo ──────────────────────────────────────────────────────────────────────────
create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

create table respaldo.pendientes_up_funciones (
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
revoke all on respaldo.pendientes_up_funciones from public, anon, authenticated;

-- ── El cambio ─────────────────────────────────────────────────────────────────────────
do $aplicar$
declare
  r record;
  v_def text;
  v_nueva text := $nueva$CREATE OR REPLACE FUNCTION public.admin_socios_pendientes_de_cargar()
 RETURNS TABLE(socio_id bigint, nombre text, apellido text, dni text, plan text[], creditos_ficha integer, fecha_vencimiento_ficha date, ultimo_pago date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  v_hoy date := (now() at time zone c_zona)::date;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.' using errcode = '42501';
  end if;

  -- Cobró sin cuenta (o la cuenta llegó después) y, desde ese cobro, en la app no se le creó
  -- NINGÚN lote. Pendientes-UP: cuenta cualquier lote creado desde las 00:00 AR del día del
  -- último pago, vigente o no, con saldo o en 0 (antes se pedía "nada vigente ahora" y el día
  -- que vencía un plan ya cargado el socio volvía a la lista).
  return query
  select s.id::bigint,
         s.nombre::text,
         s.apellido::text,
         s.dni::text,
         s.plan,
         s.creditos::integer,
         s.fecha_vencimiento::date,
         s.ultimo_pago::date
  from socios s
  where s.activo is not false
    and s.fecha_vencimiento::date >= v_hoy
    and s.ultimo_pago::date >= v_hoy - 35
    and exists (select 1 from profiles p where p.dni = s.dni)
    and not exists (
      select 1
      from profiles p
      join user_credits uc on uc.user_id = p.id
      where p.dni = s.dni
        and uc.created_at >= (s.ultimo_pago::date::timestamp at time zone c_zona)
    )
  order by s.ultimo_pago::date desc, s.id;
end;
$function$
$nueva$;
begin
  select p.oid, p.oid::regprocedure::text as funcion, p.proacl, p.prosecdef, p.provolatile, p.proconfig into r
  from pg_proc p
  where p.oid = 'public.admin_socios_pendientes_de_cargar()'::regprocedure;

  v_def := pg_get_functiondef(r.oid);

  insert into respaldo.pendientes_up_funciones
    (funcion, definicion_antes, huella_antes, huella_antes_sin_espacios, definicion_nueva, huella_nueva_sin_espacios,
     permisos, security_definer, volatilidad, config)
  values
    (r.funcion, v_def, md5(v_def), md5(regexp_replace(v_def, '\s+', '', 'g')), v_nueva, md5(regexp_replace(v_nueva, '\s+', '', 'g')),
     coalesce(r.proacl::text, '(por defecto)'), r.prosecdef, r.provolatile, coalesce(array_to_string(r.proconfig, ','), ''));

  execute v_nueva;

  -- El encabezado lo reformatea Postgres; el cuerpo se guarda tal cual. Se verifica el cuerpo
  -- exacto (guarda 4) y se guarda la huella REAL de lo que quedó, que es la que mira el rollback.
  update respaldo.pendientes_up_funciones
  set huella_nueva_sin_espacios = md5(regexp_replace(pg_get_functiondef(r.oid), '\s+', '', 'g'))
  where funcion = r.funcion;
end;
$aplicar$;

-- ── Guarda 4: verificación DESPUÉS ────────────────────────────────────────────────────
do $verifica$
declare
  b record;
  p record;
  v_def text;
  v_acl text;
begin
  select * into b from respaldo.pendientes_up_funciones;
  select * into p from pg_proc where oid = b.funcion::regprocedure;
  v_def := pg_get_functiondef(p.oid);

  if p.prosrc is distinct from substring(b.definicion_nueva from '\$function\$(.*)\$function\$') then
    raise exception 'Pendientes-UP: el cuerpo de la función no quedó EXACTAMENTE como el texto de esta migración. No se aplicó nada.';
  end if;
  if md5(regexp_replace(v_def, '\s+', '', 'g')) <> b.huella_nueva_sin_espacios then
    raise exception 'Pendientes-UP: la huella guardada en el respaldo no es la de la función. No se aplicó nada.';
  end if;
  if md5(regexp_replace(v_def, '\s+', '', 'g')) <> md5(regexp_replace(b.definicion_nueva, '\s+', '', 'g')) then
    raise notice 'Pendientes-UP: aviso -- el encabezado que imprime Postgres difiere del texto de la migración (el cuerpo es idéntico). Huella real: %.',
      b.huella_nueva_sin_espacios;
  end if;
  if p.prosrc !~ 'uc\.created_at\s*>=' or p.prosrc ~* 'uc\.expires_at\s*>\s*now\(\)' then
    raise exception 'Pendientes-UP: el cuerpo no quedó con el criterio nuevo (created_at desde el último pago). No se aplicó nada.';
  end if;

  v_acl := coalesce(p.proacl::text, '(por defecto)');
  if v_acl <> b.permisos
     or p.prosecdef <> b.security_definer
     or p.provolatile <> b.volatilidad
     or coalesce(array_to_string(p.proconfig, ','), '') <> b.config then
    raise exception 'Pendientes-UP: cambiaron permisos o atributos: antes %, ahora %. No se aplicó nada.', b.permisos, v_acl;
  end if;
  if v_acl = '(por defecto)' or v_acl ~ '(^|[{,])=' or v_acl ~ '(^|[{,])anon=' or v_acl !~ '(^|[{,])authenticated=X' then
    raise exception 'Pendientes-UP: permisos inesperados (%): tiene que ser authenticated sí, public y anon no. No se aplicó nada.', v_acl;
  end if;

  raise notice 'Pendientes-UP aplicada. Huella exacta: antes % / después %. Sin espacios: antes % / después %. Permisos: %',
    b.huella_antes, md5(v_def), b.huella_antes_sin_espacios, b.huella_nueva_sin_espacios, v_acl;
end;
$verifica$;

commit;

-- Después de correrla (solo lectura):
--   select md5(regexp_replace(pg_get_functiondef('public.admin_socios_pendientes_de_cargar()'::regprocedure), '\s+', '', 'g')),
--          (select huella_nueva_sin_espacios from respaldo.pendientes_up_funciones);   -- iguales
--   + la consulta (D) de investigacion_pendientes_y_regla_a.sql: ya no tiene que haber "sale".
