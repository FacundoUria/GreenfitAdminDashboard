-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- FASE A -- SOLO la función centralizada. NO se conecta a nada en este
-- script: book_class(), admin_book_class(), registrar_hoy_entrene() y
-- Check-in Rápido (admin_otorgar_checkin_aparatos / darPresenteClase)
-- siguen exactamente como están hoy, sin chequear vencimiento. Conectarla
-- es la Fase B, recién después de validar los 3 casos reales de más abajo.
--
-- Por qué esta función existe (ver investigación previa, sesión anterior):
-- book_class/admin_book_class solo miran "¿remaining_credits > 0 ahora
-- mismo?", sin mirar expires_at nunca. Check-in Rápido no mira nada de
-- vencimiento en ningún camino. registrar_hoy_entrene() sí filtra
-- membresías vencidas, pero no créditos vencidos. Esto centraliza el
-- criterio real en un solo lugar en vez de seguir reimplementándolo
-- distinto (y distinto de mal) en cada función.
--
-- Regla de negocio implementada (decidida de antemano, no se vuelve a
-- evaluar acá):
--   - Aparatos (disciplines.kind = 'membership'): habilitado si
--     socios.fecha_vencimiento (leída EN VIVO por el puente de DNI
--     profiles.dni = socios.dni, mismo patrón que ya usa
--     admin_aprobar_comprobante y el resto del sistema) es hoy o
--     posterior, Y ADEMÁS socios.activo = true. Fuente de verdad =
--     socios, a propósito -- NO se usa user_credits.expires_at para
--     Aparatos: es una copia sincronizada best-effort que puede quedar
--     desactualizada (causa raíz confirmada del caso real Emilio Camargo:
--     Admin mostraba 09/02/2026, la PWA 29/07/2026 -- la copia vieja en
--     user_credits nunca se actualizó cuando se corrigió
--     socios.fecha_vencimiento). Decisión ya tomada: un socio dado de baja
--     (activo=false) da false sin importar la fecha_vencimiento -- una
--     baja administrativa tiene que bloquear ya, no esperar a que venza el
--     ciclo que tenía cargado.
--   - Créditos (disciplines.kind = 'credits', CrossFit/Boxeo/Kickstrike):
--     habilitado si la fila más reciente de user_credits para esa
--     disciplina puntual (mismo criterio "última por created_at gana" que
--     ya usa toda la app) tiene remaining_credits > 0 Y expires_at > now().
--     Sin chequeo de socios.activo acá -- no se tocó esta rama.
--
-- Deliberadamente SIN días de tolerancia acá (a diferencia de
-- calcularEstadoCuota/getExpiryStatus, que son solo para el badge visual):
-- la regla de negocio para BLOQUEAR una acción real es "vencido = vencido
-- ahora mismo, sin margen". Si más adelante se quiere una ventana de
-- gracia real para esta función, es una decisión de negocio aparte, no
-- asumida acá.
--
-- Fail-closed en todos los caminos sin información suficiente (socio sin
-- ficha vinculada en `socios`, sin fecha_vencimiento cargada, sin ninguna
-- fila de user_credits para la disciplina, discipline_id inexistente,
-- kind desconocido): devuelve false. Más seguro bloquear una acción que
-- dejar pasar a alguien de quien no se puede determinar el estado real.
-- Mismo resultado (false), pero por regla de negocio explícita, no por
-- falta de datos: socio con ficha vinculada y fecha_vencimiento vigente,
-- pero dado de baja (socios.activo = false).

create or replace function public.esta_habilitado_para_disciplina(p_user_id uuid, p_discipline_id uuid)
returns boolean
language plpgsql
security definer
stable
as $$
declare
  v_kind text;
  v_fecha_vencimiento date;
  v_activo boolean;
  v_remaining int;
  v_expires_at timestamptz;
begin
  select kind into v_kind from disciplines where id = p_discipline_id;
  if v_kind is null then
    -- discipline_id que no existe en el catálogo -- nada que evaluar.
    return false;
  end if;

  if v_kind = 'membership' then
    -- Puente por DNI EN VIVO (no se toca user_credits para nada acá) --
    -- `socios.dni` es UNIQUE (ver NuevoSocioModal.jsx), así que esto trae
    -- como mucho una fila; `limit 1` es solo defensivo.
    select s.fecha_vencimiento, s.activo into v_fecha_vencimiento, v_activo
    from public.profiles p
    join public.socios s on s.dni = p.dni
    where p.id = p_user_id
    limit 1;

    -- Sin ficha vinculada en `socios`, o ficha vinculada pero sin
    -- fecha_vencimiento cargada todavía -- no hay manera de confirmar que
    -- está al día. Fail-closed.
    if v_fecha_vencimiento is null then
      return false;
    end if;

    -- Baja administrativa (activo=false) bloquea ya, sin importar la
    -- fecha_vencimiento que haya quedado cargada -- `coalesce` a propósito:
    -- si por lo que sea la columna viniera null, se trata como inactivo
    -- (fail-closed), no como activo.
    return coalesce(v_activo, false) and v_fecha_vencimiento >= current_date;
  end if;

  if v_kind = 'credits' then
    select remaining_credits, expires_at into v_remaining, v_expires_at
    from public.user_credits
    where user_id = p_user_id and discipline_id = p_discipline_id
    order by created_at desc
    limit 1;

    -- Ninguna fila para esta disciplina puntual (el socio nunca tuvo
    -- créditos acá, o el admin se los sacó del plan) -- fail-closed.
    if v_remaining is null then
      return false;
    end if;

    return v_remaining > 0 and v_expires_at is not null and v_expires_at > now();
  end if;

  -- kind que no es ni 'membership' ni 'credits' (valor futuro/desconocido
  -- del enum) -- fail-closed, no asumir que está habilitado.
  return false;
