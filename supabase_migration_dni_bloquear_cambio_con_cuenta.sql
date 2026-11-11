-- =====================================================================================
-- DNI-C -- No se puede cambiar el DNI de un socio que ya tiene cuenta en la app.
-- Corrida en producción el 10/11/2026 (aplicada, revertida con el rollback por error y vuelta a
-- aplicar el mismo día; prueba 8 OK, prueba de siempre 19 OK).
--
-- Por qué: handle_socio_dni_upsert() (trigger on_socio_dni_upsert) pide una cuenta nueva
-- `<dni>@greenfit.com` cada vez que el DNI cambia a uno válido. Corregir el DNI de alguien que
-- ya tiene cuenta deja esa cuenta (créditos, reservas, XP, pagos) huérfana y crea otra vacía:
-- el Admin vincula socio y cuenta SOLO por profiles.dni = socios.dni. En vez de mover la cuenta
-- (eso escribiría en auth.users/auth.identities, descartado), la base RECHAZA el cambio:
--
--   UPDATE que cambia el DNI de un socio cuyo DNI ACTUAL tiene cuenta (hay un profile con ese
--   dni) -> error 'Este socio ya tiene cuenta en la app. Para corregir el DNI avisale a Facundo.'
--   (constraint 'socios_dni_con_cuenta'). El Admin muestra el mensaje tal cual.
--   Sin cuenta -> todo igual que hoy (INSERT y cambio de DNI exigen DNI válido; UPDATE sin cambio
--   de DNI no valida nada).
--
-- Va en validar_dni_socio() (trigger socios_validar_dni, BEFORE INSERT OR UPDATE): rechaza antes
-- de que se guarde nada y antes de que on_socio_dni_upsert pida una cuenta.
--
-- Único cambio de atributos: la función pasa a SECURITY DEFINER. Motivo: tiene que VER el profile
-- del DNI actual aunque quien guarda no pueda leer profiles por RLS; si no lo ve, la guarda pasa
-- en silencio y vuelve a pasar lo de siempre. Es una función de trigger (returns trigger): nadie
-- la puede llamar por RPC ni a mano, solo el trigger. search_path fijo en public (ya lo tenía).
-- Los permisos (proacl) quedan EXACTAMENTE iguales (create or replace los conserva; guarda G4).
--
-- Guardas (si alguna falla, no se aplica nada):
--   G1) La huella sin espacios de validar_dni_socio() es 79a0cb0ff4c758de7c0c3aff8ef03359
--       (diagnóstico del 10/11/2026: la de producción, que ya saltea los UPDATE sin cambio).
--   G2) El trigger socios_validar_dni existe, está activo, es BEFORE INSERT OR UPDATE y la llama.
--   G3) profiles tiene la columna dni.
--   G4) DESPUÉS: permisos iguales a los de antes, SECURITY DEFINER, search_path=public, la
--       función tiene el mensaje nuevo y sigue salteando los UPDATE sin cambio de DNI; el
--       trigger sigue igual.
--
-- Respaldo: guarda la definición anterior en respaldo.funciones (tanda 'DNI-C'; esquema no
-- expuesto por la API).
-- Prueba:   prueba_dni_bloquear_cambio_con_cuenta.sql (DESPUÉS de esta migración: todo OK),
--           y además prueba_socios_dni_obligatorio.sql (actualizada: casos 7 y 8 usan socios
--           sin cuenta).
-- Rollback: rollback_dni_bloquear_cambio_con_cuenta.sql.
-- =====================================================================================

begin;

create temp table _antes_dni_c on commit drop as
select coalesce(proacl::text, '(por defecto)') as acl
from pg_proc where oid = to_regprocedure('public.validar_dni_socio()');

do $guarda$
declare
  v_huella text;
begin
  if to_regprocedure('public.validar_dni_socio()') is null then
    raise exception 'DNI-C: no existe validar_dni_socio(). No se aplicó nada.';
  end if;

  v_huella := md5(regexp_replace(pg_get_functiondef('public.validar_dni_socio()'::regprocedure), '\s+', '', 'g'));
  if v_huella <> '79a0cb0ff4c758de7c0c3aff8ef03359' then
    raise exception 'DNI-C: validar_dni_socio() no es la versión de producción conocida (huella %). No se aplicó nada.', v_huella;
  end if;

  if not exists (
    select 1 from pg_trigger t
    where t.tgname = 'socios_validar_dni' and t.tgrelid = 'public.socios'::regclass and not t.tgisinternal
      and t.tgfoid = 'public.validar_dni_socio()'::regprocedure
      and t.tgenabled = 'O' and t.tgtype & 2 = 2 and t.tgtype & 4 = 4 and t.tgtype & 16 = 16
  ) then
    raise exception 'DNI-C: socios_validar_dni no es un trigger activo BEFORE INSERT OR UPDATE sobre validar_dni_socio(). No se aplicó nada.';
  end if;

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.profiles'::regclass and attname = 'dni' and not attisdropped
  ) then
    raise exception 'DNI-C: profiles no tiene la columna dni. No se aplicó nada.';
  end if;
