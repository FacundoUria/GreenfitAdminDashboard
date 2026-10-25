-- =====================================================================================
-- T1 (R2) -- un pago invalida TODOS los créditos anteriores del socio. NO SE CORRIÓ TODAVÍA.
-- ESTAMOS EN PRODUCCIÓN.
--
-- Qué cambia: en acreditar_pack (comprobante y Mercado Pago) y admin_acreditar_creditos_manual
-- (cobro y alta), el UPDATE de reseteo de créditos filtraba `remaining_credits > 0`: los lotes
-- en 0 quedaban con expires_at a futuro y un +1 al cancelar los "revivía" (2 fechas). Ahora
-- filtra `(remaining_credits > 0 or expires_at > now())`: lo de siempre MÁS los lotes en 0 con
-- fecha futura. El SET es el mismo (remaining_credits = 0, expires_at = least(expires_at,
-- now() - interval '1 day')). NADA más cambia: el resto del texto es el de producción del
-- 23/10 tal cual.
--
-- Solo reemplaza las 2 funciones (misma firma). Ningún UPDATE/DELETE/INSERT sobre datos
-- existentes. La tabla temporal de abajo es solo para comparar los permisos antes/después
-- y se borra sola al terminar la transacción.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) Las huellas actuales tienen que ser las de la exportación del 23/10
--      (acreditar_pack = 9c6212061b6901afb986bc92c97b9f78, admin_acreditar_creditos_manual =
--      ed4f952107eae97600b82ba367e2162e). Si alguien la cambió después, se frena.
--   2) Los permisos (proacl) tienen que quedar EXACTAMENTE iguales. create or replace los
--      conserva; por eso NO hay ningún grant/revoke en este archivo.
--
-- Prueba: prueba_t1_r2.sql (antes de esta migración los casos (a) y (b) fallan; después, todo OK).
-- Rollback: rollback_t1_r2.sql.
-- =====================================================================================

begin;

