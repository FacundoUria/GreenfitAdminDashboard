-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- HOTFIX -- bug real en producción: un combo aprobado ("Combo 12 Cross +
-- 12 Box", pack_id af47a6c8-f483-4286-9fe4-9a1d1b094027) acreditó CrossFit
-- pero NO Boxeo. Causa (ver análisis completo en el mensaje de la sesión):
-- el loop de acreditar_pack() sobre jsonb_array_elements(v_creditos) NO
-- tiene ningún bug de corte temprano -- recorre SIEMPRE todo el array. El
-- problema es que el `if v_discipline_id is not null and v_credits is not
-- null and v_credits > 0 then` salteaba en SILENCIO cualquier entrada mal
-- formada, sin loguear ni avisar nada. Casi seguro la entrada de Boxeo en
-- packs.creditos está hoy mal formada o directamente ausente -- confirmar
-- con el PASO 0 de acá abajo ANTES de asumir nada.
--
-- Como el loop es una extracción TEXTUAL del que ya vivía en
-- mp_process_payment/admin_aprobar_comprobante desde antes de la Fase 2,
-- si la causa es el JSON del pack (no el código), este bug pudo afectar
-- pagos de ANTES de la Fase 2 también -- ver PASO 0.3.
--
-- ORDEN OBLIGATORIO:
--   PASO 0 (solo lectura -- correr TODO esto primero, hoy mismo).
--   PASO 1 (escritura -- el fix del código -- NO CORRER hasta confirmar el
--     diagnóstico del PASO 0 conmigo).
--   PASO 2 (verificación del fix con casos de prueba).
--   PASO 3 (corrección manual del socio real afectado -- plantilla, NO
--     CORRER hasta tener los valores reales confirmados del PASO 0).

-- ============================================================
-- PASO 0 -- DIAGNÓSTICO (solo lectura, correr todo esto ya)
-- ============================================================

-- 0.1) Confirmar el pack por nombre Y por id (cross-check).
select id, name, creditos, incluye_aparatos, dias_vigencia,
       jsonb_array_length(coalesce(creditos, '[]'::jsonb)) as cantidad_de_entradas
from packs
where id = 'af47a6c8-f483-4286-9fe4-9a1d1b094027'
   or name ilike '%combo%cross%box%'
   or name ilike '%combo%12%box%';

-- 0.2) El pago real más reciente de ese pack, aprobado -- esto te da el
--      user_id/socio afectado.
select ps.id as pagos_socio_id, ps.user_id, pr.full_name, pr.dni, ps.pack_id, ps.paquete,
       ps.monto, ps.estado, ps.reviewed_at, ps.reviewed_by, ps.created_at
from pagos_socio ps
join profiles pr on pr.id = ps.user_id
where ps.pack_id = 'af47a6c8-f483-4286-9fe4-9a1d1b094027'
  and ps.estado = 'pagado'
  and ps.origen = 'transferencia_comprobante'
order by coalesce(ps.reviewed_at, ps.created_at) desc
limit 5;

-- 0.3) Cada entrada del jsonb de ese pack, SEPARADA, con el discipline_id
--      resuelto contra el catálogo real -- acá se ve exacto cuál entrada
--      está rota (discipline_id_resuelto = null significa que esa entrada
--      no matchea ninguna fila viva de disciplines; discipline_id_crudo o
--      credits_crudo = null significa que la clave directamente no está en
--      el JSON de esa entrada). El cast a uuid está guardado con una regex
--      -- si el valor no tiene forma de uuid, esta query NO falla, solo
--      muestra null en discipline_id_resuelto.
select
  c.ordinality,
  c.value ->> 'discipline_id' as discipline_id_crudo,
  c.value ->> 'credits' as credits_crudo,
  d.id as discipline_id_resuelto,
  d.name as discipline_name,
  d.kind
