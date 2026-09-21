-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- CONTEXTO: "Cancelar" en el panel de Clases hacía un DELETE directo sobre
-- `classes` -- borraba la plantilla recurrente ENTERA (todos los días que
-- tiene programados, para siempre) y además fallaba con un error genérico
-- si había cualquier reserva asociada (foreign key de `bookings`, sin
-- cascade -- ver investigacion_cancelar_clase_prueba_fk.sql). Lo que
-- necesita Seba es cancelar la OCURRENCIA de un día puntual ("hoy no puedo
-- dar la clase"), sin tocar el resto de la semana, reintegrando el crédito
-- a todos los anotados de ese día y avisándoles.
--
-- DISEÑO (confirmado): `classes` NO se toca nunca desde este flujo -- ni
-- se borra ni se edita. Se agrega:
--   1) class_occurrence_cancellations -- tabla chica (class_id + fecha) que
--      marca "esta clase no se dicta este día puntual".
--   2) admin_cancelar_clase_dia() -- RPC nuevo que reusa admin_cancel_
--      booking() (CON p_forzar_reintegro=true, en loop) para cada socio
--      anotado ese día, y le inserta una notificación individual.
--   3) Guard idéntico en book_class()/admin_book_class() -- no se puede
--      reservar una ocurrencia ya cancelada.
--
-- NO TOCA admin_cancel_booking(), cancel_booking(), acreditar_pack(),
-- admin_acreditar_creditos_manual() -- todo esto se REUSA, nada se
-- modifica (ver el CASO de verificación al final que compara los cuerpos
-- antes/después).

-- ============================================================
-- 1) class_occurrence_cancellations
-- ============================================================
create table if not exists class_occurrence_cancellations (
  id uuid primary key default uuid_generate_v4(),
  class_id uuid not null references classes(id) on delete cascade,
  occurrence_date date not null,
  cancelled_by uuid references profiles(id),
  created_at timestamptz default now(),
  unique (class_id, occurrence_date)
);

create index if not exists idx_class_occurrence_cancellations_lookup
  on class_occurrence_cancellations(class_id, occurrence_date);

alter table class_occurrence_cancellations enable row level security;

-- SELECT abierto a cualquier autenticado -- lo necesitan Admin (armar la
-- grilla) Y la PWA (excluir la ocurrencia de la Agenda de CUALQUIER socio,
-- no solo los que estaban anotados). Mismo criterio que "classes_select_all".
drop policy if exists "class_occurrence_cancellations_select_all" on class_occurrence_cancellations;
create policy "class_occurrence_cancellations_select_all" on class_occurrence_cancellations
  for select using (auth.role() = 'authenticated');

-- Escritura solo admin -- mismo criterio que "classes_admin_write".
drop policy if exists "class_occurrence_cancellations_admin_write" on class_occurrence_cancellations;
create policy "class_occurrence_cancellations_admin_write" on class_occurrence_cancellations
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 2) admin_cancelar_clase_dia() -- cancela TODAS las reservas de una clase
-- para una fecha puntual, reintegrando siempre (mismo criterio que "Quitar
-- de la clase"), y marca la ocurrencia como cancelada.
-- ============================================================
create or replace function public.admin_cancelar_clase_dia(
  p_class_id uuid,
  p_occurrence_date date
)
returns int
language plpgsql
security definer
as $$
declare
  v_admin_id uuid := auth.uid();
  v_titulo_clase text;
  v_hora_inicio time;
  v_user_ids uuid[];
  v_user_id uuid;
  v_cancelados int := 0;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select title, start_time into v_titulo_clase, v_hora_inicio
  from classes where id = p_class_id;
  if v_titulo_clase is null then
    raise exception 'No existe esa clase.';
  end if;

  -- Idempotente -- si ya estaba cancelada (ej. doble click, o el admin la
  -- vuelve a tocar por error), no rompe -- solo actualiza quién la tocó.
  -- Para ese momento ya no debería haber bookings que cancelar (el loop de
  -- abajo simplemente no encuentra nada), así que reintentar es inofensivo.
  insert into class_occurrence_cancellations (class_id, occurrence_date, cancelled_by)
  values (p_class_id, p_occurrence_date, v_admin_id)
  on conflict (class_id, occurrence_date) do update
    set cancelled_by = excluded.cancelled_by;

  -- Materializado en un array ANTES de cancelar -- admin_cancel_booking()
  -- borra de `bookings` en cada vuelta del loop; re-consultar la tabla
  -- mientras se está vaciando (en vez de un array fijo de antemano) es
  -- justo el tipo de bug sutil que ya pasó una vez en este proyecto (ver
  -- supabase_migration_fix_admin_cancel_booking_lote_exacto.sql).
  select array_agg(user_id) into v_user_ids
  from bookings
  where class_id = p_class_id and booking_date = p_occurrence_date;

  if v_user_ids is not null then
    foreach v_user_id in array v_user_ids loop
      -- Mismo criterio que "Quitar de la clase" (InscriptosModal.jsx): es
      -- el gimnasio el que cancela, no el socio -- reintegro incondicional,
      -- sin importar el tiempo de gracia.
      perform public.admin_cancel_booking(
        v_user_id, p_class_id, p_occurrence_date, 'Clase cancelada por el gimnasio', true
      );
      v_cancelados := v_cancelados + 1;

      -- Notificación INDIVIDUAL por socio afectado -- a propósito NO
      -- audience_type='class' (eso resuelve destinatarios por bookings.
      -- class_id SIN filtrar por fecha, ver send-push/resolveUserIds --
      -- notificaría a cualquiera que alguna vez se anotó a esta clase
      -- recurrente, no solo a los de hoy). 'user' + target_user_id es el
      -- mismo patrón exacto que ya usa Anunciar.jsx para un socio puntual,
      -- solo que automatizado acá.
      insert into notifications (sender_id, audience_type, target_user_id, title, body)
      values (
        v_admin_id,
        'user',
        v_user_id,
        'Clase cancelada',
        format(
          '%s de las %s del %s fue cancelada por el gimnasio. Ya te reintegramos el crédito.',
          v_titulo_clase,
          to_char(v_hora_inicio, 'HH24:MI'),
          to_char(p_occurrence_date, 'DD/MM/YYYY')
        )
      );
    end loop;
  end if;

  return v_cancelados;
end;
$$;

grant execute on function public.admin_cancelar_clase_dia(uuid, date) to authenticated;

-- ============================================================
-- 3) Guard en book_class()/admin_book_class() -- no se puede reservar una
-- ocurrencia ya cancelada. Cuerpo COMPLETO copiado tal cual de
-- supabase_migration_lotes_creditos_fase2.sql (la versión vigente) +
-- el guard nuevo, justo después del chequeo de día de semana existente.
-- Nada más cambia -- ni créditos, ni XP, ni cupo.
-- ============================================================

