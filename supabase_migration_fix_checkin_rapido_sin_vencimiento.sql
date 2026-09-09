-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- FIX URGENTE -- pérdida de plata real: el Check-in Rápido del Admin
-- (mostrador) nunca se conectó a esta_habilitado_para_disciplina(), a
-- diferencia de book_class()/admin_book_class() (Fase B) y
-- registrar_hoy_entrene() (ver supabase_migration_esta_habilitado_para_
-- disciplina.sql, que ya lo había dejado documentado como pendiente:
-- "Check-in Rápido... siguen exactamente como están hoy, sin chequear
-- vencimiento. Conectarla es la Fase B..." -- esa Fase B nunca se retomó
-- para este caso puntual). Confirmado por lectura de código (diagnóstico
-- Paso 1, sesión aparte): ni admin_otorgar_checkin_aparatos() ni el
-- trigger award_xp_asistencia() (disparado por darPresenteClase()) miran
-- vencimiento en ningún punto -- un socio vencido o dado de baja podía
-- entrenar gratis y quedar registrado como presente sin que nada lo
-- bloqueara.
--
-- Alcance: SOLO estas 2 funciones. No toca book_class/admin_book_class/
-- cancel_booking/admin_cancel_booking/registrar_hoy_entrene/
-- esta_habilitado_para_disciplina() en sí (ya conectadas, sin cambios).

-- ============================================================
-- FIX 1 -- admin_otorgar_checkin_aparatos(): chequeo ANTES de otorgar el
-- XP de Aparatos. Mismo criterio fail-closed que ya usa book_class().
-- Mismo 1 parámetro de entrada, mismo `returns uuid` -- create or replace
-- alcanza (la función ya vive bajo este nombre desde el rename de la Fase
-- C2, supabase_migration_rename_checkin_aparatos.sql).
-- ============================================================

create or replace function public.admin_otorgar_checkin_aparatos(p_user_id uuid)
returns uuid
language plpgsql
security definer
as $$
declare
  v_discipline_id uuid;
  v_xp_event_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select id into v_discipline_id from disciplines where kind = 'membership' limit 1;
  if v_discipline_id is null then
    raise exception 'No se encontró la disciplina de Musculación/Aparatos.';
  end if;

  -- FIX -- fail-closed, mismo chequeo centralizado que usa el resto del
  -- sistema desde la Fase B/lotes. Si el socio no está habilitado (vencido
  -- o dado de baja), no se acredita nada.
  if not public.esta_habilitado_para_disciplina(p_user_id, v_discipline_id) then
    raise exception 'Este socio no tiene Aparatos vigente -- no se puede dar el check-in.';
  end if;

  insert into xp_events (user_id, event_type, xp_amount, discipline_id, created_by)
  values (p_user_id, 'asistencia', 100, v_discipline_id, auth.uid())
  returning id into v_xp_event_id;

  return v_xp_event_id;
end;
$$;

grant execute on function public.admin_otorgar_checkin_aparatos(uuid) to authenticated;

-- ============================================================
-- FIX 2 -- award_xp_asistencia() (trigger de bookings.attended): chequeo
-- ANTES de otorgar el XP de la clase, SOLO en la rama que ya existía
-- (kind='credits' y attended pasa a true por primera vez).
--
-- DECISIÓN: bloquear la transacción ENTERA (attended queda en false), no
-- "otorgar presente igual pero sin XP". Explicado en el chat aparte, en
-- resumen: dejar attended=true sin XP sería el MISMO bug que estamos
-- cerrando, solo que sin el efecto secundario del XP -- el socio igual
-- quedaría registrado como "entrenó hoy" sin tener nada vigente, que es
-- justo lo que hay que evitar (la pérdida real no es el XP, es dejarlo
-- entrenar). Mismo criterio fail-closed que ya usa book_class() y el FIX 1
-- de acá arriba -- consistencia en todo el sistema. Un `raise exception`
-- en un trigger BEFORE/AFTER aborta la transacción completa del statement
-- que lo disparó (esto es un trigger de Postgres real, no hay forma de
-- "solo frenar una parte") -- darPresenteClase() (greenfit-app/src/lib/
-- fichaSocioPwa.js) ya hace `if (error) throw new Error(error.message)`
-- sobre el UPDATE, así que el mensaje de acá le llega tal cual al caller,
-- y de ahí a CheckInRapidoModal.jsx.
--
-- Este mismo trigger también dispara desde la pantalla "Clases" (marcar
-- attended fila por fila) -- efecto colateral BUSCADO: cierra el mismo
-- hueco de plata en ese otro camino también, no solo en Check-in Rápido.
--
-- Se reemplaza SOLO el body de la función -- el trigger que la ejecuta
-- sobre `bookings` ya existe en la base (CREATE TRIGGER original, no
-- versionado en este repo) y sigue apuntando a la misma función por
-- nombre/OID: create or replace la deja funcionando sin tocar el trigger
-- en sí. Verificación al final para confirmar que sigue enganchado.
-- ============================================================

create or replace function public.award_xp_asistencia()
returns trigger as $$
declare
  v_kind text;
  v_discipline_id uuid;
  v_discipline_name text;