end;
$guarda$;

-- ── Respaldo de la versión actual (lo usa el rollback) ──────────────────────────────
create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

create table if not exists respaldo.funciones (
  id bigserial primary key,
  tanda text not null,
  funcion text not null,
  definicion text not null,
  guardado_en timestamptz not null default now()
);

insert into respaldo.funciones (tanda, funcion, definicion)
values ('DNI-C', 'public.validar_dni_socio()', pg_get_functiondef('public.validar_dni_socio()'::regprocedure));

-- ── Versión nueva ───────────────────────────────────────────────────────────────────
create or replace function public.validar_dni_socio()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- En UPDATE, si el DNI no cambia no se valida: los socios históricos sin
  -- DNI válido se tienen que poder seguir editando (créditos, vencimiento,
  -- baja, teléfono, cobro) hasta que se les cargue el DNI a mano.
  if TG_OP = 'UPDATE' and NEW.dni is not distinct from OLD.dni then
    return NEW;
  end if;

  -- DNI-C: si el DNI ACTUAL ya tiene cuenta en la app, no se cambia. Cambiarlo
  -- dejaría esa cuenta huérfana y on_socio_dni_upsert crearía otra vacía.
  if TG_OP = 'UPDATE' and OLD.dni is not null
     and exists (select 1 from public.profiles p where p.dni = OLD.dni) then
    raise exception 'Este socio ya tiene cuenta en la app. Para corregir el DNI avisale a Facundo.'
      using errcode = '23514', constraint = 'socios_dni_con_cuenta';
  end if;

  if NEW.dni is null or NEW.dni !~ '^\d{6,10}$' then
    raise exception 'El DNI del socio es obligatorio y tiene que tener entre 6 y 10 dígitos, sin puntos ni espacios (recibido: %).',
      coalesce('"' || NEW.dni || '"', 'vacío')
      using errcode = '23514', constraint = 'socios_dni_valido';
  end if;

  return NEW;
end;
$$;

-- ── G4: después ─────────────────────────────────────────────────────────────────────
do $despues$
declare
  v_def text := pg_get_functiondef('public.validar_dni_socio()'::regprocedure);
  v_p record;
begin
  select p.prosecdef, coalesce(p.proacl::text, '(por defecto)') as acl, p.proconfig
    into v_p
  from pg_proc p where p.oid = 'public.validar_dni_socio()'::regprocedure;

  if v_p.acl <> (select acl from _antes_dni_c) then
    raise exception 'DNI-C: cambiaron los permisos de validar_dni_socio() (antes %, ahora %). Se deshace todo.',
      (select acl from _antes_dni_c), v_p.acl;
  end if;
  if not v_p.prosecdef then
    raise exception 'DNI-C: la función no quedó SECURITY DEFINER. Se deshace todo.';
  end if;
  if v_p.proconfig is distinct from array['search_path=public'] then
    raise exception 'DNI-C: search_path de la función es % (se esperaba search_path=public). Se deshace todo.', v_p.proconfig;
  end if;
  if position('socios_dni_con_cuenta' in v_def) = 0
     or position('isnotdistinctfrom' in lower(regexp_replace(v_def, '\s+', '', 'g'))) = 0 then
    raise exception 'DNI-C: la función nueva no quedó aplicada como se esperaba. Se deshace todo.';
  end if;
  if not exists (
    select 1 from pg_trigger t
    where t.tgname = 'socios_validar_dni' and t.tgrelid = 'public.socios'::regclass
      and t.tgfoid = 'public.validar_dni_socio()'::regprocedure
      and t.tgenabled = 'O' and t.tgtype & 2 = 2 and t.tgtype & 4 = 4 and t.tgtype & 16 = 16
  ) then
    raise exception 'DNI-C: el trigger socios_validar_dni cambió. Se deshace todo.';
  end if;

  raise notice 'DNI-C aplicada. Huella nueva (sin espacios): %', md5(regexp_replace(v_def, '\s+', '', 'g'));
end;
$despues$;

commit;
