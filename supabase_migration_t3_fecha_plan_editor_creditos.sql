-- =====================================================================================
-- T3 -- el editor de créditos y "+ Agregar Aparatos" usan la fecha del plan calculada ANTES de
-- tocar nada. NO SE CORRIÓ TODAVÍA. ESTAMOS EN PRODUCCIÓN.
--
-- Requiere T2 aplicada (usa fecha_plan_socio y ultimo_dia_plan). Las 3 funciones mantienen su
-- firma y lo que devuelven (void): el Admin no cambia.
--
-- Común a las 3:
--   * Bloquean las filas de user_credits del socio (mismo criterio que el editar fecha de T2):
--     no se cruzan con un cobro, una reserva u otra edición en paralelo.
--   * La fecha del plan se calcula ANTES de escribir nada: fecha_plan_socio(); si es null (el
--     socio no tiene fecha vigente), now() + 30 días (regla E). Todo lote nuevo usa esa fecha.
--   * D-T3c: si el socio tiene DNI y no hay ninguna ficha en socios con ese DNI, error y no se
--     cambia nada (antes los créditos cambiaban y la ficha no, sin avisar).
--
--   1) admin_fijar_creditos_disciplina -- antes ponía en 0 y DESPUÉS pedía la fecha: podía
--      tomar un residuo en 0 de otra disciplina (el más nuevo) y cambiar la fecha del plan.
--        - D-T3a: en ESA disciplina, los lotes en 0 de OTRO día que el plan se vencen
--          (least(expires_at, now() - 1 día), igual que los cobros): si no, un reintegro al
--          cancelar los revive con una 2ª fecha. Los del día del plan quedan como están.
--        - D-T3b: fijar en 0 no crea un lote en 0 (a un socio sin nada le abría un plan de
--          30 días).
--        - Si el plan nace acá (no había fecha vigente), la ficha refleja su fecha.
--   2) admin_ajustar_credito_disciplina
--        - al sumar: primero el lote del plan de esa disciplina (mismo día en Argentina que la
--          fecha del plan, aunque esté en 0; entre varios, el que tiene saldo y después el más
--          nuevo); si no hay, un lote nuevo con la fecha del plan. Si el plan nace acá, la
--          ficha refleja su fecha.
--        - al restar: el mismo FIFO de siempre. D-T3d: si no alcanza para descontar todo lo
--          pedido, error y no cambia nada (antes "-1" sin saldo no hacía nada sin avisar).
--   3) admin_agregar_aparatos_socio (D3, explícito)
--        - D-T3e: exige exactamente UNA disciplina de membresía (antes "limit 1" sin orden).
--        - fecha = fecha_plan_socio() o now() + 30 días, sin pasar por el resolver.
--
-- Solo reemplaza funciones. Ningún UPDATE/DELETE/INSERT sobre datos existentes. La tabla
-- temporal de abajo es solo para comparar los permisos antes/después y se borra sola al
-- terminar la transacción.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) Las huellas actuales (md5 exacto de pg_get_functiondef) tienen que ser las de producción:
--      admin_fijar_creditos_disciplina = 874ccdb6cb111a5f67e46064b4bfc9c4,
--      admin_ajustar_credito_disciplina = d9db84b7bfdd1bfcffee7fc804fc98a4,
--      admin_agregar_aparatos_socio = f9667e9b1f23f7d0acf51a785d66aaba.
--      Y T2 tiene que estar aplicada: fecha_plan_socio y ultimo_dia_plan con su huella de T2.
--   2) Los permisos (proacl) de las 3 tienen que quedar EXACTAMENTE iguales, anon incluido
--      (revocarlo es otra tanda). create or replace los conserva; por eso NO hay ningún grant.
--
-- Prueba: prueba_t3.sql (se corre DESPUÉS de esta migración: todo OK).
-- Rollback: rollback_t3.sql.
-- =====================================================================================

begin;