begin
  select d.kind, c.discipline_id, d.name into v_kind, v_discipline_id, v_discipline_name
  from classes c
  join disciplines d on d.id = c.discipline_id
  where c.id = new.class_id;

  if v_kind = 'credits' and new.attended = true and (old.attended is distinct from true) then
    -- FIX -- ver decisión completa en el comentario de arriba: bloquea la
    -- transacción entera si el socio ya no está habilitado.
    if not public.esta_habilitado_para_disciplina(new.user_id, v_discipline_id) then
      raise exception 'Este socio no está habilitado para % -- no se le puede dar el check-in de esta clase (vencimiento o créditos agotados).', v_discipline_name;
    end if;

    insert into xp_events (user_id, event_type, xp_amount, reference_id, discipline_id, created_by)
    values (new.user_id, 'asistencia', 100, new.id, v_discipline_id, auth.uid())
    on conflict do nothing;
  elsif new.attended is distinct from true and old.attended = true then
    -- Si el admin corrige una asistencia mal marcada, se revierte el XP.
    delete from xp_events where reference_id = new.id and event_type = 'asistencia';
  end if;

  return new;
end;
$$ language plpgsql security definer;

-- ============================================================
-- PASO PREVIO -- Query de impacto (NO ejecuta nada, solo lee). Corré esto
-- ANTES de aplicar el fix de arriba para dimensionar el problema real: si
-- hoy alguien intentara Check-in Rápido / Dar Presente sobre un socio que
-- ya no está habilitado, ¿cuántos casos hay en las reservas/check-ins de
-- HOY?
-- ============================================================

-- Reservas de HOY cuyo socio YA NO está habilitado para la disciplina de
-- esa clase (candidatos reales a "Dar Presente" que este fix bloquearía):
-- select
--   b.id as booking_id,
--   p.full_name,
--   p.dni,
--   d.name as disciplina,
--   c.title as clase,
--   b.attended,
--   esta_habilitado_para_disciplina(b.user_id, d.id) as habilitado_hoy
-- from bookings b
-- join classes c on c.id = b.class_id
-- join disciplines d on d.id = c.discipline_id
-- join profiles p on p.id = b.user_id
-- where b.booking_date = current_date
--   and esta_habilitado_para_disciplina(b.user_id, d.id) = false
-- order by p.full_name;

-- Todos los socios con cuenta PWA que NO están habilitados hoy para
-- Aparatos (candidatos reales al camino "buscar por nombre/DNI -> Otorgar"
-- del Check-in Rápido -- no está atado a una reserva puntual, así que se
-- mira aparte, sobre TODO el universo de socios, no solo los de hoy):
-- select
--   p.full_name,
--   p.dni,
--   s.activo,
--   s.fecha_vencimiento,
--   esta_habilitado_para_disciplina(p.id, (select id from disciplines where kind = 'membership' limit 1)) as habilitado_aparatos
-- from profiles p
-- join socios s on s.dni = p.dni
-- where p.role = 'socio'
--   and esta_habilitado_para_disciplina(p.id, (select id from disciplines where kind = 'membership' limit 1)) = false
-- order by p.full_name;

-- ============================================================
-- Verificación (NO CONECTADA a la UI real todavía en este script -- correr
-- después de aplicar, con un socio y una clase de PRUEBA).
-- ============================================================

-- ── Caso A: socio HABILITADO -- check-in normal, sin cambios de comportamiento ──
-- select admin_otorgar_checkin_aparatos('<USER_ID_SOCIO_CON_APARATOS_VIGENTE>');
-- Tiene que devolver el id del xp_event nuevo, igual que siempre.

-- ── Caso B: socio con Aparatos VENCIDO (o dado de baja) -- Otorgar falla con el mensaje ──
-- select admin_otorgar_checkin_aparatos('<USER_ID_SOCIO_CON_APARATOS_VENCIDO>');
-- Tiene que tirar: "Este socio no tiene Aparatos vigente -- no se puede dar el check-in."
-- select count(*) from xp_events where user_id = '<ESE_USER_ID>' and created_at > now() - interval '1 minute';
-- Tiene que dar 0 -- no se insertó nada.

-- ── Caso C: socio con CRÉDITOS vencidos/agotados de una disciplina grupal
-- intentando "Dar Presente" en una clase de esa disciplina -- falla, sin XP ──
-- 1) Con una reserva real de HOY de ese socio para una clase de esa
--    disciplina (booking_id conocido):
-- update bookings set attended = true where id = '<BOOKING_ID_SOCIO_SIN_CREDITOS>';
-- Tiene que tirar: "Este socio no está habilitado para <disciplina> -- no
-- se le puede dar el check-in de esta clase (vencimiento o créditos agotados)."
-- 2) Confirmá que la reserva NO quedó marcada (la excepción abortó el UPDATE):
-- select attended from bookings where id = '<BOOKING_ID_SOCIO_SIN_CREDITOS>';
-- Tiene que seguir en false.
-- 3) Y que no se insertó XP:
-- select count(*) from xp_events where reference_id = '<BOOKING_ID_SOCIO_SIN_CREDITOS>';
-- Tiene que dar 0.

-- ── Caso D: regresión -- socio habilitado marcando presente en una clase
-- real sigue funcionando igual que siempre ──
-- update bookings set attended = true where id = '<BOOKING_ID_SOCIO_HABILITADO>';
-- Tiene que actualizar sin error.
-- select count(*) from xp_events where reference_id = '<BOOKING_ID_SOCIO_HABILITADO>';
-- Tiene que dar 1 (los +100 XP de siempre).

-- ── Caso E: confirmar que el trigger sigue enganchado a bookings después
-- del create or replace (no hace falta recrearlo, pero confirmá) ──
-- select tgname, tgrelid::regclass, tgenabled
-- from pg_trigger
-- where tgfoid = 'public.award_xp_asistencia()'::regprocedure;
-- Tiene que devolver la fila del trigger sobre la tabla bookings, tgenabled = 'O' (habilitado).