from packs p
cross join lateral jsonb_array_elements(p.creditos) with ordinality as c(value, ordinality)
left join disciplines d on d.id = (
  case
    when (c.value ->> 'discipline_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (c.value ->> 'discipline_id')::uuid
    else null
  end
)
where p.id = 'af47a6c8-f483-4286-9fe4-9a1d1b094027';

-- 0.4) Qué se acreditó DE VERDAD en user_credits para ese socio y ese pack
--      (reemplazá <USER_ID DEL PASO 0.2>).
select uc.discipline_id, d.name, uc.remaining_credits, uc.expires_at, uc.created_at
from user_credits uc
left join disciplines d on d.id = uc.discipline_id
where uc.user_id = '<USER_ID DEL PASO 0.2>' and uc.pack_id = 'af47a6c8-f483-4286-9fe4-9a1d1b094027'
order by uc.created_at desc;

-- 0.5) ALCANCE -- cualquier OTRO pago 'pagado' (comprobante O Mercado Pago
--      -- el mismo bug de JSON hubiera afectado a los dos caminos por
--      igual) de un pack con 2+ disciplinas de créditos, comparando cuántas
--      disciplinas trae el combo vs. cuántas tienen una fila real en
--      user_credits creada cerca de la aprobación. Es una HEURÍSTICA por
--      tiempo (no hay FK directa pago -> user_credits) -- cualquier fila
--      donde los dos números no coincidan es candidata a revisar a mano.
select
  ps.id as pagos_socio_id,
  ps.user_id,
  pr.full_name,
  ps.pack_id,
  p.name as pack_name,
  jsonb_array_length(p.creditos) as disciplinas_en_el_combo,
  coalesce(ps.reviewed_at, ps.created_at) as fecha_acreditacion,
  (
    select count(distinct uc.discipline_id)
    from user_credits uc
    where uc.user_id = ps.user_id
      and uc.pack_id = ps.pack_id
      and uc.discipline_id in (
        select (c.value ->> 'discipline_id')::uuid
        from jsonb_array_elements(p.creditos) c
        where (c.value ->> 'discipline_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
      and uc.created_at between coalesce(ps.reviewed_at, ps.created_at) - interval '5 minutes'
                             and coalesce(ps.reviewed_at, ps.created_at) + interval '5 minutes'
  ) as disciplinas_acreditadas_cerca_de_la_fecha
from pagos_socio ps
join packs p on p.id = ps.pack_id
join profiles pr on pr.id = ps.user_id
where ps.estado = 'pagado'
  and ps.origen in ('transferencia_comprobante', 'mercado_pago')
  and jsonb_array_length(coalesce(p.creditos, '[]'::jsonb)) >= 2
order by fecha_acreditacion desc;
-- Revisá a mano cualquier fila donde disciplinas_acreditadas_cerca_de_la_fecha
-- sea MENOR que disciplinas_en_el_combo.

-- ============================================================
-- PASO 1 -- FIX de acreditar_pack() -- NO CORRER hasta confirmar el
-- diagnóstico del PASO 0 conmigo.
--
-- Único cambio real: el filtro silencioso `if ... then insert ... end if`
-- se reemplaza por validaciones EXPLÍCITAS que levantan una excepción
-- clara ante cualquier entrada mal formada (discipline_id null, credits
-- null o <= 0) o duplicada (misma disciplina dos veces en el mismo pack)
-- -- ANTES de acreditar nada. Decisión de diseño (marcada para que la
-- confirmes, es la primera vez que este cambio hace que la función
-- rechace un pack en vez de acreditar parcialmente): ante un pack roto,
-- ahora NO se acredita NADA (ni siquiera las disciplinas que sí estaban
-- bien) y el admin ve un error claro en pantalla -- es preferible a que
-- vuelva a pasar esto (una acreditación parcial silenciosa, sin que nadie
-- se entere hasta que el socio reclama). Si preferís loguear con `raise
-- warning` y seguir acreditando lo que sí es válido (comportamiento actual,
-- solo con el agregado de un log visible), avisame y lo cambio antes de
-- aplicar esto -- es la única decisión de este archivo que no es 100%
-- mecánica.
--
-- El resto de la función (resolver el pack, resolver Aparatos, la
-- extensión de Aparatos, el espejo a socios) queda EXACTAMENTE igual.
-- ============================================================

create or replace function public.acreditar_pack(
  p_user_id uuid,
  p_pack_id uuid,
  p_origen text,
  p_referencia_externa text default null
)
returns table (
  creditos_otorgados int,
  aparatos_extendido boolean,
  nueva_fecha_vencimiento_aparatos date
)
language plpgsql
security definer
as $$
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
  v_nueva_fecha_vencimiento timestamptz;
  v_aparatos_extendido boolean := false;
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

  if v_incluye_aparatos then
    select id into v_aparatos_discipline_id from disciplines where kind = 'membership' limit 1;
  end if;

  -- ── Loop de créditos por disciplina -- FIX: antes, una entrada mal
  -- formada se salteaba en silencio (bug real: un socio se quedó sin los
  -- créditos de Boxeo de un combo ya aprobado, sin que nadie se enterara).
  -- Ahora cada entrada se valida explícitamente ANTES de acreditar nada del
  -- pack -- discipline_id ausente/inválido, credits ausente/<=0, o una
  -- disciplina repetida dos veces en el mismo array, abortan la función
  -- entera con un mensaje claro. ──────────────────────────────────────────
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
    select
      p_user_id, p_pack_id, v_discipline_id,
      coalesce(
        (select remaining_credits from user_credits
         where user_id = p_user_id and discipline_id = v_discipline_id
         order by created_at desc limit 1),
        0
      ) + v_credits,
      now() + interval '30 days';

    v_total_creditos := v_total_creditos + v_credits;
  end loop;

  -- ── Extensión de Aparatos -- SIN CAMBIOS. ───────────────────────────────
  if v_incluye_aparatos and v_aparatos_discipline_id is not null and v_dias_vigencia is not null and v_dias_vigencia > 0 then
    v_nueva_fecha_vencimiento := greatest(
      coalesce(
        (select expires_at from user_credits
         where user_id = p_user_id and discipline_id = v_aparatos_discipline_id
         order by created_at desc limit 1),
        now()
      ),
      now()
    ) + (v_dias_vigencia || ' days')::interval;

    insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
    values (p_user_id, p_pack_id, v_aparatos_discipline_id, null, v_nueva_fecha_vencimiento);

    v_aparatos_extendido := true;
  end if;

  -- ── Espejo en socios -- SIN CAMBIOS. ────────────────────────────────────
  select dni into v_dni from profiles where id = p_user_id;
  if v_dni is not null then
    update socios
    set creditos = coalesce(creditos, 0) + v_total_creditos,
        fecha_vencimiento = coalesce(
          (v_nueva_fecha_vencimiento at time zone 'America/Argentina/Mendoza')::date,
          fecha_vencimiento
        )
    where dni = v_dni;
  end if;

  return query select
    v_total_creditos,
    v_aparatos_extendido,
    (v_nueva_fecha_vencimiento at time zone 'America/Argentina/Mendoza')::date;
end;
$$;

grant execute on function public.acreditar_pack(uuid, uuid, text, text) to authenticated;

-- ============================================================
-- PASO 2 -- Verificación del fix (correr DESPUÉS de aplicar el PASO 1).
-- Usá packs/socios de prueba, no reales.
-- ============================================================

-- ── Caso NUEVO -- combo de 2 disciplinas de créditos, SIN Aparatos
-- (exactamente el escenario que faltaba probar en la Fase 1 y que
-- reprodujo el bug real) -- tiene que acreditar LAS DOS disciplinas. ──────
-- 1) Buscá o creá un pack de prueba así (ej. vía PlanesPacksCard.jsx en el
--    Admin: "Combo prueba" con 2 filas de créditos, sin tildar Aparatos):
-- select id as pack_id, name, creditos from packs
-- where incluye_aparatos = false and jsonb_array_length(creditos) = 2
-- limit 5;
--
-- 2) Anotá el ANTES de las 2 disciplinas para tu socio de prueba:
-- select discipline_id, remaining_credits from user_credits
-- where user_id = '<USER_ID_PRUEBA>' order by created_at desc limit 10;
--
-- 3) Llamá a la función:
-- select * from public.acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID_COMBO_2_CREDITOS>', 'manual');
--
-- 4) Confirmá que LAS DOS disciplinas subieron, cada una en lo que le
--    correspondía dentro del combo (no solo la primera):
-- select discipline_id, remaining_credits, expires_at, created_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' order by created_at desc limit 10;

