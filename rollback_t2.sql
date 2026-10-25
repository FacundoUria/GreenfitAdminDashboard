-- =====================================================================================
-- ROLLBACK de supabase_migration_t2_fecha_plan_editar_fecha.sql. NO SE CORRIÓ.
--
-- Vuelve las 3 funciones reemplazadas a sus definiciones EXACTAS de producción:
--   resolver_fecha_plan_actual y admin_editar_fecha_vencimiento_socio: exportación del 23/10
--     (funciones_user_credits_produccion_23-10.txt);
--   admin_acreditar_creditos_manual: versión T1 (supabase_migration_t1_r2_lotes_en_cero.sql).
-- Y borra las 2 funciones nuevas (ultimo_dia_plan, fecha_plan_socio) DESPUÉS de que ya nadie
-- las llama. Solo funciones: ningún UPDATE/DELETE/INSERT de datos. Las filas que T2 movió
-- (ediciones de fecha, cobros con fecha a fin del día) se quedan como están.
--
-- La exportación (tabla de Supabase) no conserva los espacios byte a byte, así que el md5
-- exacto puede no volver a ser 5ec7…/a357…; se verifica con la huella SIN espacios, que sí
-- tiene que coincidir con la de la exportación (y con la de T1 para el cobro). Si no coincide,
-- si cambian los permisos o si las funciones nuevas siguen existiendo, no se aplica nada.
-- =====================================================================================

begin;