-- ── Guarda 1: se reemplaza exactamente la versión de producción conocida ──
do $guarda$
begin
  if md5(pg_get_functiondef('public.acreditar_pack(uuid, uuid, text, text)'::regprocedure)) <> '9c6212061b6901afb986bc92c97b9f78' then
    raise exception 'T1: acreditar_pack no es la versión del 23/10 (cambió su huella). No se aplicó nada.';
  end if;
  if md5(pg_get_functiondef('public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure)) <> 'ed4f952107eae97600b82ba367e2162e' then
    raise exception 'T1: admin_acreditar_creditos_manual no es la versión del 23/10 (cambió su huella). No se aplicó nada.';
  end if;
end;
$guarda$;

-- ── Guarda 2 (foto): permisos de antes ──
create temp table _t1_permisos_antes on commit drop as
select p.oid::regprocedure::text as funcion, coalesce(p.proacl::text, '(por defecto)') as permisos
from pg_proc p
where p.oid in ('public.acreditar_pack(uuid, uuid, text, text)'::regprocedure, 'public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure);

-- ── acreditar_pack ──
CREATE OR REPLACE FUNCTION public.acreditar_pack(p_user_id uuid, p_pack_id uuid, p_origen text, p_referencia_externa text DEFAULT NULL::text)
 RETURNS TABLE(creditos_otorgados integer, aparatos_extendido boolean, nueva_fecha_vencimiento_aparatos date, creditos_lotes jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_creditos jsonb;
  v_incluye_aparatos boolean;
  v_dias_vigencia int;
  v_aparatos_discipline_id uuid;
  v_credito jsonb;
  v_discipline_id uuid;
  v_credits int;
  v_discipline_ids_vistos uuid[] := '{}';
  v_total_creditos int := 0;
  v_dni text;
  v_fecha_plan_nuevo timestamptz;
  v_fecha_aparatos_actual timestamptz;
  v_aparatos_extendido boolean := false;
  v_lote_id uuid;
  v_creditos_lotes jsonb := '[]'::jsonb;
begin
  if p_origen not in ('manual', 'mercado_pago', 'transferencia_comprobante') then
    raise exception 'p_origen inválido: "%". Tiene que ser uno de: manual, mercado_pago, transferencia_comprobante.', p_origen;
  end if;

  select creditos, incluye_aparatos, dias_vigencia
    into v_creditos, v_incluye_aparatos, v_dias_vigencia
  from packs where id = p_pack_id;

  if not found then
    raise exception 'El pack % no existe.', p_pack_id;
  end if;

  -- "Un solo plan activo" -- UNA fecha para todo lo que este pack otorga
  -- (créditos Y Aparatos). Fallback de 30 días si dias_vigencia es null
  -- (packs 100% créditos hoy) -- ver nota del header.
  v_fecha_plan_nuevo := now() + (coalesce(v_dias_vigencia, 30) || ' days')::interval;

  -- Se resuelve SIEMPRE (no solo si el pack nuevo incluye Aparatos) --
  -- hace falta para poder apagar un Aparatos vigente aunque este pack no
  -- lo traiga.
  select id into v_aparatos_discipline_id from disciplines where kind = 'membership' limit 1;

  -- ============================================================
  -- RESETEO -- todo lo que el socio tenía activo se apaga ANTES de
  -- acreditar el pack nuevo. Si algo falla más abajo (pack malformado en
  -- el loop), la transacción entera se revierte -- este reseteo nunca
  -- queda aplicado a mitad de camino sin la acreditación nueva.
  -- ============================================================

  -- Créditos -- remaining_credits=0 en TODAS las disciplinas de créditos
  -- del socio, no solo las que trae el pack nuevo. Nunca se borra una
  -- fila (bookings.credit_lote_id puede referenciarla, mismo criterio de
  -- siempre) -- solo se la deja en 0, inerte.
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

  -- Aparatos -- cualquier fila todavía vigente deja de estarlo ya mismo,
  -- sin importar si el pack nuevo la va a reemplazar o no.
  --
  -- BUG REAL (encontrado probando la Fase 1): `expires_at = now()` deja
  -- una fecha que, espejada en socios.fecha_vencimiento (una columna
  -- `date`, sin hora), da EXACTAMENTE hoy. esta_habilitado_para_disciplina()
  -- compara `fecha_vencimiento >= current_date` -- por DÍA completo, no
  -- por instante -- así que un reseteo hecho a cualquier hora del día de
  -- hoy seguía leyendo como "vigente" hasta la medianoche, aunque
  -- técnicamente ya se había apagado. `now() - interval '1 day'` deja la
  -- fecha SIEMPRE claramente anterior a hoy, sin ambigüedad para ningún
  -- chequeo por día completo, sin importar a qué hora se ejecute esto.
  if v_aparatos_discipline_id is not null then
    update user_credits
    set expires_at = now() - interval '1 day'
    where user_id = p_user_id
      and discipline_id = v_aparatos_discipline_id
      and expires_at > now();
  end if;

  -- ============================================================
  -- ACREDITACIÓN -- solo lo que trae ESTE pack. Sin lotes, sin fusión por
  -- fecha -- ya no hace falta, porque no puede quedar nada previo vigente
  -- con lo que fusionar.
  -- ============================================================
  for v_credito in select * from jsonb_array_elements(coalesce(v_creditos, '[]'::jsonb))
  loop
    v_discipline_id := (v_credito->>'discipline_id')::uuid;
    v_credits := (v_credito->>'credits')::int;

    if v_discipline_id is null then
      raise exception 'El pack % tiene una entrada de créditos sin discipline_id válido: %', p_pack_id, v_credito;
    end if;
    if v_credits is null or v_credits <= 0 then
      raise exception 'El pack % tiene una entrada de créditos inválida para la disciplina % (credits=%)', p_pack_id, v_discipline_id, v_credito->>'credits';
    end if;
    if v_discipline_id = any(v_discipline_ids_vistos) then
      raise exception 'El pack % repite la disciplina % más de una vez en su lista de créditos -- corregí el pack antes de acreditar.', p_pack_id, v_discipline_id;
    end if;
    v_discipline_ids_vistos := array_append(v_discipline_ids_vistos, v_discipline_id);

    insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
    values (p_user_id, p_pack_id, v_discipline_id, v_credits, v_fecha_plan_nuevo)
    returning id into v_lote_id;

    v_total_creditos := v_total_creditos + v_credits;
    v_creditos_lotes := v_creditos_lotes || jsonb_build_array(
      jsonb_build_object('discipline_id', v_discipline_id, 'credits_otorgados', v_credits, 'lote_id', v_lote_id)
    );
  end loop;

  -- Aparatos, si el pack nuevo lo incluye -- MISMA fecha que los créditos
  -- de este pack (plan único), plana. SIN el greatest(vigente, hoy) de
  -- antes -- no hay carryover de la vigencia anterior: se acaba de apagar
  -- arriba, sin importar cuál era.
  if v_incluye_aparatos and v_aparatos_discipline_id is not null then
    insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
    values (p_user_id, p_pack_id, v_aparatos_discipline_id, null, v_fecha_plan_nuevo);

    v_aparatos_extendido := true;
  end if;

  -- Estado REAL de Aparatos después del reseteo -- ver nota del header
  -- sobre por qué esto ya no puede ser un simple coalesce con la fecha
  -- vieja. Es la fila más reciente (la nueva del pack si la incluyó, o la
  -- que se acaba de apagar arriba si no) -- null si el socio nunca tuvo
  -- Aparatos.
  if v_aparatos_discipline_id is not null then
    select expires_at into v_fecha_aparatos_actual
    from user_credits
    where user_id = p_user_id and discipline_id = v_aparatos_discipline_id
    order by created_at desc
    limit 1;
  end if;

  -- Espejo en socios -- recalculado desde cero (ya no incremental): el
  -- total activo es EXACTAMENTE lo que este pack acredita (todo lo
  -- anterior quedó en 0 arriba).
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

-- ── admin_acreditar_creditos_manual ──
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

-- ── Guarda 2 (chequeo): mismos permisos que antes ──
do $chequeo$
declare
  v_cambiados text;
begin
  select string_agg(a.funcion || ': antes ' || a.permisos || ' / ahora ' || coalesce(p.proacl::text, '(por defecto)'), ' | ')
    into v_cambiados
  from _t1_permisos_antes a
  join pg_proc p on p.oid = a.funcion::regprocedure
  where coalesce(p.proacl::text, '(por defecto)') <> a.permisos;
  if v_cambiados is not null then
    raise exception 'T1: cambiaron los permisos (%). No se aplicó nada.', v_cambiados;
  end if;
end;
$chequeo$;

commit;

-- Verificación (solo lectura), después del commit:
-- select p.oid::regprocedure, md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', '', 'g')) as huella_sin_espacios,
--        pg_get_functiondef(p.oid) like '%(remaining_credits > 0 or expires_at > now())%' as tiene_r2
-- from pg_proc p
-- where p.oid in ('public.acreditar_pack(uuid, uuid, text, text)'::regprocedure, 'public.admin_acreditar_creditos_manual(uuid, jsonb, boolean, integer, date)'::regprocedure);
-- -- esperado: tiene_r2 = true en las dos; huella_sin_espacios = cd4f6062aa6bcf6241a1151e094686ae (acreditar_pack)
-- -- y 5bcbf2fa81211071a671ac503e38fd79 (admin_acreditar_creditos_manual).