-- ── Caso: entrada con discipline_id null -- tiene que RECHAZAR el pack
-- ENTERO (no acreditar ni siquiera las disciplinas válidas) ────────────────
-- 1) Armá un pack de prueba con un jsonb roto a propósito (NO uses un pack
--    real -- creá uno nuevo solo para este test):
-- insert into packs (name, price, creditos, incluye_aparatos, is_active)
-- values ('TEST -- pack roto sin discipline_id', 1,
--   '[{"discipline_id": null, "credits": 5}]'::jsonb, false, false)
-- returning id;
-- 2) select * from public.acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID_DEL_INSERT_ANTERIOR>', 'manual');
-- Tiene que fallar con: "El pack ... tiene una entrada de créditos sin
-- discipline_id válido: ...". Confirmá que NO se insertó nada en
-- user_credits para este intento.
-- 3) Limpieza: delete from packs where id = '<PACK_ID_DEL_INSERT_ANTERIOR>';

-- ── Caso: entrada con credits null/0 -- tiene que RECHAZAR el pack entero ──
-- insert into packs (name, price, creditos, incluye_aparatos, is_active)
-- values ('TEST -- pack roto sin credits', 1,
--   jsonb_build_array(jsonb_build_object('discipline_id', (select id from disciplines where kind='credits' limit 1))),
--   false, false)
-- returning id; -- esta entrada no tiene la clave "credits" en absoluto
-- select * from public.acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID_DEL_INSERT_ANTERIOR>', 'manual');
-- Tiene que fallar con: "... inválida para la disciplina ... (credits=)".
-- delete from packs where id = '<PACK_ID_DEL_INSERT_ANTERIOR>';

