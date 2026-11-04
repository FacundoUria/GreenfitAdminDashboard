-- =====================================================================================
-- T7 -- el candado: un socio no puede quedar con DOS fechas de vencimiento vigentes (R1).
-- NO SE CORRIÓ TODAVÍA. ESTAMOS EN PRODUCCIÓN.
--
-- Qué hace (solo SQL, ningún cambio de Admin ni PWA):
--   1) candado_una_fecha_vigente() -- NUEVA, función de trigger, SECURITY DEFINER, sin EXECUTE
--      para public, anon ni authenticated.
--   2) Dos triggers de restricción DIFERIDOS (DEFERRABLE INITIALLY DEFERRED) sobre user_credits:
--        candado_una_fecha_vigente_ins -- AFTER INSERT
--        candado_una_fecha_vigente_upd -- AFTER UPDATE OF expires_at, remaining_credits, user_id, discipline_id
--      Son dos porque el WHEN de un INSERT no puede mirar OLD.
--
-- Cuándo se dispara (el WHEN se evalúa al escribir la fila; el chequeo, al final de la transacción):
--   * INSERT de una fila vigente: expires_at > now() y (saldo > 0 o saldo null = Aparatos).
--   * UPDATE que deja la fila vigente (expires_at > now() y saldo > 0 o null) Y además:
--       - cambia expires_at, o
--       - el lote pasa de 0 (o null) a más de 0, o
--       - la fila cambia de socio o de disciplina (también le agrega una fecha a alguien).
--   * NO se dispara: bajas de saldo (reservar, ajustar −1), vencer filas (reseteo de un cobro,
--     quitar disciplina), lotes en 0 y filas con expires_at null.
--
-- Qué chequea (al final de la transacción, con el estado FINAL del socio):
--   vigentes = lotes de créditos (kind = 'credits') con saldo > 0 y expires_at > now()
--            + filas de Aparatos (kind = 'membership') con expires_at > now().
--   Se comparan por DÍA en Argentina (ultimo_dia_plan). Con 2 o más días distintos: error
--   23514 "El socio X quedaría con dos fechas de vencimiento vigentes (dd/mm y dd/mm). No se
--   guardó nada." y se deshace la transacción entera.
--   Como es diferido, los flujos de "resetear y después acreditar" (cobro manual, acreditar_pack)
--   y "mover fechas" (editar fecha) pasan: en el medio puede haber 2 fechas, al final hay 1.
--
-- Carrera entre dos transacciones del mismo socio: el chequeo toma un advisory lock por socio
-- (hasta el fin de la transacción) antes de contar; la segunda espera a que la primera termine y
-- cuenta con lo que la primera dejó.
--
-- SECURITY DEFINER a propósito: el chequeo diferido corre al COMMIT, cuando ya terminó la función
-- SECURITY DEFINER que escribió (book_class, cancel_booking_detalle...), o sea con el rol de la
-- sesión (authenticated). Como invoker no podría llamar a ultimo_dia_plan (revocada para
-- authenticated) ni leer el nombre del socio por RLS, y rompería todas las reservas.
-- Un trigger no necesita EXECUTE del que dispara la escritura: por eso se revoca todo.
--
-- Ningún UPDATE/DELETE/INSERT sobre datos. Toma un lock SHARE ROW EXCLUSIVE sobre user_credits
-- mientras corre (milisegundos): las escrituras de ese momento esperan, las lecturas no.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) Ni los triggers ni la función existen todavía.
--   2) ultimo_dia_plan tiene la huella sin espacios de T2 (1682ea09613a4e9fd86f0101dca063a7).
--   3) Hoy hay 0 socios con 2 o más fechas vigentes (si hay alguno, frena y los nombra).
--   4) Al final: la función sin EXECUTE para public, anon ni authenticated, y los dos triggers
--      creados como de restricción, DEFERRABLE INITIALLY DEFERRED y habilitados.
--
-- Prueba: prueba_t7.sql (se corre DESPUÉS de esta migración).
-- Rollback: rollback_t7.sql.
-- =====================================================================================

begin;

-- Nadie escribe en user_credits entre la guarda 3 y la creación de los triggers.
lock table public.user_credits in share row exclusive mode;

-- ── Guardas 1, 2 y 3 ──
do $guarda$
declare
  v_huella text;
  v_lista text;
  v_cantidad int;
