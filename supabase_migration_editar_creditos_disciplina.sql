-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- Sacar los steppers -/+1/+4/+8/+12 de la fila de SociosTabla.jsx (con
-- datos sucios de la migración de CrossFy, corregir a alguien con muchos
-- créditos de más obligaba a tocar "-1" decenas de veces) y mover la
-- edición a "Editar Socio" (CreditosEditablesSocio.jsx), con la
-- posibilidad de escribir el número exacto. Esto requiere DOS RPCs nuevos
-- -- ninguno existía antes.
--
-- 1) admin_fijar_creditos_disciplina(p_user_id, p_discipline_id,
--    p_creditos) -- pisa el total con un número exacto. CONSOLIDA todos
--    los lotes activos de esa disciplina en UNO SOLO: los lotes viejos se
--    ponen en remaining_credits=0 (NUNCA se borran -- bookings.
--    credit_lote_id puede referenciarlos; un DELETE fallaría por la FK o
--    rompería el historial de qué lote pagó cada reserva pasada, mismo
--    criterio que ya usa cancel_booking()/admin_revertir_comprobante() de
--    nunca borrar una fila de user_credits una vez que existe) y se
--    inserta un lote nuevo con el total exacto. El vencimiento del lote
--    nuevo es el MÁS LEJANO que tenían los lotes reemplazados (si no había
--    ninguno, now()+30 días -- mismo default que sincronizarCreditosPwa/
--    acreditar_pack) -- así fijar un número no le acorta la vigencia a un
--    socio que tenía un lote vigente hasta más adelante.
--
-- 2) admin_ajustar_credito_disciplina(p_user_id, p_discipline_id, p_delta)
--    -- el +1/-1 rápido de siempre, ahora en un RPC propio server-side (ya
--    no existía como tal -- antes SociosTabla.jsx llamaba directo a
--    sincronizarCreditosPwa, que no sabía nada de lotes). +N: mismo
--    criterio de fusión EXACTO que acreditar_pack (fusiona con un lote
--    activo del mismo día calendario Argentina si existe, si no crea uno
--    nuevo a 30 días -- ver supabase_migration_fix_zona_horaria_fusion_
--    lotes.sql, de donde se copia la condición tal cual). -N: descuenta
--    del lote que vence antes (mismo FIFO que book_class -- ver
--    supabase_migration_lotes_creditos_fase2.sql), across TANTOS lotes
--    como haga falta si uno solo no alcanza (a diferencia de book_class,
--    que siempre gasta de a 1 crédito de 1 lote -- acá un ajuste de -8
--    puede necesitar vaciar 2-3 lotes chicos), sin bajar ninguno de 0 y
--    sin crear nada si no queda ningún lote con saldo (lo ya gastado,
--    gastado queda).
--
-- El espejo en `socios.creditos` (pozo global, suma TODAS las disciplinas
-- de créditos del socio) se RECALCULA DESDE CERO en las dos funciones --
-- no se ajusta de forma incremental como hace acreditar_pack. Decisión: a
-- diferencia de acreditar_pack (que solo SUMA, nunca necesita mirar el
-- estado previo), "fijar" es por naturaleza una operación de SET, no de
-- delta -- y el recálculo completo además es auto-reparador para
-- cualquier drift que ya existiera en socios.creditos de antes (dato
-- legacy conocido como poco confiable, ver EstadoBadge/CreditosCell), a un
-- costo extra de query insignificante. Mismo criterio en las dos
-- funciones por consistencia.
--
-- Solo aplica a disciplinas kind='credits' -- Aparatos (kind='membership')
-- no tiene lotes/cantidad, sigue editándose por su propio campo de fecha
-- de vencimiento en NuevoSocioModal.jsx, sin cambios. Las dos funciones
-- rechazan explícitamente que se las llame con una disciplina que no sea
-- de créditos.

-- ============================================================
-- 1) admin_fijar_creditos_disciplina()
-- ============================================================