create or replace function public.book_class(p_class_id uuid, p_booking_date date)
returns uuid
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_capacity int;
  v_discipline_id uuid;
  v_days_of_week integer[];
  v_booked_count int;
  v_credit_id uuid;
  v_booking_id uuid;
  v_xp_reserva int;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  select capacity, discipline_id, days_of_week into v_capacity, v_discipline_id, v_days_of_week
  from classes where id = p_class_id for update;
  if v_capacity is null then
    raise exception 'La clase no existe';
  end if;

  if not public.esta_habilitado_para_disciplina(v_user_id, v_discipline_id) then
    raise exception 'Tu plan/créditos para esta disciplina están vencidos. No podés reservar hasta regularizar tu situación.';
  end if;

  if not (extract(dow from p_booking_date)::int = any(v_days_of_week)) then
    raise exception 'Esta clase no se dicta ese día.';
  end if;

  -- NUEVO -- ocurrencia cancelada puntualmente por el gimnasio.
  if exists (
    select 1 from class_occurrence_cancellations
    where class_id = p_class_id and occurrence_date = p_booking_date
  ) then
    raise exception 'Esta clase fue cancelada para esta fecha.';
  end if;

  select count(*) into v_booked_count
  from bookings where class_id = p_class_id and booking_date = p_booking_date;
  if v_booked_count >= v_capacity then
    raise exception 'Sin cupo';
  end if;

  select id into v_credit_id
  from user_credits
  where user_id = v_user_id and discipline_id = v_discipline_id
    and remaining_credits > 0
    and expires_at > now()
  order by expires_at asc
  limit 1
  for update;

  if v_credit_id is null then
    raise exception 'Sin créditos disponibles para esta disciplina';
  end if;

  insert into bookings (user_id, class_id, booking_date, credit_lote_id)
  values (v_user_id, p_class_id, p_booking_date, v_credit_id)
  returning id into v_booking_id;

  update user_credits set remaining_credits = remaining_credits - 1 where id = v_credit_id;

  begin
    select coalesce(xp_por_reserva, 100) into v_xp_reserva from configuracion where id = 1;
  exception when others then
    v_xp_reserva := null;
  end;
  if v_xp_reserva is null then
    v_xp_reserva := 100;
  end if;

  insert into xp_events (user_id, event_type, xp_amount, reference_id, discipline_id, created_by)
  values (v_user_id, 'reserva', v_xp_reserva, v_booking_id, v_discipline_id, v_user_id)
  on conflict do nothing;

  return v_booking_id;
end;
$$;

grant execute on function public.book_class(uuid, date) to authenticated;

