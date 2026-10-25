-- =====================================================================================
-- T2 -- fecha del plan + editar fecha + cobro con fecha. NO SE CORRIÓ TODAVÍA.
-- ESTAMOS EN PRODUCCIÓN.
--
-- ORDEN DE DESPLIEGUE OBLIGATORIO: (1) PWA con el arreglo de membershipStatus.ts,
-- (2) ESTA migración, (3) Admin.
--
-- Regla D: la fecha que elige Seba se usa el día ENTERO. El corte se guarda como el FIN de
-- ese día en hora Argentina: ((fecha + 1)::timestamp at time zone 'America/Argentina/Mendoza')
-- - interval '1 microsecond'. Así la fecha calendario de expires_at en Argentina sigue siendo el
-- último día de uso: nada cambia en cómo se muestra (los lotes que ya vencen a las 00:00 se
-- siguen viendo igual) ni en los avisos del servidor.
--
-- Qué hace:
--   1) ultimo_dia_plan(ts) -- NUEVA, interna: (ts at time zone AR)::date.
--   2) fecha_plan_socio(user) -- NUEVA, interna, solo lectura: la fecha del plan del socio.
--        - Con saldo o Aparatos vigente: la más lejana entre los lotes con saldo vigentes y
--          las filas de Aparatos vigentes.
--        - Todo en 0 pero con filas vigentes por fecha: la de la fila vigente con el
--          created_at más reciente (empate: la más lejana).
--        - Nada: null.
--   3) resolver_fecha_plan_actual -- misma firma y misma respuesta:
--      coalesce(fecha_plan_socio(...), now() + 30 días).
--   4) admin_editar_fecha_vencimiento_socio -- misma firma:
--        - rechaza fechas anteriores a hoy y a más de 1 año desde hoy (error claro);
--        - vence los lotes en 0 de OTRA fecha (least(expires_at, now() - 1 día));
--        - mueve al fin del día elegido: Aparatos, los lotes con saldo (de cualquier fecha) y
--          los lotes en 0 del plan (mismo día en Argentina que la fecha del plan);
--        - si el socio tiene DNI y no hay ficha en socios con ese DNI: error, no cambia nada.
--   5) admin_acreditar_creditos_manual -- misma firma. Parte de la versión de T1 (la de
--      producción). Cambia UNA sola cosa: con p_fecha_inicio, el corte es el fin del día
--      p_fecha_inicio + p_dias_vigencia (antes: las 00:00 de ese día, el socio lo perdía). Sin
--      p_fecha_inicio, igual que antes (now() + días). El espejo en socios y el valor devuelto
--      siguen dando el día elegido.
--
-- Solo crea o reemplaza funciones. Ningún UPDATE/DELETE/INSERT sobre datos existentes. La
-- tabla temporal de abajo es solo para comparar los permisos antes/después y se borra sola al
-- terminar la transacción.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) Las huellas actuales (md5 exacto de pg_get_functiondef) tienen que ser las de producción:
--      resolver_fecha_plan_actual = 5ec7f80e79602ede7ce2f3b0fdc784ad,
--      admin_editar_fecha_vencimiento_socio = a357c408982861c8bf9ed64d9fe039ad,
--      admin_acreditar_creditos_manual = 1d97db9da2d20530bf3cbd808bc155ea (versión T1).
--   2) Los permisos (proacl) de las 3 que se reemplazan tienen que quedar EXACTAMENTE iguales.
--      create or replace los conserva; por eso NO hay ningún grant para ellas.
--   3) Las 2 funciones nuevas: sin EXECUTE para public, anon ni authenticated.
--
-- Prueba: prueba_t2.sql (se corre DESPUÉS de esta migración: todo OK).
-- Rollback: rollback_t2.sql.
-- =====================================================================================

begin;

