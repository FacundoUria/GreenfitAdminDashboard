-- =====================================================================================
-- T5 -- el copiador (sync_my_membership) deja de crear filas en user_credits, y una función
-- nueva de solo lectura, admin_socios_pendientes_de_cargar(), para la lista "Pendientes de
-- cargar" del Admin. NO SE CORRIÓ TODAVÍA. ESTAMOS EN PRODUCCIÓN.
--
-- 1) sync_my_membership() -- MISMA firma y MISMA respuesta (vinculado, sincronizados), así la
--    PWA no cambia. Antes copiaba la ficha (socios) a user_credits en cada login: el total de
--    créditos de la ficha en CADA disciplina del plan, a now() + 30 días desde el login, y
--    Aparatos hasta las 09:00 del día de la ficha. Rompía R1 y la regla E. Ahora:
--      * sin sesión, sin DNI en el perfil o DNI sin ficha -> (false, 0)   [igual que antes]
--      * DNI con ficha (activa o dada de baja)             -> (true, 0)    [igual que antes]
--      * sincronizados es SIEMPRE 0: no escribe nada.
--    Se declara STABLE: Postgres no deja hacer INSERT/UPDATE/DELETE dentro de una función
--    STABLE, así que si alguien vuelve a meter una escritura, falla en vez de escribir.
--    Las filas que el copiador ya creó NO se borran (se quedan como están).
--
-- 2) admin_socios_pendientes_de_cargar() -- NUEVA, solo lectura, solo admin (is_admin()).
--    Socios que: tienen cuenta (profiles.dni = socios.dni), no están dados de baja, la ficha
--    tiene fecha vigente (fecha_vencimiento >= hoy en Argentina), el último cobro es reciente
--    (ultimo_pago >= hoy - 35, en Argentina; D-T5e) y en user_credits no tienen NADA vigente
--    (ninguna fila con expires_at > now(), ni siquiera un lote en 0).
--    Permisos (D-T5f): sin public ni anon; authenticated y service_role sí.
--
-- Solo crea o reemplaza funciones. Ningún UPDATE/DELETE/INSERT sobre datos. La tabla temporal
-- de abajo es solo para comparar permisos y se borra sola al terminar la transacción.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) sync_my_membership tiene que ser EXACTAMENTE la versión de producción conocida:
--      md5(pg_get_functiondef) = ee1078d5b710d23d521b5f7a5809f941 (confirmada el 03/11).
--   2) Sus permisos tienen que ser los de producción (confirmados el 03/11):
--      {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--      y quedar EXACTAMENTE iguales después. create or replace los conserva: no hay grant.
--   3) admin_socios_pendientes_de_cargar() no tiene que existir todavía (no se pisa nada
--      desconocido), y socios.id tiene que ser integer o bigint (la función lo devuelve bigint).
--   4) DESPUÉS: sync_my_membership con la huella T5 (sin espacios), STABLE, SECURITY DEFINER,
--      sin insert/update/delete en el cuerpo; la función nueva sin permiso para anon ni public.
--
-- Huellas de la versión T5 de sync_my_membership (calculadas sobre el texto de abajo):
--   sin espacios: md5(regexp_replace(pg_get_functiondef(...), '\s+', '', 'g')) = c0f419ee224ba56ca38f1ac3895a43f5
--   exacta (informativa, se muestra en un NOTICE):                             = 2c11980c90788297b68fce518a23272f
--
-- Prueba: prueba_t5.sql (se corre DESPUÉS de esta migración: todo OK).
-- Rollback: rollback_t5.sql.
-- =====================================================================================

begin;

-- ── Guardas 1, 2 y 3 ──────────────────────────────────────────────────────────────────
do $guarda$
declare
  v_tipo_id text;
begin
  if md5(pg_get_functiondef('public.sync_my_membership()'::regprocedure)) <> 'ee1078d5b710d23d521b5f7a5809f941' then
    raise exception 'T5: sync_my_membership no es la versión de producción (cambió su huella). No se aplicó nada.';
  end if;

  if (select coalesce(proacl::text, '(por defecto)') from pg_proc where oid = 'public.sync_my_membership()'::regprocedure)
     <> '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' then
    raise exception 'T5: los permisos de sync_my_membership no son los de producción. No se aplicó nada.';
  end if;

  if to_regprocedure('public.admin_socios_pendientes_de_cargar()') is not null then
    raise exception 'T5: admin_socios_pendientes_de_cargar() ya existe -- no se pisa una función que no conocemos. No se aplicó nada.';
  end if;

  select format_type(a.atttypid, a.atttypmod) into v_tipo_id
  from pg_attribute a
  where a.attrelid = 'public.socios'::regclass and a.attname = 'id' and not a.attisdropped;
  if v_tipo_id is null or v_tipo_id not in ('integer', 'bigint') then
    raise exception 'T5: socios.id es de tipo % (se esperaba integer o bigint). No se aplicó nada.', coalesce(v_tipo_id, '?');
  end if;
end;
$guarda$;

create temp table _t5_permisos_antes on commit drop as
select coalesce(proacl::text, '(por defecto)') as permisos
from pg_proc
where oid = 'public.sync_my_membership()'::regprocedure;