end;
$$;

grant execute on function public.esta_habilitado_para_disciplina(uuid, uuid) to authenticated;

-- ============================================================
-- PASO 2 -- Verificación contra casos reales (NO CONECTADA A NADA).
-- Correr de a un bloque, a mano, DESPUÉS de aplicar la función de arriba.
-- Nada de esto modifica datos salvo el bloque 2 (marcado explícitamente),
-- que arma un socio de prueba sintético y se puede borrar después.
-- ============================================================

-- ── Caso 1: Emilio Camargo (Aparatos) -- tiene que dar FALSE ───────────────
-- Primero encontrá su user_id (id de profiles) y el discipline_id de
-- Aparatos:
--
-- select p.id as user_id, p.full_name, s.dni, s.fecha_vencimiento
-- from profiles p
-- join socios s on s.dni = p.dni
-- where s.nombre ilike '%emilio%' and s.apellido ilike '%camargo%';
--
-- select id as discipline_id, name, kind from disciplines where kind = 'membership';
--
-- Con esos dos ids:
-- select public.esta_habilitado_para_disciplina('<USER_ID_EMILIO>', '<DISCIPLINE_ID_APARATOS>');
-- Tiene que devolver `false` -- sin importar lo que diga hoy
-- user_credits.expires_at para él (podés confirmar la copia vieja/
-- desactualizada con esta otra query, solo para comparar, no la toca):
-- select expires_at, created_at from user_credits
-- where user_id = '<USER_ID_EMILIO>' and discipline_id = '<DISCIPLINE_ID_APARATOS>'
-- order by created_at desc;

-- ── Caso 2: socio de prueba con créditos > 0 pero expires_at ya vencido ────
-- Si ya tenés un socio real en esa situación, saltá directo al select de
-- abajo con sus ids reales. Si no, este bloque arma el escenario sintético
-- sobre un socio de prueba YA EXISTENTE (no crea un socio nuevo) -- pisa
-- una fila de user_credits de prueba, revisalo antes de correrlo:
--
-- 1) Elegí un socio de prueba real con cuenta de PWA y una disciplina de
--    créditos (ej. CrossFit):
-- select p.id as user_id, p.full_name from profiles p where p.dni = '<DNI DE PRUEBA>';
-- select id as discipline_id, name from disciplines where kind = 'credits' and name ilike '%crossfit%';
--
-- 2) Insertá una fila de prueba con créditos > 0 pero YA vencida (ayer):
-- insert into user_credits (user_id, discipline_id, remaining_credits, expires_at, created_at)
-- values ('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_CROSSFIT>', 5, now() - interval '1 day', now());
--
-- 3) Confirmá que da FALSE (créditos sobran, pero la tanda ya venció):
-- select public.esta_habilitado_para_disciplina('<USER_ID_PRUEBA>', '<DISCIPLINE_ID_CROSSFIT>');
--
-- 4) Limpieza opcional (borra SOLO la fila de prueba insertada en el paso 2,
--    identificala por su id real devuelto en el insert -- no borres a ciegas
--    por user_id, podría haber otras filas reales de este socio):
-- delete from user_credits where id = '<ID DE LA FILA INSERTADA EN EL PASO 2>';

-- ── Caso 3: socio de prueba con todo al día -- tiene que dar TRUE ──────────
-- Aparatos (fecha_vencimiento futura):
-- select p.id as user_id, s.fecha_vencimiento from profiles p
-- join socios s on s.dni = p.dni where s.dni = '<DNI DE PRUEBA AL DÍA>';
-- select id as discipline_id from disciplines where kind = 'membership';
-- select public.esta_habilitado_para_disciplina('<USER_ID>', '<DISCIPLINE_ID_APARATOS>'); -- true
--
-- Créditos (remaining_credits > 0 y expires_at futuro):
-- select id as discipline_id, name from disciplines where kind = 'credits';
-- select public.esta_habilitado_para_disciplina('<USER_ID>', '<DISCIPLINE_ID_CREDITOS>'); -- true

-- ── Extra -- casos borde de fail-closed (opcional, para confirmar que no
-- rompen nada y devuelven false en vez de tirar una excepción) ─────────────
-- select public.esta_habilitado_para_disciplina('00000000-0000-0000-0000-000000000000', '<DISCIPLINE_ID_APARATOS>'); -- false: user_id inexistente
-- select public.esta_habilitado_para_disciplina('<USER_ID_SIN_SOCIO_VINCULADO>', '<DISCIPLINE_ID_APARATOS>'); -- false: sin ficha en socios
-- select public.esta_habilitado_para_disciplina('<USER_ID>', '00000000-0000-0000-0000-000000000000'); -- false: discipline_id inexistente

-- ── Extra -- baja administrativa (activo=false) con fecha_vencimiento
-- vigente -- tiene que dar FALSE igual (regla nueva de esta versión) ───────
-- Buscá un socio de baja real (o marcá uno de prueba como activo=false a
-- mano, revirtiéndolo después):
-- select p.id as user_id, s.activo, s.fecha_vencimiento from profiles p
-- join socios s on s.dni = p.dni where s.activo = false and s.fecha_vencimiento >= current_date
-- limit 1;
-- select public.esta_habilitado_para_disciplina('<USER_ID>', '<DISCIPLINE_ID_APARATOS>'); -- false