-- ── Caso: disciplina repetida dos veces en el mismo pack -- tiene que
-- RECHAZAR el pack entero (antes hubiera duplicado el crédito) ─────────────
-- insert into packs (name, price, creditos, incluye_aparatos, is_active)
-- select 'TEST -- pack con disciplina duplicada', 1,
--   jsonb_build_array(
--     jsonb_build_object('discipline_id', d.id, 'credits', 4),
--     jsonb_build_object('discipline_id', d.id, 'credits', 4)
--   ), false, false
-- from disciplines d where d.kind = 'credits' limit 1
-- returning id;
-- select * from public.acreditar_pack('<USER_ID_PRUEBA>', '<PACK_ID_DEL_INSERT_ANTERIOR>', 'manual');
-- Tiene que fallar con: "... repite la disciplina ... más de una vez ...".
-- delete from packs where id = '<PACK_ID_DEL_INSERT_ANTERIOR>';

-- ── Regresión -- confirmá que los casos YA validados en la Fase 1 (pack de
-- 1 sola disciplina, combo con Aparatos, origen inválido, pack inexistente)
-- siguen dando el mismo resultado que antes -- repetilos tal cual están en
-- supabase_migration_acreditar_pack.sql. ────────────────────────────────────

-- ============================================================
-- PASO 3 -- Corrección manual del socio real afectado.
-- PLANTILLA -- NO CORRER hasta tener confirmados, con el PASO 0, los
-- valores reales: <USER_ID_AFECTADO>, el discipline_id REAL de Boxeo
-- (resuelto en el PASO 0.3), y la cantidad de créditos que le correspondía
-- (probablemente 12, según el nombre del pack -- CONFIRMALO contra
-- packs.creditos ya corregido, no lo asumas del nombre).
--
-- Por qué esto NO es "volver a llamar a acreditar_pack() con el mismo
-- pack_id": eso volvería a acreditar CrossFit una segunda vez (ya la tiene
-- bien) -- acreditar_pack() siempre sirve TODO el pack, no una disciplina
-- suelta. Esto es la MISMA fórmula exacta que un paso del loop ya
-- corregido (mismo INSERT, mismo cálculo de balance, mismo expires_at),
-- aplicada UNA sola vez, solo para la disciplina que faltó -- no es un
-- "ajuste manual aparte" con otra lógica.
-- ============================================================