create or replace function public.admin_book_class(p_user_id uuid, p_class_id uuid, p_booking_date date)
returns uuid
language plpgsql
security definer
as $$
declare
  v_capacity int;
  v_discipline_id uuid;
  v_days_of_week integer[];
  v_booked_count int;
  v_credit_id uuid;
  v_booking_id uuid;
  v_xp_reserva int;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select capacity, discipline_id, days_of_week into v_capacity, v_discipline_id, v_days_of_week
  from classes where id = p_class_id for update;
  if v_capacity is null then
    raise exception 'La clase no existe';
  end if;

  if not public.esta_habilitado_para_disciplina(p_user_id, v_discipline_id) then
    raise exception 'Tu plan/créditos para esta disciplina están vencidos. No podés reservar hasta regularizar tu situación.';
  end if;

  if not (extract(dow from p_booking_date)::int = any(v_days_of_week)) then
    raise exception 'Esta clase no se dicta ese día.';
  end if;

  -- NUEVO -- mismo guard que book_class().
  if exists (
    select 1 from class_occurrence_cancellations
    where class_id = p_class_id and occurrence_date = p_booking_date
  ) then
    raise exception 'Esta clase fue cancelada para esta fecha.';
  end if;

  select count(*) into v_booked_count
  from bookings where class_id = p_class_id and booking_date = p_booking_date;
  if v_booked_count >= v_capacity then
    raise exception 'Sin cupo';
  end if;

  select id into v_credit_id
  from user_credits
  where user_id = p_user_id and discipline_id = v_discipline_id
    and remaining_credits > 0
    and expires_at > now()
  order by expires_at asc
  limit 1
  for update;

  if v_credit_id is null then
    raise exception 'El socio no tiene créditos disponibles para esta disciplina';
  end if;

  insert into bookings (user_id, class_id, booking_date, credit_lote_id)
  values (p_user_id, p_class_id, p_booking_date, v_credit_id)
  returning id into v_booking_id;

  update user_credits set remaining_credits = remaining_credits - 1 where id = v_credit_id;

  begin
    select coalesce(xp_por_reserva, 100) into v_xp_reserva from configuracion where id = 1;
  exception when others then
    v_xp_reserva := null;
  end;
  if v_xp_reserva is null then
    v_xp_reserva := 100;
  end if;

  insert into xp_events (user_id, event_type, xp_amount, reference_id, discipline_id, created_by)
  values (p_user_id, 'reserva', v_xp_reserva, v_booking_id, v_discipline_id, auth.uid())
  on conflict do nothing;

  return v_booking_id;
end;
$$;

grant execute on function public.admin_book_class(uuid, uuid, date) to authenticated;

-- ============================================================
-- VERIFICACIÓN -- correr a mano con una clase de PRUEBA.
-- ============================================================

-- CASO 0 -- confirmar que NO se tocó nada de créditos/reintegro genérico
-- (comparar el md5 de ANTES de correr esta migración contra el de DESPUÉS
-- -- tienen que ser IDÉNTICOS):
-- select proname, md5(pg_get_functiondef(oid)) from pg_proc
-- where proname in ('admin_cancel_booking', 'cancel_booking', 'acreditar_pack', 'admin_acreditar_creditos_manual')
-- order by proname;

-- CASO 1 -- cancelar una clase de HOY con 3 socios anotados.
-- select b.user_id, uc.id as lote, uc.remaining_credits
-- from bookings b left join user_credits uc on uc.id = b.credit_lote_id
-- where b.class_id = '<CLASS_ID_PRUEBA>' and b.booking_date = '<FECHA_PRUEBA>';
-- -- anotar los 3 remaining_credits ANTES de seguir.
--
-- select admin_cancelar_clase_dia('<CLASS_ID_PRUEBA>', '<FECHA_PRUEBA>');
-- -- esperado: devuelve 3.
--
-- select count(*) from bookings where class_id = '<CLASS_ID_PRUEBA>' and booking_date = '<FECHA_PRUEBA>';
-- -- esperado: 0 (todas canceladas).
-- select uc.id, uc.remaining_credits from user_credits uc where uc.user_id in (<LOS 3 USER_ID>);
-- -- esperado: cada uno +1 respecto del valor anotado arriba (si el lote de origen seguía vigente).
-- select target_user_id, title, body from notifications
-- where audience_type = 'user' and created_at > now() - interval '5 minutes'
-- order by created_at desc;
-- -- esperado: 3 filas, una por socio, con el texto de la clase cancelada.
--
-- select id, title, days_of_week from classes where id = '<CLASS_ID_PRUEBA>';
-- -- esperado: la clase SIGUE existiendo, con los mismos days_of_week de siempre
-- -- (no se tocó `classes` para nada).

-- CASO 2 -- reservar esa misma clase+fecha después de cancelada -- rechaza.
-- select book_class('<CLASS_ID_PRUEBA>', '<FECHA_PRUEBA>'); -- con sesión de un socio
-- select admin_book_class('<USER_ID_CUALQUIERA>', '<CLASS_ID_PRUEBA>', '<FECHA_PRUEBA>');
-- -- esperado en los dos: excepción 'Esta clase fue cancelada para esta fecha.'

-- CASO 3 -- la clase se sigue pudiendo reservar OTRO día de la semana
-- (ej. la próxima ocurrencia, una semana después):
-- select book_class('<CLASS_ID_PRUEBA>', '<FECHA_PRUEBA_MAS_7_DIAS>');
-- -- esperado: funciona normal, sin ninguna excepción -- confirma que el
-- -- guard es específico de la fecha cancelada, no de la clase entera.