begin
  -- 1) Ni los triggers ni la función existen todavía.
  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.user_credits'::regclass
      and tgname in ('candado_una_fecha_vigente_ins', 'candado_una_fecha_vigente_upd')
  ) then
    raise exception 'T7: el candado ya existe en user_credits. No se aplicó nada.';
  end if;
  if to_regprocedure('public.candado_una_fecha_vigente()') is not null then
    raise exception 'T7: la función candado_una_fecha_vigente() ya existe. No se aplicó nada.';
  end if;

  -- 2) ultimo_dia_plan es la de T2.
  if to_regprocedure('public.ultimo_dia_plan(timestamp with time zone)') is null then
    raise exception 'T7: no existe ultimo_dia_plan (falta T2). No se aplicó nada.';
  end if;
  v_huella := md5(regexp_replace(pg_get_functiondef('public.ultimo_dia_plan(timestamp with time zone)'::regprocedure), '\s+', '', 'g'));
  if v_huella <> '1682ea09613a4e9fd86f0101dca063a7' then
    raise exception 'T7: ultimo_dia_plan no es la versión de T2 (huella sin espacios %). No se aplicó nada.', v_huella;
  end if;

  -- 3) Hoy, 0 socios con 2 o más fechas vigentes (mismo criterio que el candado).
  with vigentes as (
    select uc.user_id, public.ultimo_dia_plan(uc.expires_at) as dia
    from public.user_credits uc
    join public.disciplines d on d.id = uc.discipline_id
    where uc.expires_at > now()
      and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership')
  ),
  dobles as (
    select user_id, array_agg(distinct dia order by dia) as dias
    from vigentes
    group by user_id
    having count(distinct dia) >= 2
  )
  select count(*)::int,
         string_agg(
           coalesce(
             nullif(trim(p.full_name), ''),
             (select nullif(trim(coalesce(s.nombre, '') || ' ' || coalesce(s.apellido, '')), '')
              from public.socios s where s.dni = p.dni order by s.id limit 1),
             'sin nombre (id ' || x.user_id::text || ')')
           || ' (DNI ' || coalesce(p.dni, '-') || '): '
           || (select string_agg(to_char(dd, 'DD/MM/YYYY'), ' y ' order by dd) from unnest(x.dias) as dd),
           ' | ' order by x.user_id)
    into v_cantidad, v_lista
  from dobles x
  left join public.profiles p on p.id = x.user_id;

  if v_cantidad > 0 then
    raise exception 'T7: hay % socio(s) que hoy ya tienen 2 o más fechas vigentes: %. Hay que resolverlos antes de poner el candado. No se aplicó nada.', v_cantidad, v_lista;
  end if;
end;
$guarda$;

-- ── candado_una_fecha_vigente (NUEVA) ──
CREATE OR REPLACE FUNCTION public.candado_una_fecha_vigente()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_dias date[];
  v_n int;
  v_textos text[];
  v_lista text;
  v_completas text;
  v_cuantas text;
  v_nombre text;
  v_dni text;
