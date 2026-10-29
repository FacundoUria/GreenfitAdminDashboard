-- =====================================================================================
-- ROLLBACK de supabase_migration_clase_una_sola_vez.sql. NO SE CORRIÓ. ESTAMOS EN PRODUCCIÓN.
--
-- Vuelve book_class y admin_book_class a su cuerpo de producción (copiado byte a byte de
-- supabase_migration_cancelar_clase_puntual.sql, la versión vigente antes de esta tanda), saca
-- el trigger classes_validar_fecha_unica (y su función) y el CHECK classes_fecha_unica_dia_check.
--
-- La columna classes.fecha_unica:
--   * si NINGUNA clase tiene fecha_unica -> se borra (no tiene datos, no se pierde nada);
--   * si alguna ya la tiene -> NO se borra (es el dato de Seba). Ojo: sin la regla de book_class,
--     esas clases vuelven a repetirse todas las semanas (tienen days_of_week = {su día}).
--
-- Solo DDL y funciones. Ningún UPDATE/DELETE/INSERT de datos.
--
-- Orden: primero volver el Admin y la PWA a la versión anterior (el código nuevo pide
-- fecha_unica; si la columna se borra con ese código desplegado, la Agenda y el Admin fallan).
-- Orden inverso al despliegue: Admin -> PWA -> este rollback.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) ANTES: las 2 funciones tienen que ser la versión de esta migración (tienen la regla
--      'Esta clase es solo del'). Si no, se frena: no se pisa un cambio que no conocemos.
--   2) DESPUÉS: huella SIN espacios = la de producción de antes de la migración. Reemplazar
--      los dos <MD5_SIN_ESPACIOS_…> con la columna md5_sin_espacios de la consulta del
--      encabezado de la migración (corrida ANTES de migrar). Si quedan sin reemplazar, falla.
--   3) Permisos (proacl) EXACTAMENTE iguales, anon incluido. Por eso NO hay ningún grant.
-- =====================================================================================

begin;

do $guarda$
begin
  if position('Esta clase es solo del' in pg_get_functiondef('public.book_class(uuid, date)'::regprocedure)) = 0 then
    raise exception 'Rollback una sola vez: book_class no es la versión de la migración. No se aplicó nada.';
  end if;
  if position('Esta clase es solo del' in pg_get_functiondef('public.admin_book_class(uuid, uuid, date)'::regprocedure)) = 0 then
    raise exception 'Rollback una sola vez: admin_book_class no es la versión de la migración. No se aplicó nada.';
  end if;
end;
$guarda$;

create temp table _usv_rb_permisos_antes on commit drop as
select p.oid::regprocedure::text as funcion, coalesce(p.proacl::text, '(por defecto)') as permisos
from pg_proc p
where p.oid in ('public.book_class(uuid, date)'::regprocedure,
                'public.admin_book_class(uuid, uuid, date)'::regprocedure);

-- ── Funciones: cuerpo de producción (cancelar_clase_puntual), sin fecha_unica ──
-- Van ANTES de borrar la columna: la versión nueva la lee.

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

-- ── Trigger, función del trigger y CHECK ──
drop trigger if exists classes_validar_fecha_unica on public.classes;
drop function if exists public.classes_validar_fecha_unica();
alter table public.classes drop constraint if exists classes_fecha_unica_dia_check;

-- ── Columna: solo si nadie la usa ──
do $columna$
declare
  v_con_fecha int;
begin
  select count(*) into v_con_fecha from public.classes where fecha_unica is not null;
  if v_con_fecha = 0 then
    alter table public.classes drop column fecha_unica;
    raise notice 'Rollback una sola vez: ninguna clase tenía fecha_unica, se borró la columna.';
  else
    raise notice 'Rollback una sola vez: % clase(s) tienen fecha_unica, la columna se queda (vuelven a repetirse todas las semanas).', v_con_fecha;
  end if;
end;
$columna$;

do $verificacion$
declare
  v_cambiados text;
begin
  if md5(regexp_replace(pg_get_functiondef('public.book_class(uuid, date)'::regprocedure), '\s+', '', 'g')) <> '781d0f5c00a55787c9ea530a479f8bf0' then
    raise exception 'Rollback una sola vez: book_class no quedó igual a la de producción. No se aplicó nada.';
  end if;
  if md5(regexp_replace(pg_get_functiondef('public.admin_book_class(uuid, uuid, date)'::regprocedure), '\s+', '', 'g')) <> '5ac4ddea0849b9b230f64610072764b2' then
    raise exception 'Rollback una sola vez: admin_book_class no quedó igual a la de producción. No se aplicó nada.';
  end if;
  select string_agg(a.funcion, ', ') into v_cambiados
  from _usv_rb_permisos_antes a
  join pg_proc p on p.oid = a.funcion::regprocedure
  where coalesce(p.proacl::text, '(por defecto)') <> a.permisos;
  if v_cambiados is not null then
    raise exception 'Rollback una sola vez: cambiaron los permisos de %. No se aplicó nada.', v_cambiados;
  end if;
  if exists (select 1 from pg_trigger where tgname = 'classes_validar_fecha_unica') then
    raise exception 'Rollback una sola vez: el trigger sigue existiendo. No se aplicó nada.';
  end if;
  if exists (select 1 from pg_constraint where conname = 'classes_fecha_unica_dia_check') then
    raise exception 'Rollback una sola vez: el CHECK sigue existiendo. No se aplicó nada.';
  end if;
end;
$verificacion$;

commit;