-- ── Guarda 1: se reemplaza exactamente la versión de producción conocida ──
do $guarda$
begin
  if md5(pg_get_functiondef('public.admin_fijar_creditos_disciplina(uuid, uuid, integer)'::regprocedure)) <> '874ccdb6cb111a5f67e46064b4bfc9c4' then
    raise exception 'T3: admin_fijar_creditos_disciplina no es la versión de producción (cambió su huella). No se aplicó nada.';
  end if;
  if md5(pg_get_functiondef('public.admin_ajustar_credito_disciplina(uuid, uuid, integer)'::regprocedure)) <> 'd9db84b7bfdd1bfcffee7fc804fc98a4' then
    raise exception 'T3: admin_ajustar_credito_disciplina no es la versión de producción (cambió su huella). No se aplicó nada.';
  end if;
  if md5(pg_get_functiondef('public.admin_agregar_aparatos_socio(uuid)'::regprocedure)) <> 'f9667e9b1f23f7d0acf51a785d66aaba' then
    raise exception 'T3: admin_agregar_aparatos_socio no es la versión de producción (cambió su huella). No se aplicó nada.';
  end if;
  if to_regprocedure('public.fecha_plan_socio(uuid)') is null
     or to_regprocedure('public.ultimo_dia_plan(timestamp with time zone)') is null
     or md5(regexp_replace(pg_get_functiondef('public.fecha_plan_socio(uuid)'::regprocedure), '\s+', '', 'g')) <> '7e82d5f0a2a13790b2bbfc64e765aac5'
     or md5(regexp_replace(pg_get_functiondef('public.ultimo_dia_plan(timestamp with time zone)'::regprocedure), '\s+', '', 'g')) <> '1682ea09613a4e9fd86f0101dca063a7' then
    raise exception 'T3: T2 no está aplicada (faltan o cambiaron fecha_plan_socio / ultimo_dia_plan). No se aplicó nada.';
  end if;
end;
$guarda$;

-- ── Guarda 2 (foto): permisos de antes ──
create temp table _t3_permisos_antes on commit drop as
select p.oid::regprocedure::text as funcion, coalesce(p.proacl::text, '(por defecto)') as permisos
from pg_proc p
where p.oid in ('public.admin_fijar_creditos_disciplina(uuid, uuid, integer)'::regprocedure,
                'public.admin_ajustar_credito_disciplina(uuid, uuid, integer)'::regprocedure,
                'public.admin_agregar_aparatos_socio(uuid)'::regprocedure);