create or replace function public.admin_fijar_creditos_disciplina(
  p_user_id uuid,
  p_discipline_id uuid,
  p_creditos int
)
returns void
language plpgsql
security definer
as $$
declare
  v_kind text;
  v_dni text;
  v_vencimiento_mas_lejano timestamptz;
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

  -- Vencimiento más lejano entre los lotes ACTIVOS (remaining_credits>0)
  -- que se están por consolidar -- sin importar si ya vencieron: un lote
  -- vencido con saldo también cuenta para no perder de vista su fecha
  -- (mismo criterio de "activo" que usa la fusión de acreditar_pack, que
  -- mira remaining_credits>0 sin filtrar por expires_at>now()).
  select max(expires_at) into v_vencimiento_mas_lejano
  from user_credits
  where user_id = p_user_id and discipline_id = p_discipline_id and remaining_credits > 0;

  -- Consolidar -- nunca se borra un lote, se lo deja en 0 (bookings.
  -- credit_lote_id puede apuntarle).
  update user_credits
  set remaining_credits = 0
  where user_id = p_user_id and discipline_id = p_discipline_id and remaining_credits > 0;

  insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
  values (
    p_user_id,
    p_discipline_id,
    p_creditos,
    coalesce(v_vencimiento_mas_lejano, now() + interval '30 days')
  );

  -- Espejo en socios.creditos -- recalculado desde cero (ver nota del
  -- header), sumando TODAS las disciplinas de créditos de este socio, no
  -- solo la que se acaba de tocar.
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
$$;

grant execute on function public.admin_fijar_creditos_disciplina(uuid, uuid, int) to authenticated;

-- ============================================================
-- 2) admin_ajustar_credito_disciplina()
-- ============================================================

create or replace function public.admin_ajustar_credito_disciplina(
  p_user_id uuid,
  p_discipline_id uuid,
  p_delta int
)
returns void
language plpgsql
security definer
as $$
declare
  v_kind text;
  v_dni text;
  v_fecha_nuevo_lote timestamptz;
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
    return; -- nada que ajustar
  end if;

  if p_delta > 0 then
    -- Mismo criterio EXACTO de fusión que acreditar_pack (ver
    -- supabase_migration_fix_zona_horaria_fusion_lotes.sql): "mismo día
    -- calendario" se compara en hora Argentina, no en el timezone por
    -- defecto de la sesión (UTC) -- si no, dos ajustes el mismo día local
    -- cerca de la medianoche UTC podrían no fusionar.
    v_fecha_nuevo_lote := now() + interval '30 days';

    select id into v_lote_id
    from user_credits
    where user_id = p_user_id
      and discipline_id = p_discipline_id
      and remaining_credits > 0
      and (expires_at at time zone 'America/Argentina/Mendoza')::date
        = (v_fecha_nuevo_lote at time zone 'America/Argentina/Mendoza')::date
    order by created_at desc
    limit 1
    for update;

    if v_lote_id is not null then
      update user_credits set remaining_credits = remaining_credits + p_delta where id = v_lote_id;
    else
      insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
      values (p_user_id, p_discipline_id, p_delta, v_fecha_nuevo_lote);
    end if;
  else
    -- FIFO por expires_at ascendente (mismo criterio que book_class),
    -- pero across TANTOS lotes como haga falta -- a diferencia de
    -- book_class (que siempre gasta 1 crédito de 1 lote), un ajuste de
    -- -8 puede necesitar vaciar varios lotes chicos. Nunca baja ninguno
    -- de 0; si los lotes se acaban antes de completar el ajuste, se
    -- corta ahí sin crear nada (lo ya gastado, gastado queda).
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
    -- Si v_restante sigue > 0 acá, no había suficiente saldo -- se
    -- descontó todo lo que había y se corta, sin error (mismo espíritu
    -- de "sin bajar de 0" que el resto del sistema).
  end if;

  -- Espejo en socios.creditos -- recalculado desde cero, misma lógica y
  -- mismo motivo que en admin_fijar_creditos_disciplina().
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
$$;

grant execute on function public.admin_ajustar_credito_disciplina(uuid, uuid, int) to authenticated;

