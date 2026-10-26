-- =====================================================================================
-- ROLLBACK de supabase_migration_t3_fecha_plan_editor_creditos.sql. NO SE CORRIÓ.
--
-- Vuelve las 3 funciones a sus definiciones EXACTAS de producción, sacadas de la exportación
-- del 23/10 (funciones_user_credits_produccion_23-10.txt), que coincide con las huellas de
-- producción de antes de T3: admin_fijar_creditos_disciplina, admin_ajustar_credito_disciplina y
-- admin_agregar_aparatos_socio. Solo funciones: ningún UPDATE/DELETE/INSERT de datos. Las filas
-- que T3 movió (lotes nuevos con la fecha del plan, residuos en 0 vencidos, fichas con la fecha
-- de un plan nuevo) se quedan como están.
--
-- La exportación (tabla de Supabase) no conserva los espacios byte a byte, así que el md5
-- exacto puede no volver a ser 874c…/d9db…/f966…; se verifica con la huella SIN espacios, que
-- sí tiene que coincidir con la de producción (b27d…/6625…/f155…).
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) ANTES: las 3 funciones tienen que ser la versión T3 (huella sin espacios). Si alguien las
--      cambió después de T3, se frena: no se pisa un cambio que no conocemos.
--   2) DESPUÉS: huella sin espacios = la de producción, y permisos EXACTAMENTE iguales
--      (anon incluido). create or replace los conserva; por eso NO hay ningún grant.
-- =====================================================================================

begin;

do $guarda$
begin
  if md5(regexp_replace(pg_get_functiondef('public.admin_fijar_creditos_disciplina(uuid, uuid, integer)'::regprocedure), '\s+', '', 'g')) <> '32fa31b3ba16f674faf42f68f14fc3e2' then
    raise exception 'Rollback T3: admin_fijar_creditos_disciplina no es la versión T3 (cambió su huella). No se aplicó nada.';
  end if;
  if md5(regexp_replace(pg_get_functiondef('public.admin_ajustar_credito_disciplina(uuid, uuid, integer)'::regprocedure), '\s+', '', 'g')) <> 'a34f0d9b63aed24d3a67747ed89f88cb' then
    raise exception 'Rollback T3: admin_ajustar_credito_disciplina no es la versión T3 (cambió su huella). No se aplicó nada.';
  end if;
  if md5(regexp_replace(pg_get_functiondef('public.admin_agregar_aparatos_socio(uuid)'::regprocedure), '\s+', '', 'g')) <> 'c93d54418f8ca3e3ac82f7925278b3c6' then
    raise exception 'Rollback T3: admin_agregar_aparatos_socio no es la versión T3 (cambió su huella). No se aplicó nada.';
  end if;
end;
$guarda$;

create temp table _t3_rb_permisos_antes on commit drop as
select p.oid::regprocedure::text as funcion, coalesce(p.proacl::text, '(por defecto)') as permisos
from pg_proc p
where p.oid in ('public.admin_fijar_creditos_disciplina(uuid, uuid, integer)'::regprocedure,
                'public.admin_ajustar_credito_disciplina(uuid, uuid, integer)'::regprocedure,
                'public.admin_agregar_aparatos_socio(uuid)'::regprocedure);