-- ── 1) sync_my_membership: ya no crea filas ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_my_membership()
 RETURNS TABLE(vinculado boolean, sincronizados integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_dni text;
begin
  -- T5 (regla E): ya no crea filas en user_credits. Créditos y fechas solo por un pago o por
  -- carga manual de Seba. Solo informa si el DNI del perfil matchea una ficha en socios.
  if v_user_id is null then
    return query select false, 0;
    return;
  end if;

  select dni into v_dni from profiles where id = v_user_id;
  if v_dni is null then
    return query select false, 0;
    return;
  end if;

  return query select exists (select 1 from socios where dni = v_dni), 0;
end;
$function$
;

-- ── 2) admin_socios_pendientes_de_cargar: nueva, solo lectura ────────────────────────
CREATE FUNCTION public.admin_socios_pendientes_de_cargar()
 RETURNS TABLE(socio_id bigint, nombre text, apellido text, dni text, plan text[], creditos_ficha integer, fecha_vencimiento_ficha date, ultimo_pago date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c_zona constant text := 'America/Argentina/Mendoza';
  v_hoy date := (now() at time zone c_zona)::date;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.' using errcode = '42501';
  end if;

  -- Cobró sin cuenta (o la cuenta llegó después) y en la app no tiene nada vigente.
  return query
  select s.id::bigint,
         s.nombre::text,
         s.apellido::text,
         s.dni::text,
         s.plan,
         s.creditos::integer,
         s.fecha_vencimiento::date,
         s.ultimo_pago::date
  from socios s
  where s.activo is not false
    and s.fecha_vencimiento::date >= v_hoy
    and s.ultimo_pago::date >= v_hoy - 35
    and exists (select 1 from profiles p where p.dni = s.dni)
    and not exists (
      select 1
      from profiles p
      join user_credits uc on uc.user_id = p.id
      where p.dni = s.dni
        and uc.expires_at > now()
    )
  order by s.ultimo_pago::date desc, s.id;
end;
$function$
;

revoke all on function public.admin_socios_pendientes_de_cargar() from public;
revoke all on function public.admin_socios_pendientes_de_cargar() from anon;
grant execute on function public.admin_socios_pendientes_de_cargar() to authenticated;
grant execute on function public.admin_socios_pendientes_de_cargar() to service_role;

-- ── Guarda 4: verificación DESPUÉS ────────────────────────────────────────────────────
do $verifica$
declare
  v_def text := pg_get_functiondef('public.sync_my_membership()'::regprocedure);
  v_p record;
  v_acl_nueva text;
begin
  if md5(regexp_replace(v_def, '\s+', '', 'g')) <> 'c0f419ee224ba56ca38f1ac3895a43f5' then
    raise exception 'T5: sync_my_membership no quedó con la huella T5 (sin espacios: %). No se aplicó nada.',
      md5(regexp_replace(v_def, '\s+', '', 'g'));
  end if;

  select provolatile, prosecdef, prosrc into v_p
  from pg_proc where oid = 'public.sync_my_membership()'::regprocedure;
  if v_p.provolatile <> 's' or not v_p.prosecdef then
    raise exception 'T5: sync_my_membership no quedó STABLE + SECURITY DEFINER. No se aplicó nada.';
  end if;
  if v_p.prosrc ~* '\m(insert|update|delete)\M' then
    raise exception 'T5: sync_my_membership todavía tiene una escritura en el cuerpo. No se aplicó nada.';
  end if;

  if (select coalesce(proacl::text, '(por defecto)') from pg_proc where oid = 'public.sync_my_membership()'::regprocedure)
     is distinct from (select permisos from _t5_permisos_antes) then
    raise exception 'T5: cambiaron los permisos de sync_my_membership. No se aplicó nada.';
  end if;

  select coalesce(proacl::text, '(por defecto)') into v_acl_nueva
  from pg_proc where oid = 'public.admin_socios_pendientes_de_cargar()'::regprocedure;
  if v_acl_nueva = '(por defecto)' or v_acl_nueva ~ '(^|[{,])=' or v_acl_nueva ~ '(^|[{,])anon=' then
    raise exception 'T5: admin_socios_pendientes_de_cargar quedó ejecutable por public o anon (%). No se aplicó nada.', v_acl_nueva;
  end if;
  if v_acl_nueva !~ '(^|[{,])authenticated=X' then
    raise exception 'T5: admin_socios_pendientes_de_cargar no quedó ejecutable por authenticated (%). No se aplicó nada.', v_acl_nueva;
  end if;

  raise notice 'T5 aplicada. Huella exacta nueva de sync_my_membership: % (esperada 2c11980c90788297b68fce518a23272f). Permisos de la función nueva: %',
    md5(v_def), v_acl_nueva;
end;
$verifica$;

commit;

-- Después de correrla (solo lectura):
--   select md5(pg_get_functiondef('public.sync_my_membership()'::regprocedure));
--   select proacl from pg_proc where oid = 'public.admin_socios_pendientes_de_cargar()'::regprocedure;
--   + la foto de planes activos de PLAN_TANDAS.md: tiene que dar igual que antes.
