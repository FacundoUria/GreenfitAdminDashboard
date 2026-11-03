-- =====================================================================================
-- ROLLBACK de supabase_migration_t5_copiador_sin_filas.sql. NO SE CORRIÓ.
--
-- ORDEN: primero volver el Admin a la versión anterior (o al menos no usar "Pendientes de
-- cargar"); si no, el cartel va a mostrar en rojo que la función no existe.
--
-- 1) sync_my_membership vuelve a su definición EXACTA de producción (exportación del 23/10,
--    funciones_user_credits_produccion_23-10.txt, igual a q0a_definiciones_produccion.sql).
--    Ese texto da exactamente la huella de producción ee1078d5b710d23d521b5f7a5809f941
--    (verificado byte a byte con este archivo en LF). Como git o el editor pueden cambiar los
--    finales de línea (CRLF), la verificación dura es la huella SIN espacios
--    (a687dfc7adb98876ed9e4b32d16431fb); la exacta se muestra en un NOTICE. OJO: con esto el
--    copiador vuelve a crear filas en cada login.
-- 2) admin_socios_pendientes_de_cargar() se borra (la creó T5; solo lectura, no tiene datos).
--
-- Solo funciones: ningún UPDATE/DELETE/INSERT de datos.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) ANTES: sync_my_membership tiene que ser la versión T5 (huella sin espacios
--      c0f419ee224ba56ca38f1ac3895a43f5) con los permisos de producción, y
--      admin_socios_pendientes_de_cargar() la versión T5 (sin espacios 9d21d616161c42cb27e711fbe75b2a20).
--      Si alguien las cambió después de T5, se frena: no se pisa un cambio que no conocemos.
--   2) DESPUÉS: huella sin espacios = a687dfc7adb98876ed9e4b32d16431fb (la de producción), VOLATILE,
--      permisos EXACTAMENTE iguales (create or replace los conserva: no hay grant), y la función
--      nueva ya no existe.
-- =====================================================================================

begin;

do $guarda$
begin
  if md5(regexp_replace(pg_get_functiondef('public.sync_my_membership()'::regprocedure), '\s+', '', 'g')) <> 'c0f419ee224ba56ca38f1ac3895a43f5' then
    raise exception 'Rollback T5: sync_my_membership no es la versión T5 (cambió su huella). No se aplicó nada.';
  end if;
  if (select coalesce(proacl::text, '(por defecto)') from pg_proc where oid = 'public.sync_my_membership()'::regprocedure)
     <> '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' then
    raise exception 'Rollback T5: los permisos de sync_my_membership no son los de producción. No se aplicó nada.';
  end if;
  if to_regprocedure('public.admin_socios_pendientes_de_cargar()') is null then
    raise exception 'Rollback T5: admin_socios_pendientes_de_cargar() no existe -- T5 no está aplicada. No se aplicó nada.';
  end if;
  if md5(regexp_replace(pg_get_functiondef('public.admin_socios_pendientes_de_cargar()'::regprocedure), '\s+', '', 'g')) <> '9d21d616161c42cb27e711fbe75b2a20' then
    raise exception 'Rollback T5: admin_socios_pendientes_de_cargar() no es la versión T5 (cambió su huella). No se aplicó nada.';
  end if;
end;
$guarda$;

create temp table _t5_rb_permisos_antes on commit drop as
select coalesce(proacl::text, '(por defecto)') as permisos
from pg_proc
where oid = 'public.sync_my_membership()'::regprocedure;