-- ── admin_fijar_creditos_disciplina (producción 23/10) ──
CREATE OR REPLACE FUNCTION public.admin_fijar_creditos_disciplina(p_user_id uuid, p_discipline_id uuid, p_creditos integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_kind text;
  v_dni text;
  v_fecha_plan timestamptz;
  v_nuevo_total_global int;
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

  update user_credits
  set remaining_credits = 0
  where user_id = p_user_id and discipline_id = p_discipline_id and remaining_credits > 0;

  v_fecha_plan := public.resolver_fecha_plan_actual(p_user_id);

  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
  values (p_user_id, p_discipline_id, p_creditos, v_fecha_plan);

  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    select coalesce(sum(uc.remaining_credits), 0) into v_nuevo_total_global
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id
    where uc.user_id = p_user_id
      and d.kind = 'credits'
      and uc.remaining_credits > 0
      and uc.expires_at > now();

    update socios set creditos = v_nuevo_total_global where dni = v_dni;
  end if;
end;
$function$;


-- ── admin_ajustar_credito_disciplina (producción 23/10) ──
CREATE OR REPLACE FUNCTION public.admin_ajustar_credito_disciplina(p_user_id uuid, p_discipline_id uuid, p_delta integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_kind text;
  v_dni text;
  v_fecha_plan timestamptz;
  v_lote_id uuid;
  v_restante int;
  v_lote record;
  v_descuento int;
  v_nuevo_total_global int;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select kind into v_kind from disciplines where id = p_discipline_id;
  if v_kind is null then
    raise exception 'La disciplina % no existe.', p_discipline_id;
  end if;
  if v_kind <> 'credits' then
    raise exception 'admin_ajustar_credito_disciplina() es solo para disciplinas de créditos -- % es de tipo %, no tiene lotes de créditos (Aparatos se edita por su fecha de vencimiento).', p_discipline_id, v_kind;
  end if;

  if p_delta is null or p_delta = 0 then
    return;
  end if;

  if p_delta > 0 then
    select id into v_lote_id
    from user_credits
    where user_id = p_user_id
      and discipline_id = p_discipline_id
      and remaining_credits > 0
      and expires_at > now()
    order by expires_at desc
    limit 1
    for update;

    if v_lote_id is not null then
      update user_credits set remaining_credits = remaining_credits + p_delta where id = v_lote_id;
    else
      v_fecha_plan := public.resolver_fecha_plan_actual(p_user_id);
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
      values (p_user_id, p_discipline_id, p_delta, v_fecha_plan);
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

    update socios set creditos = v_nuevo_total_global where dni = v_dni;
  end if;
end;
$function$;


-- ── admin_agregar_aparatos_socio (producción 23/10) ──
CREATE OR REPLACE FUNCTION public.admin_agregar_aparatos_socio(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_dni text;
  v_aparatos_discipline_id uuid;
  v_ya_vigente boolean;
  v_fecha_plan timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select id into v_aparatos_discipline_id from disciplines where kind = 'membership' limit 1;
  if v_aparatos_discipline_id is null then
    raise exception 'No hay ninguna disciplina de tipo membresía (Aparatos) en el catálogo.';
  end if;

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

  -- "Un solo plan activo" -- misma fecha que el resto del plan del socio
  -- (créditos activos + Aparatos, si tuviera otra fila residual futura),
  -- o now()+30 días si no tiene nada activo todavía.
  v_fecha_plan := public.resolver_fecha_plan_actual(p_user_id);

  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
  values (p_user_id, v_aparatos_discipline_id, null, v_fecha_plan);

  -- Espejo en socios.fecha_vencimiento -- mismo criterio de conversión de
  -- huso horario que ya usa admin_quitar_disciplina_socio() para lo mismo.
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    update socios
    set fecha_vencimiento = (v_fecha_plan at time zone 'America/Argentina/Mendoza')::date
    where dni = v_dni;
  end if;
end;
$function$;


do $verificacion$
declare
  v_cambiados text;
begin
  if md5(regexp_replace(pg_get_functiondef('public.admin_fijar_creditos_disciplina(uuid, uuid, integer)'::regprocedure), '\s+', '', 'g')) <> 'b27da12c50d1a05293dfc110f7fe72bc' then
    raise exception 'Rollback T3: admin_fijar_creditos_disciplina no quedó igual a la de producción. No se aplicó nada.';
  end if;
  if md5(regexp_replace(pg_get_functiondef('public.admin_ajustar_credito_disciplina(uuid, uuid, integer)'::regprocedure), '\s+', '', 'g')) <> '6625be5396fed275a8e00301e7997baa' then
    raise exception 'Rollback T3: admin_ajustar_credito_disciplina no quedó igual a la de producción. No se aplicó nada.';
  end if;
  if md5(regexp_replace(pg_get_functiondef('public.admin_agregar_aparatos_socio(uuid)'::regprocedure), '\s+', '', 'g')) <> 'f155af04b7391f4690b6240c5935baa8' then
    raise exception 'Rollback T3: admin_agregar_aparatos_socio no quedó igual a la de producción. No se aplicó nada.';
  end if;
  select string_agg(a.funcion, ', ') into v_cambiados
  from _t3_rb_permisos_antes a
  join pg_proc p on p.oid = a.funcion::regprocedure
  where coalesce(p.proacl::text, '(por defecto)') <> a.permisos;
  if v_cambiados is not null then
    raise exception 'Rollback T3: cambiaron los permisos de %. No se aplicó nada.', v_cambiados;
  end if;
end;
$verificacion$;

commit;