-- ── admin_fijar_creditos_disciplina ──
CREATE OR REPLACE FUNCTION public.admin_fijar_creditos_disciplina(p_user_id uuid, p_discipline_id uuid, p_creditos integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_kind text;
  v_dni text;
  v_fecha_existente timestamptz;
  v_fecha_plan timestamptz;
  v_dia_plan date;
  v_nuevo_total_global int;
  v_socios_actualizados int := 0;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  if p_creditos is null or p_creditos < 0 then
    raise exception 'p_creditos inválido: % -- tiene que ser un entero mayor o igual a 0.', p_creditos;
  end if;

  select kind into v_kind from disciplines where id = p_discipline_id;
  if v_kind is null then
    raise exception 'La disciplina % no existe.', p_discipline_id;
  end if;
  if v_kind <> 'credits' then
    raise exception 'admin_fijar_creditos_disciplina() es solo para disciplinas de créditos -- % es de tipo %, no tiene lotes de créditos (Aparatos se edita por su fecha de vencimiento).', p_discipline_id, v_kind;
  end if;

  -- T3: serializa con un cobro, una reserva u otra edición del mismo socio en paralelo.
  perform 1 from user_credits where user_id = p_user_id for update;

  -- T3: la fecha del plan ANTES de tocar nada (antes se pedía después de poner en 0 y podía
  -- tomar un residuo de otra disciplina). Sin fecha vigente: now() + 30 días (regla E).
  v_fecha_existente := public.fecha_plan_socio(p_user_id);
  v_fecha_plan := coalesce(v_fecha_existente, now() + interval '30 days');
  v_dia_plan := public.ultimo_dia_plan(v_fecha_plan);

  update user_credits
  set remaining_credits = 0
  where user_id = p_user_id and discipline_id = p_discipline_id and remaining_credits > 0;

  -- T3 (D-T3a): en esta disciplina, los lotes en 0 de OTRO día que el plan se vencen (mismo SET
  -- que los cobros); si no, un reintegro al cancelar los revive con una 2ª fecha.
  update user_credits
  set expires_at = least(expires_at, now() - interval '1 day')
  where user_id = p_user_id
    and discipline_id = p_discipline_id
    and coalesce(remaining_credits, 0) <= 0
    and expires_at > now()
    and public.ultimo_dia_plan(expires_at) <> v_dia_plan;

  -- T3 (D-T3b): fijar en 0 no crea un lote en 0.
  if p_creditos > 0 then
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (p_user_id, p_discipline_id, p_creditos, v_fecha_plan);
  end if;

  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    select coalesce(sum(uc.remaining_credits), 0) into v_nuevo_total_global
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id
    where uc.user_id = p_user_id
      and d.kind = 'credits'
      and uc.remaining_credits > 0
      and uc.expires_at > now();

    -- T3 (D-T3c): si el plan nace acá, la ficha refleja su fecha; sin ficha, error.
    update socios
    set creditos = v_nuevo_total_global,
        fecha_vencimiento = case when v_fecha_existente is null and p_creditos > 0
                                 then public.ultimo_dia_plan(v_fecha_plan)
                                 else fecha_vencimiento end
    where dni = v_dni;
    get diagnostics v_socios_actualizados = row_count;
    if v_socios_actualizados = 0 then
      raise exception 'El socio tiene DNI % pero no hay ninguna ficha en Socios con ese DNI -- no se cambió nada.', v_dni;
    end if;
  end if;
end;
$function$;

-- ── admin_ajustar_credito_disciplina ──
CREATE OR REPLACE FUNCTION public.admin_ajustar_credito_disciplina(p_user_id uuid, p_discipline_id uuid, p_delta integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_kind text;
  v_nombre_disciplina text;
  v_dni text;
  v_fecha_existente timestamptz;
  v_fecha_plan timestamptz;
  v_dia_plan date;
  v_plan_nuevo boolean := false;
  v_lote_id uuid;
  v_restante int;
  v_lote record;
  v_descuento int;
  v_nuevo_total_global int;
  v_socios_actualizados int := 0;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select kind, name into v_kind, v_nombre_disciplina from disciplines where id = p_discipline_id;
  if v_kind is null then
    raise exception 'La disciplina % no existe.', p_discipline_id;
  end if;
  if v_kind <> 'credits' then
    raise exception 'admin_ajustar_credito_disciplina() es solo para disciplinas de créditos -- % es de tipo %, no tiene lotes de créditos (Aparatos se edita por su fecha de vencimiento).', p_discipline_id, v_kind;
  end if;

  if p_delta is null or p_delta = 0 then
    return;
  end if;

  -- T3: serializa con un cobro, una reserva u otra edición del mismo socio en paralelo.
  perform 1 from user_credits where user_id = p_user_id for update;

  if p_delta > 0 then
    -- T3: la fecha del plan ANTES de tocar nada. Sin fecha vigente: now() + 30 días (regla E).
    v_fecha_existente := public.fecha_plan_socio(p_user_id);
    v_fecha_plan := coalesce(v_fecha_existente, now() + interval '30 days');
    v_dia_plan := public.ultimo_dia_plan(v_fecha_plan);

    -- T3: primero el lote del plan de esta disciplina (mismo día en Argentina), aunque esté en 0.
    select id into v_lote_id
    from user_credits
    where user_id = p_user_id
      and discipline_id = p_discipline_id
      and expires_at > now()
      and public.ultimo_dia_plan(expires_at) = v_dia_plan
    order by (coalesce(remaining_credits, 0) > 0) desc, created_at desc, expires_at desc
    limit 1
    for update;

    if v_lote_id is not null then
      update user_credits set remaining_credits = coalesce(remaining_credits, 0) + p_delta where id = v_lote_id;
    else
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
      values (p_user_id, p_discipline_id, p_delta, v_fecha_plan);
      v_plan_nuevo := v_fecha_existente is null;
    end if;
  else
    v_restante := abs(p_delta);

    for v_lote in
      select id, remaining_credits
      from user_credits
      where user_id = p_user_id
        and discipline_id = p_discipline_id
        and remaining_credits > 0
        and expires_at > now()
      order by expires_at asc
      for update
    loop
      exit when v_restante <= 0;

      v_descuento := least(v_lote.remaining_credits, v_restante);
      update user_credits
      set remaining_credits = remaining_credits - v_descuento
      where id = v_lote.id;

      v_restante := v_restante - v_descuento;
    end loop;

    -- T3 (D-T3d): si no alcanzó, error (deshace lo descontado arriba).
    if v_restante > 0 then
      raise exception 'El socio no tiene % crédito(s) vigentes de % para descontar -- no se cambió nada.', abs(p_delta), v_nombre_disciplina;
    end if;
  end if;

  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    select coalesce(sum(uc.remaining_credits), 0) into v_nuevo_total_global
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id
    where uc.user_id = p_user_id
      and d.kind = 'credits'
      and uc.remaining_credits > 0
      and uc.expires_at > now();

    -- T3 (D-T3c): si el plan nace acá, la ficha refleja su fecha; sin ficha, error.
    update socios
    set creditos = v_nuevo_total_global,
        fecha_vencimiento = case when v_plan_nuevo
                                 then public.ultimo_dia_plan(v_fecha_plan)
                                 else fecha_vencimiento end
    where dni = v_dni;
    get diagnostics v_socios_actualizados = row_count;
    if v_socios_actualizados = 0 then
      raise exception 'El socio tiene DNI % pero no hay ninguna ficha en Socios con ese DNI -- no se cambió nada.', v_dni;
    end if;
  end if;
end;
$function$;

-- ── admin_agregar_aparatos_socio ──
CREATE OR REPLACE FUNCTION public.admin_agregar_aparatos_socio(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_dni text;
  v_membresias int;
  v_aparatos_discipline_id uuid;
  v_ya_vigente boolean;
  v_fecha_existente timestamptz;
  v_fecha_plan timestamptz;
  v_socios_actualizados int := 0;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  -- T3 (D-T3e): exactamente UNA disciplina de membresía (antes "limit 1" sin orden: con dos,
  -- la guarda y la fecha podían mirar disciplinas distintas).
  select count(*) into v_membresias from disciplines where kind = 'membership';
  if v_membresias = 0 then
    raise exception 'No hay ninguna disciplina de tipo membresía (Aparatos) en el catálogo.';
  end if;
  if v_membresias > 1 then
    raise exception 'Hay % disciplinas de tipo membresía en el catálogo y tiene que haber una sola (Aparatos) -- revisalo en Configuración. No se cambió nada.', v_membresias;
  end if;
  select id into v_aparatos_discipline_id from disciplines where kind = 'membership';

  -- T3: serializa con un cobro, una reserva u otra edición del mismo socio en paralelo.
  perform 1 from user_credits where user_id = p_user_id for update;

  -- Guarda -- no tiene sentido "agregar" algo que ya está vigente; para
  -- cambiarle la fecha existe "Registrar Pago"/"Cobrar", no este atajo.
  select exists(
    select 1 from user_credits
    where user_id = p_user_id
      and discipline_id = v_aparatos_discipline_id
      and expires_at > now()
  ) into v_ya_vigente;
  if v_ya_vigente then
    raise exception 'El socio ya tiene Aparatos vigente -- no hay nada que agregar.';
  end if;

  -- T3 (D3): la fecha del plan, explícita y antes de escribir nada: la del plan vigente del
  -- socio (fecha_plan_socio) o, si no tiene fecha vigente, now() + 30 días (regla E).
  v_fecha_existente := public.fecha_plan_socio(p_user_id);
  v_fecha_plan := coalesce(v_fecha_existente, now() + interval '30 days');

  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
  values (p_user_id, v_aparatos_discipline_id, null, v_fecha_plan);

  -- Espejo en socios.fecha_vencimiento -- el día del plan en Argentina.
  -- T3 (D-T3c): sin ficha, error.
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    update socios
    set fecha_vencimiento = public.ultimo_dia_plan(v_fecha_plan)
    where dni = v_dni;
    get diagnostics v_socios_actualizados = row_count;
    if v_socios_actualizados = 0 then
      raise exception 'El socio tiene DNI % pero no hay ninguna ficha en Socios con ese DNI -- no se cambió nada.', v_dni;
    end if;
  end if;
end;
$function$;

-- ── Guarda 2 (chequeo): mismos permisos que antes, anon incluido ──
do $chequeo$
declare
  v_cambiados text;
begin
  select string_agg(a.funcion || ': antes ' || a.permisos || ' / ahora ' || coalesce(p.proacl::text, '(por defecto)'), ' | ')
    into v_cambiados
  from _t3_permisos_antes a
  join pg_proc p on p.oid = a.funcion::regprocedure
  where coalesce(p.proacl::text, '(por defecto)') <> a.permisos;
  if v_cambiados is not null then
    raise exception 'T3: cambiaron los permisos (%). No se aplicó nada.', v_cambiados;
  end if;
  if (select count(*) from _t3_permisos_antes) <> 3 then
    raise exception 'T3: no se pudo sacar la foto de permisos de las 3 funciones. No se aplicó nada.';
  end if;
end;
$chequeo$;

commit;

-- Verificación (solo lectura), después del commit:
-- select p.oid::regprocedure, md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', '', 'g')) as huella_sin_espacios,
--        coalesce(p.proacl::text, '(por defecto)') as permisos
-- from pg_proc p
-- where p.oid in ('public.admin_fijar_creditos_disciplina(uuid, uuid, integer)'::regprocedure,
--                 'public.admin_ajustar_credito_disciplina(uuid, uuid, integer)'::regprocedure,
--                 'public.admin_agregar_aparatos_socio(uuid)'::regprocedure);
-- -- esperado (huella_sin_espacios):
-- --   admin_fijar_creditos_disciplina   = 32fa31b3ba16f674faf42f68f14fc3e2
-- --   admin_ajustar_credito_disciplina  = a34f0d9b63aed24d3a67747ed89f88cb
-- --   admin_agregar_aparatos_socio      = c93d54418f8ca3e3ac82f7925278b3c6
-- -- y permisos = {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