begin
  -- T7 (R1): se corre al final de la transacción (trigger diferido), con el estado FINAL del
  -- socio. Solo llega acá una escritura que agrega una fecha (ver el WHEN de los triggers).

  -- Dos transacciones del mismo socio a la vez: la segunda espera a que la primera termine.
  perform pg_advisory_xact_lock(hashtextextended('t7_candado_una_fecha:' || NEW.user_id::text, 0));

  select array_agg(x.dia order by x.dia)
    into v_dias
  from (
    select distinct public.ultimo_dia_plan(uc.expires_at) as dia
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id
    where uc.user_id = NEW.user_id
      and uc.expires_at > now()
      and ((d.kind = 'credits' and uc.remaining_credits > 0) or d.kind = 'membership')
  ) x;

  v_n := coalesce(array_length(v_dias, 1), 0);
  if v_n < 2 then
    return null;
  end if;

  -- Nombre del socio: el del perfil; si no, el de la ficha; si no, su DNI o su id.
  select nullif(trim(p.full_name), ''), p.dni into v_nombre, v_dni
  from profiles p where p.id = NEW.user_id;
  if v_nombre is null and v_dni is not null then
    select nullif(trim(coalesce(s.nombre, '') || ' ' || coalesce(s.apellido, '')), '') into v_nombre
    from socios s where s.dni = v_dni order by s.id limit 1;
  end if;
  v_nombre := coalesce(v_nombre,
                       'sin nombre (DNI ' || v_dni || ')',
                       'sin nombre (id ' || NEW.user_id::text || ')');

  select array_agg(to_char(dd, 'DD/MM') order by dd),
         string_agg(to_char(dd, 'DD/MM/YYYY'), ', ' order by dd)
    into v_textos, v_completas
  from unnest(v_dias) as dd;

  -- "dd/mm y dd/mm" -- con 3 o más: "dd/mm, dd/mm y dd/mm".
  v_lista := array_to_string(v_textos[1:v_n - 1], ', ') || ' y ' || v_textos[v_n];
  v_cuantas := case v_n when 2 then 'dos' when 3 then 'tres' else v_n::text end;

  raise exception using
    errcode = '23514',
    constraint = 'candado_una_fecha_vigente',
    message = format('El socio %s quedaría con %s fechas de vencimiento vigentes (%s). No se guardó nada.',
                     v_nombre, v_cuantas, v_lista),
    detail = format('user_id %s; días vigentes en Argentina: %s.', NEW.user_id, v_completas),
    hint = 'Un socio tiene una sola fecha de vencimiento vigente: usá la fecha del plan o editá la fecha del socio.';
end;
$function$;

revoke all on function public.candado_una_fecha_vigente() from public, anon, authenticated;

-- ── Triggers de restricción, diferidos ──
CREATE CONSTRAINT TRIGGER candado_una_fecha_vigente_ins
  AFTER INSERT ON public.user_credits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.expires_at > now()
        and (NEW.remaining_credits is null or NEW.remaining_credits > 0))
  EXECUTE FUNCTION public.candado_una_fecha_vigente();

CREATE CONSTRAINT TRIGGER candado_una_fecha_vigente_upd
  AFTER UPDATE OF expires_at, remaining_credits, user_id, discipline_id ON public.user_credits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.expires_at > now()
        and (NEW.remaining_credits is null or NEW.remaining_credits > 0)
        and (NEW.expires_at is distinct from OLD.expires_at
             or (coalesce(OLD.remaining_credits, 0) <= 0 and NEW.remaining_credits > 0)
             or NEW.user_id is distinct from OLD.user_id
             or NEW.discipline_id is distinct from OLD.discipline_id))
  EXECUTE FUNCTION public.candado_una_fecha_vigente();

-- ── Guarda 4: permisos de la función y forma de los triggers ──
do $chequeo$
declare
  v_oid oid := 'public.candado_una_fecha_vigente()'::regprocedure;
  v_bien int;
begin
  if (select proacl is null from pg_proc where oid = v_oid)
     or has_function_privilege('anon', v_oid, 'execute')
     or has_function_privilege('authenticated', v_oid, 'execute')
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                where p.oid = v_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'T7: candado_una_fecha_vigente() quedó con EXECUTE para afuera. No se aplicó nada.';
  end if;

  select count(*)::int into v_bien
  from pg_trigger t
  where t.tgrelid = 'public.user_credits'::regclass
    and t.tgname in ('candado_una_fecha_vigente_ins', 'candado_una_fecha_vigente_upd')
    and t.tgfoid = v_oid
    and t.tgconstraint <> 0
    and t.tgdeferrable
    and t.tginitdeferred
    and t.tgenabled = 'O';
  if v_bien <> 2 then
    raise exception 'T7: los triggers no quedaron como de restricción, diferidos y habilitados (% de 2). No se aplicó nada.', v_bien;
  end if;
end;
$chequeo$;

commit;

-- Verificación (solo lectura), después del commit:
-- select t.tgname, t.tgdeferrable, t.tginitdeferred, t.tgenabled,
--        md5(regexp_replace(pg_get_functiondef(t.tgfoid), '\s+', '', 'g')) as huella_sin_espacios,
--        coalesce(p.proacl::text, '(por defecto)') as permisos
-- from pg_trigger t join pg_proc p on p.oid = t.tgfoid
-- where t.tgrelid = 'public.user_credits'::regclass and t.tgname like 'candado_una_fecha_vigente%';
-- -- esperado: 2 filas, true / true / O, y permisos sin anon ni authenticated.