-- ============================================================
-- VERIFICACIÓN -- correr a mano después de aplicar, con un socio de
-- prueba armado con varios lotes fragmentados (mismo patrón usado en
-- sesiones anteriores, ej. duplicando el caso Elena Castillo/Agustina
-- Barbero a mano vía INSERT en user_credits).
-- ============================================================

-- 0) Armar el escenario -- 3 lotes de la MISMA disciplina para un socio de
-- prueba, con vencimientos distintos, para poder ver la consolidación y
-- el FIFO en acción:
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 3, now() + interval '10 days'),
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 5, now() + interval '20 days'),
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 2, now() + interval '45 days');
-- -- total esperado antes de tocar nada: 10 créditos, vencimiento más lejano a 45 días.

-- 1) Fijar un número MAYOR al actual (10 -> 20):
-- select admin_fijar_creditos_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 20);
-- select remaining_credits, expires_at from user_credits where user_id='<USER_ID_PRUEBA>' and discipline_id='<DISCIPLINE_ID_PRUEBA>' order by created_at;
-- -- esperado: los 3 lotes viejos en remaining_credits=0 (NO borrados), 1 lote nuevo con 20, expires_at = el de "+45 days" (el más lejano de los que había).

-- 2) Fijar un número MENOR al actual (20 -> 4):
-- select admin_fijar_creditos_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 4);
-- -- esperado: el lote de 20 (del paso 1) también queda en 0, nuevo lote con 4.

-- 3) Fijar en 0:
-- select admin_fijar_creditos_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 0);
-- select creditos from socios where dni = '<DNI_PRUEBA>';
-- -- esperado: nuevo lote con remaining_credits=0, socios.creditos recalculado a 0 para esta disciplina (sumando el resto si tiene otras).

-- 4) +1 CON un lote existente del mismo día (correr dos veces seguidas el
-- mismo día -- la segunda tiene que fusionar, no crear un lote aparte):
-- select admin_ajustar_credito_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 1);
-- select admin_ajustar_credito_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 1);
-- select count(*), sum(remaining_credits) from user_credits where user_id='<USER_ID_PRUEBA>' and discipline_id='<DISCIPLINE_ID_PRUEBA>' and remaining_credits>0;
-- -- esperado: sigue siendo 1 sola fila activa (se fusionó), remaining_credits sumó +2 en total.

-- 5) +1 SIN lote existente del mismo día (vaciar todo primero, para forzar la creación):
-- select admin_fijar_creditos_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 0);
-- select admin_ajustar_credito_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 1);
-- -- esperado: lote nuevo (el de "fijar en 0" queda en 0, no cuenta como "existente" para fusión porque remaining_credits=0), expires_at = now()+30 días.

-- 6) -1 con varios lotes (confirmar que descuenta del que vence antes):
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 1, now() + interval '5 days'),
--   ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 5, now() + interval '15 days');
-- select admin_ajustar_credito_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', -1);
-- select remaining_credits, expires_at from user_credits where user_id='<USER_ID_PRUEBA>' and discipline_id='<DISCIPLINE_ID_PRUEBA>' and remaining_credits>0 order by expires_at;
-- -- esperado: el lote de "+5 days" (el que vence antes) bajó a 0, el de "+15 days" sigue en 5 sin tocar.

-- 7) -1 sin nada que descontar (vaciar todo, después ajustar):
-- select admin_fijar_creditos_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', 0);
-- select admin_ajustar_credito_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_PRUEBA>', -1);
-- select remaining_credits from user_credits where user_id='<USER_ID_PRUEBA>' and discipline_id='<DISCIPLINE_ID_PRUEBA>' order by created_at desc limit 1;
-- -- esperado: no explota, no crea ningún lote nuevo, el último lote sigue en 0 (no baja a -1).

-- 8) Guardas -- confirmar que Aparatos (kind='membership') rechaza las dos funciones:
-- select admin_fijar_creditos_disciplina('<USER_ID_PRUEBA>', (select id from disciplines where kind='membership' limit 1), 5);
-- -- esperado: excepción "admin_fijar_creditos_disciplina() es solo para disciplinas de créditos...".