-- ── sync_my_membership (producción 23/10, textual) ──
CREATE OR REPLACE FUNCTION public.sync_my_membership()
 RETURNS TABLE(vinculado boolean, sincronizados integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_dni text;
  v_socio record;
  v_plan text;
  v_discipline_id uuid;
  v_discipline_kind text;
  v_ya_existe boolean;
  v_estado_activo boolean;
  v_insertados integer := 0;
begin
  if v_user_id is null then
    return query select false, 0;
    return;
  end if;

  select dni into v_dni from profiles where id = v_user_id;
  if v_dni is null then
    return query select false, 0;
    return;
  end if;

  select * into v_socio from socios where dni = v_dni;
  if not found then
    -- El profile existe pero no matchea ninguna ficha de socio -- esto es lo
    -- que la PWA debe loguear como advertencia (DNI huérfano).
    return query select false, 0;
    return;
  end if;

  if v_socio.activo is false then
    return query select true, 0;
    return;
  end if;

  v_estado_activo := lower(coalesce(v_socio.estado, '')) = 'activo';

  foreach v_plan in array coalesce(v_socio.plan, array[]::text[])
  loop
    v_discipline_id := null;
    v_discipline_kind := null;

    -- Primero se intenta resolver el texto libre contra una disciplina real
    -- (soporta cualquier disciplina creada dinámicamente desde el admin, no
    -- solo las 3 originales). Si no matchea ninguna (ej: "Pase Libre",
    -- "Aparatos / Musculación", texto legacy), se asume que es la membresía
    -- genérica de acceso libre -- mismo criterio que ya usa
    -- sincronizarVencimientoPwa en el panel admin.
    select id, kind into v_discipline_id, v_discipline_kind
    from disciplines where name ilike v_plan and is_active = true limit 1;

    if v_discipline_id is null then
      select id, kind into v_discipline_id, v_discipline_kind
      from disciplines where kind = 'membership' and is_active = true limit 1;
    end if;

    if v_discipline_id is null then
      continue;
    end if;

    select exists(
      select 1 from user_credits where user_id = v_user_id and discipline_id = v_discipline_id
    ) into v_ya_existe;

    -- Nunca pisa un balance que ya existe -- podría reflejar consumo real
    -- hecho desde la PWA. Solo se completan huecos genuinos (cero filas),
    -- que es exactamente el caso de un socio que nunca se sincronizó.
    if v_ya_existe then
      continue;
    end if;

    if v_discipline_kind = 'membership' then
      if v_socio.fecha_vencimiento is not null then
        insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
        values (v_user_id, v_discipline_id, null, (v_socio.fecha_vencimiento::text || 'T12:00:00')::timestamptz);
        v_insertados := v_insertados + 1;
      end if;
    else
      if coalesce(v_socio.creditos, 0) > 0 or v_estado_activo then
        insert into user_credits (user_id, discipline_id, remaining_credits, expires_at)
        values (v_user_id, v_discipline_id, coalesce(v_socio.creditos, 0), now() + interval '30 days');
        v_insertados := v_insertados + 1;
      end if;
    end if;
  end loop;

  return query select true, v_insertados;
end;
$function$
;

-- ── admin_socios_pendientes_de_cargar (la creó T5) ──
drop function public.admin_socios_pendientes_de_cargar();

-- ── Verificación DESPUÉS ──
do $verifica$
begin
  if md5(regexp_replace(pg_get_functiondef('public.sync_my_membership()'::regprocedure), '\s+', '', 'g')) <> 'a687dfc7adb98876ed9e4b32d16431fb' then
    raise exception 'Rollback T5: sync_my_membership no volvió a la versión de producción (huella sin espacios %). No se aplicó nada.',
      md5(regexp_replace(pg_get_functiondef('public.sync_my_membership()'::regprocedure), '\s+', '', 'g'));
  end if;
  if (select provolatile from pg_proc where oid = 'public.sync_my_membership()'::regprocedure) <> 'v' then
    raise exception 'Rollback T5: sync_my_membership no volvió a VOLATILE. No se aplicó nada.';
  end if;
  if (select coalesce(proacl::text, '(por defecto)') from pg_proc where oid = 'public.sync_my_membership()'::regprocedure)
     is distinct from (select permisos from _t5_rb_permisos_antes) then
    raise exception 'Rollback T5: cambiaron los permisos de sync_my_membership. No se aplicó nada.';
  end if;
  if to_regprocedure('public.admin_socios_pendientes_de_cargar()') is not null then
    raise exception 'Rollback T5: admin_socios_pendientes_de_cargar() sigue existiendo. No se aplicó nada.';
  end if;
  raise notice 'Rollback T5 aplicado: sync_my_membership volvió a la versión de producción. Huella exacta: % (la del 23/10 es ee1078d5b710d23d521b5f7a5809f941).',
    md5(pg_get_functiondef('public.sync_my_membership()'::regprocedure));
end;
$verifica$;

commit;