-- 1) PRIMERO -- corregí packs.creditos para que el combo tenga las 2
--    entradas bien formadas (esto evita que el próximo socio que compre
--    este mismo pack tenga el mismo problema). Confirmá el valor final con
--    un select antes de seguir:
-- update packs set creditos = '<JSONB CORREGIDO, CON LAS 2 ENTRADAS BIEN FORMADAS>'::jsonb
-- where id = 'af47a6c8-f483-4286-9fe4-9a1d1b094027';
-- select creditos from packs where id = 'af47a6c8-f483-4286-9fe4-9a1d1b094027';

-- 2) Acreditación puntual de Boxeo para el socio afectado -- MISMA fórmula
--    que una iteración del loop de acreditar_pack():
-- insert into user_credits (user_id, pack_id, discipline_id, remaining_credits, expires_at)
-- select
--   '<USER_ID_AFECTADO>', 'af47a6c8-f483-4286-9fe4-9a1d1b094027', '<DISCIPLINE_ID_BOXEO_REAL>',
--   coalesce(
--     (select remaining_credits from user_credits
--      where user_id = '<USER_ID_AFECTADO>' and discipline_id = '<DISCIPLINE_ID_BOXEO_REAL>'
--      order by created_at desc limit 1),
--     0
--   ) + <CANTIDAD_DE_CREDITOS_QUE_FALTABAN>,
--   now() + interval '30 days';

-- 3) Espejo a socios -- mismo criterio que acreditar_pack() (sumar sobre
--    socios.creditos, sin tocar fecha_vencimiento porque este combo no
--    incluye Aparatos):
-- select dni into ... -- o directo:
-- update socios set creditos = coalesce(creditos, 0) + <CANTIDAD_DE_CREDITOS_QUE_FALTABAN>
-- where dni = (select dni from profiles where id = '<USER_ID_AFECTADO>');

-- 4) Confirmar el resultado final -- Boxeo y CrossFit tienen que quedar
--    ambos con su balance correcto:
-- select discipline_id, remaining_credits, expires_at from user_credits
-- where user_id = '<USER_ID_AFECTADO>' and pack_id = 'af47a6c8-f483-4286-9fe4-9a1d1b094027'
-- order by created_at desc;
-- select creditos from socios where dni = (select dni from profiles where id = '<USER_ID_AFECTADO>');

-- 5) Avisale al socio -- notificación real, mismo mecanismo que ya usa
--    admin_aprobar_comprobante (opcional pero recomendado, dado el error):
-- insert into notifications (sender_id, audience_type, target_user_id, title, body)
-- values (auth.uid(), 'user', '<USER_ID_AFECTADO>',
--   'Corregimos un error en tu combo',
--   'Detectamos que te habían faltado créditos de Boxeo de tu combo -- ya están acreditados. Disculpá la demora.');