-- ── Guarda 1: se reemplaza exactamente la versión de producción conocida ──
do $guarda$
begin
  if md5(pg_get_functiondef('public.resolver_fecha_plan_actual(uuid)'::regprocedure)) <> '5ec7f80e79602ede7ce2f3b0fdc784ad' then
    raise exception 'T2: resolver_fecha_plan_actual no es la versión de producción (cambió su huella). No se aplicó nada.';
  end if;
  if md5(pg_get_functiondef('public.admin_editar_fecha_vencimiento_socio(uuid, date)'::regprocedure)) <> 'a357c408982861c8bf9ed64d9fe039ad' then
    raise exception 'T2: admin_editar_fecha_vencimiento_socio no es la versión de producción (cambió su huella). No se aplicó nada.';
  end if;
  if md5(pg_get_functiondef('public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure)) <> '1d97db9da2d20530bf3cbd808bc155ea' then
    raise exception 'T2: admin_acreditar_creditos_manual no es la versión de T1 (cambió su huella). No se aplicó nada.';
  end if;
end;
$guarda$;

-- ── Guarda 2 (foto): permisos de antes ──
create temp table _t2_permisos_antes on commit drop as
select p.oid::regprocedure::text as funcion, coalesce(p.proacl::text, '(por defecto)') as permisos
from pg_proc p
where p.oid in ('public.resolver_fecha_plan_actual(uuid)'::regprocedure,
                'public.admin_editar_fecha_vencimiento_socio(uuid, date)'::regprocedure,
                'public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure);

-- ── ultimo_dia_plan (NUEVA) ──
CREATE OR REPLACE FUNCTION public.ultimo_dia_plan(p_ts timestamp with time zone)
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Último día de uso de una fecha de vencimiento: su fecha calendario en Argentina.
  -- Vale igual para un corte a fin del día (regla D), para un pago con hora (now() + 30
  -- días) y para los lotes viejos a las 00:00.
  select (p_ts at time zone 'America/Argentina/Mendoza')::date;
$function$;

revoke all on function public.ultimo_dia_plan(timestamp with time zone) from public, anon, authenticated;

-- ── fecha_plan_socio (NUEVA) ──
-- security invoker a propósito: solo la llaman funciones SECURITY DEFINER (corre como el
-- dueño); si alguna vez quedara expuesta, no se saltearía el RLS.
CREATE OR REPLACE FUNCTION public.fecha_plan_socio(p_user_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    -- Con saldo o Aparatos vigente: la más lejana entre lo que el socio puede usar.
    (
      select max(uc.expires_at)
      from user_credits uc
      join disciplines d on d.id = uc.discipline_id
      where uc.user_id = p_user_id
        and uc.expires_at > now()
        and (
          (d.kind = 'credits' and uc.remaining_credits > 0)
          or d.kind = 'membership'
        )
    ),
    -- Todo en 0 pero el plan sigue corriendo por fecha: la fila vigente más reciente
    -- (empate: la más lejana).
    (
      select uc.expires_at
      from user_credits uc
      join disciplines d on d.id = uc.discipline_id and d.kind = 'credits'
      where uc.user_id = p_user_id
        and uc.expires_at > now()
      order by uc.created_at desc, uc.expires_at desc
      limit 1
    )
  );
$function$;

revoke all on function public.fecha_plan_socio(uuid) from public, anon, authenticated;

-- ── resolver_fecha_plan_actual ──
CREATE OR REPLACE FUNCTION public.resolver_fecha_plan_actual(p_user_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
begin
  -- T2: la fecha del plan sale de fecha_plan_socio() (incluye el caso "todo en 0 pero el
  -- plan sigue corriendo", que antes caía a now() + 30 días y abría una 2ª fecha).
  return coalesce(public.fecha_plan_socio(p_user_id), now() + interval '30 days');
end;
$function$;

-- ── admin_editar_fecha_vencimiento_socio ──
CREATE OR REPLACE FUNCTION public.admin_editar_fecha_vencimiento_socio(p_user_id uuid, p_nueva_fecha date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_tope date;
  v_dni text;
  v_tiene_algo_activo boolean;
  v_dia_plan date;
  v_corte timestamptz;
  v_filas_actualizadas int := 0;
  v_socios_actualizados int := 0;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  if p_nueva_fecha is null then
    raise exception 'Elegí una fecha.';
  end if;

  -- Regla D: nunca antes de hoy. Tope: 1 año desde hoy (frena un error de tipeo).
  v_tope := (v_hoy + interval '1 year')::date;
  if p_nueva_fecha < v_hoy then
    raise exception 'No se puede poner un vencimiento anterior a hoy (%).', to_char(v_hoy, 'DD/MM/YYYY');
  end if;
  if p_nueva_fecha > v_tope then
    raise exception 'El vencimiento no puede pasar de un año desde hoy (%). Revisá la fecha.', to_char(v_tope, 'DD/MM/YYYY');
  end if;

  -- Serializa con un cobro o una reserva del mismo socio en paralelo.
  perform 1 from user_credits where user_id = p_user_id for update;

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

  -- Día del plan ANTES de mover nada (decide qué lotes en 0 son del plan).
  v_dia_plan := public.ultimo_dia_plan(public.fecha_plan_socio(p_user_id));

  -- Regla D: el día elegido se usa entero -- el corte es su último microsegundo.
  v_corte := ((p_nueva_fecha + 1)::timestamp at time zone c_zona) - interval '1 microsecond';

  -- 1) PRIMERO se vencen los lotes en 0 de OTRA fecha (si se movieran antes, los del plan
  --    ya tendrían otra fecha y se vencerían por error). least(): igual que los cobros.
  update user_credits uc
  set expires_at = least(uc.expires_at, now() - interval '1 day')
  from disciplines d
  where uc.discipline_id = d.id
    and uc.user_id = p_user_id
    and d.kind = 'credits'
    and coalesce(uc.remaining_credits, 0) <= 0
    and uc.expires_at > now()
    and public.ultimo_dia_plan(uc.expires_at) <> v_dia_plan;

  -- 2) DESPUÉS se mueve al corte todo lo vigente que queda: Aparatos, los lotes con saldo
  --    (de cualquier fecha) y los lotes en 0 del plan (mismo día en Argentina).
  update user_credits uc
  set expires_at = v_corte
  from disciplines d
  where uc.discipline_id = d.id
    and uc.user_id = p_user_id
    and uc.expires_at > now()
    and (
      d.kind = 'membership'
      or (d.kind = 'credits' and uc.remaining_credits > 0)
      or (d.kind = 'credits' and coalesce(uc.remaining_credits, 0) <= 0
          and public.ultimo_dia_plan(uc.expires_at) = v_dia_plan)
    );

  get diagnostics v_filas_actualizadas = row_count;

  if v_filas_actualizadas = 0 then
    raise exception 'No se movió ninguna fila del plan de este socio -- no se cambió nada.';
  end if;

  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    update socios set fecha_vencimiento = p_nueva_fecha where dni = v_dni;
    get diagnostics v_socios_actualizados = row_count;
    if v_socios_actualizados = 0 then
      raise exception 'El socio tiene DNI % pero no hay ninguna ficha en Socios con ese DNI -- no se cambió nada.', v_dni;
    end if;
  end if;

  return v_filas_actualizadas;
end;
$function$;

-- ── admin_acreditar_creditos_manual (versión T1 + regla D con p_fecha_inicio) ──
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
  -- T2 (regla D): con fecha de inicio, el vencimiento que eligió Seba es
  -- p_fecha_inicio + p_dias_vigencia y se usa el día ENTERO -- el corte es el
  -- último microsegundo de ese día en Argentina (antes: las 00:00, el socio lo
  -- perdía). Su fecha calendario en Argentina sigue siendo el día elegido, así
  -- que el espejo en socios y el valor devuelto no cambian. Sin fecha de inicio,
  -- igual que antes.
  v_fecha_plan_nuevo := case
    when p_fecha_inicio is null then now() + (p_dias_vigencia || ' days')::interval
    else ((p_fecha_inicio + p_dias_vigencia + 1)::timestamp at time zone 'America/Argentina/Mendoza') - interval '1 microsecond'
  end;

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

-- ── Guarda 2 (chequeo): mismos permisos que antes en las 3 reemplazadas ──
-- ── Guarda 3: las 2 nuevas sin EXECUTE para public, anon ni authenticated ──
do $chequeo$
declare
  v_cambiados text;
  v_expuestas text;
begin
  select string_agg(a.funcion || ': antes ' || a.permisos || ' / ahora ' || coalesce(p.proacl::text, '(por defecto)'), ' | ')
    into v_cambiados
  from _t2_permisos_antes a
  join pg_proc p on p.oid = a.funcion::regprocedure
  where coalesce(p.proacl::text, '(por defecto)') <> a.permisos;
  if v_cambiados is not null then
    raise exception 'T2: cambiaron los permisos (%). No se aplicó nada.', v_cambiados;
  end if;

  select string_agg(f.oid::regprocedure::text, ', ') into v_expuestas
  from pg_proc f
  where f.oid in ('public.ultimo_dia_plan(timestamp with time zone)'::regprocedure,
                  'public.fecha_plan_socio(uuid)'::regprocedure)
    and (
      f.proacl is null
      or has_function_privilege('anon', f.oid, 'execute')
      or has_function_privilege('authenticated', f.oid, 'execute')
      or exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
    );
  if v_expuestas is not null then
    raise exception 'T2: estas funciones internas quedaron con EXECUTE para afuera: %. No se aplicó nada.', v_expuestas;
  end if;
end;
$chequeo$;

commit;

-- Verificación (solo lectura), después del commit:
-- select p.oid::regprocedure, md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', '', 'g')) as huella_sin_espacios,
--        coalesce(p.proacl::text, '(por defecto)') as permisos
-- from pg_proc p
-- where p.oid in ('public.ultimo_dia_plan(timestamp with time zone)'::regprocedure,
--                 'public.fecha_plan_socio(uuid)'::regprocedure,
--                 'public.resolver_fecha_plan_actual(uuid)'::regprocedure,
--                 'public.admin_editar_fecha_vencimiento_socio(uuid, date)'::regprocedure,
--                 'public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure);
-- -- esperado (huella_sin_espacios):
-- --   ultimo_dia_plan                       = 1682ea09613a4e9fd86f0101dca063a7
-- --   fecha_plan_socio                      = 7e82d5f0a2a13790b2bbfc64e765aac5
-- --   resolver_fecha_plan_actual            = 05f63efa8b16c9e5c96f2ef5a21289bf
-- --   admin_editar_fecha_vencimiento_socio  = 0f8710cd409c06c516f089f6b1b17a2f
-- --   admin_acreditar_creditos_manual       = de302991098cf77f2e60e4a3d41456c8
-- -- y ultimo_dia_plan / fecha_plan_socio sin anon ni authenticated en permisos.