create temp table _t2_rb_permisos_antes on commit drop as
select p.oid::regprocedure::text as funcion, coalesce(p.proacl::text, '(por defecto)') as permisos
from pg_proc p
where p.oid in ('public.resolver_fecha_plan_actual(uuid)'::regprocedure,
                'public.admin_editar_fecha_vencimiento_socio(uuid, date)'::regprocedure,
                'public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure);

-- ── resolver_fecha_plan_actual (producción 23/10) ──
CREATE OR REPLACE FUNCTION public.resolver_fecha_plan_actual(p_user_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
declare
  v_fecha timestamptz;
begin
  select max(expires_at) into v_fecha
  from (
    select uc.expires_at
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id and d.kind = 'credits'
    where uc.user_id = p_user_id and uc.remaining_credits > 0 and uc.expires_at > now()

    union all

    select uc.expires_at
    from user_credits uc
    join disciplines d on d.id = uc.discipline_id and d.kind = 'membership'
    where uc.user_id = p_user_id and uc.expires_at > now()
  ) activas;

  return coalesce(v_fecha, now() + interval '30 days');
end;
$function$;

-- ── admin_editar_fecha_vencimiento_socio (producción 23/10) ──
CREATE OR REPLACE FUNCTION public.admin_editar_fecha_vencimiento_socio(p_user_id uuid, p_nueva_fecha date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_dni text;
  v_tiene_algo_activo boolean;
  v_nueva_fecha_ts timestamptz;
  v_filas_actualizadas int := 0;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select exists(
    select 1 from user_credits uc
    join disciplines d on d.id = uc.discipline_id
    where uc.user_id = p_user_id
      and (
        (d.kind = 'credits' and uc.remaining_credits > 0 and uc.expires_at > now())
        or (d.kind = 'membership' and uc.expires_at > now())
      )
  ) into v_tiene_algo_activo;

  if not v_tiene_algo_activo then
    raise exception 'Este socio no tiene ningún plan activo -- para asignarle una fecha nueva, hay que usar Cobrar, no editar la fecha.';
  end if;

  v_nueva_fecha_ts := (p_nueva_fecha::text)::timestamp
    at time zone 'America/Argentina/Mendoza';

  update user_credits uc
  set expires_at = v_nueva_fecha_ts
  from disciplines d
  where uc.discipline_id = d.id
    and uc.user_id = p_user_id
    and (
      (d.kind = 'credits' and uc.remaining_credits > 0 and uc.expires_at > now())
      or (d.kind = 'membership' and uc.expires_at > now())
    );

  get diagnostics v_filas_actualizadas = row_count;

  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    update socios set fecha_vencimiento = p_nueva_fecha where dni = v_dni;
  end if;

  return v_filas_actualizadas;
end;
$function$;

-- ── admin_acreditar_creditos_manual (versión T1, producción) ──
CREATE OR REPLACE FUNCTION public.admin_acreditar_creditos_manual(p_user_id uuid, p_creditos jsonb, p_incluye_aparatos boolean DEFAULT false, p_dias_vigencia integer DEFAULT 30, p_fecha_inicio date DEFAULT NULL::date)
 RETURNS TABLE(creditos_otorgados integer, aparatos_extendido boolean, nueva_fecha_vencimiento_aparatos date, creditos_lotes jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_aparatos_discipline_id uuid;
  v_credito jsonb;
  v_discipline_id uuid;
  v_credits int;
  v_kind text;
  v_discipline_ids_vistos uuid[] := '{}';
  v_total_creditos int := 0;
  v_dni text;
  v_fecha_plan_nuevo timestamptz;
  v_fecha_aparatos_actual timestamptz;
  v_aparatos_extendido boolean := false;
  v_lote_id uuid;
  v_creditos_lotes jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  if p_dias_vigencia is null or p_dias_vigencia <= 0 then
    raise exception 'p_dias_vigencia inválido: % -- tiene que ser un entero mayor a 0.', p_dias_vigencia;
  end if;

  -- Guarda propia de este contexto (acreditar_pack no la necesita -- un
  -- pack siempre trae algo por definición, ya validado al crearlo en
  -- Configuración). Acá, con cantidades tipeadas a mano, es perfectamente
  -- posible mandar el formulario vacío sin querer -- sin esto, el reseteo
  -- de abajo igual se aplicaría completo y el socio se queda sin nada a
  -- cambio.
  if coalesce(jsonb_array_length(p_creditos), 0) = 0 and not p_incluye_aparatos then
    raise exception 'No se especificó ningún crédito ni Aparatos para acreditar -- no se resetea el plan del socio sin darle algo a cambio.';
  end if;

  -- "Un solo plan activo" -- misma UNA fecha para todo lo que esto
  -- acredita (créditos Y Aparatos si corresponde), igual que
  -- acreditar_pack(). Ver la nota del header sobre p_fecha_inicio.
  v_fecha_plan_nuevo := (case
    when p_fecha_inicio is null then now()
    else (p_fecha_inicio::timestamp at time zone 'America/Argentina/Mendoza')
  end) + (p_dias_vigencia || ' days')::interval;

  -- Se resuelve SIEMPRE (no solo si p_incluye_aparatos) -- hace falta para
  -- poder apagar un Aparatos vigente aunque esta carga no lo traiga. Mismo
  -- criterio que acreditar_pack().
  select id into v_aparatos_discipline_id from disciplines where kind = 'membership' limit 1;

  -- ============================================================
  -- RESETEO -- idéntico a acreditar_pack(): todo lo que el socio tenía
  -- activo se apaga ANTES de acreditar lo nuevo. Si algo falla más abajo
  -- (carga malformada en el loop), la transacción entera se revierte --
  -- este reseteo nunca queda aplicado a mitad de camino sin la
  -- acreditación nueva.
  -- ============================================================

  -- expires_at al pasado, igual que Aparatos abajo: una fila en 0 NO puede quedar
  -- con fecha futura -- cancel_booking()/admin_cancel_booking() reintegran a un lote
  -- con `expires_at > now()`, y una fila muerta con la fecha del plan anterior se
  -- reactivaba como 2ª fecha activa. least(): las filas que ya venían vencidas
  -- conservan su fecha real, no se "adelantan" a ayer.
  -- T1 (R2): un pago invalida TODOS los créditos anteriores del socio. Además de los
  -- lotes con saldo (como siempre), se vencen también los lotes en 0 que todavía tenían
  -- fecha futura: si no, un +1 al cancelar los "revivía" con la fecha del plan viejo.
  -- Nada más cambia: los lotes con saldo se ponen en 0 como siempre, y least() deja a los
  -- que ya estaban vencidos con su fecha real.
  update user_credits
  set remaining_credits = 0,
      expires_at = least(expires_at, now() - interval '1 day')
  where user_id = p_user_id
    and (remaining_credits > 0 or expires_at > now())
    and discipline_id in (select id from disciplines where kind = 'credits');

  -- now() - interval '1 day', no now() -- mismo fix ya aplicado en
  -- acreditar_pack() (ver esa migración para el detalle): con now() a
  -- secas, un chequeo por DÍA completo (esta_habilitado_para_disciplina,
  -- fecha_vencimiento >= current_date) seguía leyendo "vigente" hasta la
  -- medianoche del día del reseteo, sin importar a qué hora se ejecutó.
  if v_aparatos_discipline_id is not null then
    update user_credits
    set expires_at = now() - interval '1 day'
    where user_id = p_user_id
      and discipline_id = v_aparatos_discipline_id
      and expires_at > now();
  end if;

  -- ============================================================
  -- ACREDITACIÓN -- solo lo que trae ESTA carga. Mismas guardas que
  -- acreditar_pack() (discipline_id/credits inválidos, disciplina
  -- repetida) MÁS una adaptada a este contexto: a diferencia de un pack
  -- (packs.creditos, ya validado al crearlo en Configuración), acá
  -- discipline_id viene de lo que Seba tipeó/eligió a mano -- se valida
  -- que exista y sea de créditos ANTES de insertar, en vez de dejar que
  -- una FK inválida explote con un error crudo de Postgres.
  -- ============================================================
  for v_credito in select * from jsonb_array_elements(coalesce(p_creditos, '[]'::jsonb))
  loop
    v_discipline_id := (v_credito->>'discipline_id')::uuid;
    v_credits := (v_credito->>'credits')::int;

    if v_discipline_id is null then
      raise exception 'Hay una entrada de créditos sin discipline_id válido: %', v_credito;
    end if;
    if v_credits is null or v_credits <= 0 then
      raise exception 'Cantidad de créditos inválida para la disciplina % (credits=%)', v_discipline_id, v_credito->>'credits';
    end if;
    if v_discipline_id = any(v_discipline_ids_vistos) then
      raise exception 'La disciplina % está repetida más de una vez en la carga -- corregí los valores antes de acreditar.', v_discipline_id;
    end if;

    select kind into v_kind from disciplines where id = v_discipline_id;
    if v_kind is null then
      raise exception 'La disciplina % no existe.', v_discipline_id;
    end if;
    if v_kind <> 'credits' then
      raise exception 'La disciplina % (%) no es de créditos -- Aparatos se acredita con p_incluye_aparatos, no en esta lista.', v_discipline_id, v_kind;
    end if;

    v_discipline_ids_vistos := array_append(v_discipline_ids_vistos, v_discipline_id);

    -- Sin pack_id (no hay ningún pack real detrás de esto) -- mismo
    -- criterio que ya usan admin_fijar_creditos_disciplina/
    -- admin_ajustar_credito_disciplina para sus propias inserciones
    -- manuales.
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (p_user_id, v_discipline_id, v_credits, v_fecha_plan_nuevo)
    returning id into v_lote_id;

    v_total_creditos := v_total_creditos + v_credits;
    v_creditos_lotes := v_creditos_lotes || jsonb_build_array(
      jsonb_build_object('discipline_id', v_discipline_id, 'credits_otorgados', v_credits, 'lote_id', v_lote_id)
    );
  end loop;

  -- Aparatos, si esta carga lo incluye -- MISMA fecha que los créditos de
  -- esta carga (plan único), plana. Sin carryover de la vigencia
  -- anterior -- se acaba de apagar arriba, sin importar cuál era.
  if p_incluye_aparatos and v_aparatos_discipline_id is not null then
    insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
    values (p_user_id, v_aparatos_discipline_id, null, v_fecha_plan_nuevo);

    v_aparatos_extendido := true;
  end if;

  -- Estado REAL de Aparatos después del reseteo -- mismo criterio que
  -- acreditar_pack(): la fila más reciente (la nueva si se incluyó, o la
  -- que se acaba de apagar arriba si no) -- null si el socio nunca tuvo
  -- Aparatos.
  if v_aparatos_discipline_id is not null then
    select expires_at into v_fecha_aparatos_actual
    from user_credits
    where user_id = p_user_id and discipline_id = v_aparatos_discipline_id
    order by created_at desc
    limit 1;
  end if;

  -- Espejo en socios -- recalculado desde cero, mismo criterio que
  -- acreditar_pack().
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    update socios
    set creditos = v_total_creditos,
        fecha_vencimiento = coalesce(
          (v_fecha_aparatos_actual at time zone 'America/Argentina/Mendoza')::date,
          fecha_vencimiento
        )
    where dni = v_dni;
  end if;

  return query select
    v_total_creditos,
    v_aparatos_extendido,
    (v_fecha_aparatos_actual at time zone 'America/Argentina/Mendoza')::date,
    v_creditos_lotes;
end;
$function$;

-- ── Las 2 funciones nuevas de T2 (ya nadie las llama) ──
drop function if exists public.fecha_plan_socio(uuid);
drop function if exists public.ultimo_dia_plan(timestamp with time zone);

do $verificacion$
declare
  v_cambiados text;
begin
  if md5(regexp_replace(pg_get_functiondef('public.resolver_fecha_plan_actual(uuid)'::regprocedure), '\s+', '', 'g')) <> '6652a5845e239d431feb4967c62b03db' then
    raise exception 'Rollback T2: resolver_fecha_plan_actual no quedó igual a la exportación. No se aplicó nada.';
  end if;
  if md5(regexp_replace(pg_get_functiondef('public.admin_editar_fecha_vencimiento_socio(uuid, date)'::regprocedure), '\s+', '', 'g')) <> '3f7abf390d14dec7d0b9b0b5003e512d' then
    raise exception 'Rollback T2: admin_editar_fecha_vencimiento_socio no quedó igual a la exportación. No se aplicó nada.';
  end if;
  if md5(regexp_replace(pg_get_functiondef('public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure), '\s+', '', 'g')) <> '5bcbf2fa81211071a671ac503e38fd79' then
    raise exception 'Rollback T2: admin_acreditar_creditos_manual no quedó igual a la versión T1. No se aplicó nada.';
  end if;
  if to_regprocedure('public.fecha_plan_socio(uuid)') is not null
     or to_regprocedure('public.ultimo_dia_plan(timestamp with time zone)') is not null then
    raise exception 'Rollback T2: las funciones nuevas siguen existiendo. No se aplicó nada.';
  end if;
  select string_agg(a.funcion, ', ') into v_cambiados
  from _t2_rb_permisos_antes a
  join pg_proc p on p.oid = a.funcion::regprocedure
  where coalesce(p.proacl::text, '(por defecto)') <> a.permisos;
  if v_cambiados is not null then
    raise exception 'Rollback T2: cambiaron los permisos de %. No se aplicó nada.', v_cambiados;
  end if;
end;
$verificacion$;

commit;
