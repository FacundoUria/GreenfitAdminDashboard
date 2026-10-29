-- =====================================================================================
-- CLASES DE UNA SOLA VEZ -- classes.fecha_unica. NO SE CORRIÓ TODAVÍA. ESTAMOS EN PRODUCCIÓN.
--
-- Pedido de Seba: una clase especial para un día (ej. un miércoles) se repetía todas las
-- semanas, porque `classes` solo sabe repetir por día de semana (days_of_week). Ahora:
--   * classes.fecha_unica date null -- si tiene valor, la clase existe SOLO ese día.
--   * CHECK classes_fecha_unica_dia_check: fecha_unica is null o days_of_week = {dow(fecha)}.
--     Así todo lo que ya filtra por día de semana la sigue encontrando en el día correcto.
--     Las clases existentes tienen fecha_unica null: cumplen el CHECK sin tocar nada,
--     incluida "Kick" (c3328419…), que quedó con days_of_week = {} a propósito.
--   * Trigger classes_validar_fecha_unica (BEFORE INSERT / UPDATE OF days_of_week, fecha_unica):
--       R1) fecha_unica no puede ser anterior a hoy (hora Argentina) al crearla o cambiarla.
--           Editar otra cosa de una clase de una sola vez ya pasada no la dispara.
--       R2) un cambio de days_of_week o fecha_unica no puede dejar reservas de HOY EN
--           ADELANTE en fechas donde la clase ya no se dictaría. Solo cuenta las reservas que
--           eran válidas ANTES del cambio y dejan de serlo: las que ya estaban fuera de la
--           plantilla (ej. Kick con {}) no frenan nada. Las reservas pasadas nunca frenan.
--           Cubre también un agujero que ya existía: sacarle un día a una clase semanal con
--           reservas futuras ese día.
--   * book_class() y admin_book_class(): si la clase tiene fecha_unica y la fecha pedida es
--     otra -> 'Esta clase es solo del dd/mm'. Cuerpo COMPLETO copiado tal cual de
--     supabase_migration_cancelar_clase_puntual.sql (la versión vigente) + esa regla, antes
--     del chequeo de día de semana. Nada más cambia: ni créditos, ni XP, ni cupo.
--
-- Solo DDL y funciones. Ningún UPDATE/DELETE/INSERT sobre datos existentes. La columna nueva
-- no tiene default: no reescribe la tabla ni cambia ninguna fila. La tabla temporal de abajo
-- es solo para comparar permisos antes/después y se borra sola al terminar la transacción.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) md5 EXACTO de pg_get_functiondef de book_class y admin_book_class = el de producción.
--      Reemplazar los dos <MD5_EXACTO_…> con lo que devuelve la consulta de abajo. Si quedan
--      sin reemplazar, la guarda falla y no se aplica nada.
--   2) La columna y el trigger todavía no existen.
--   3) Los permisos (proacl) de book_class y admin_book_class quedan EXACTAMENTE iguales,
--      anon incluido. create or replace los conserva; por eso NO hay ningún grant.
--
-- Consulta para sacar las huellas (SOLO LECTURA, correr ANTES y pasarme el resultado):
--   select p.oid::regprocedure as funcion,
--          md5(pg_get_functiondef(p.oid)) as md5_exacto,
--          md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', '', 'g')) as md5_sin_espacios,
--          coalesce(p.proacl::text, '(por defecto)') as permisos,
--          pg_get_functiondef(p.oid) as definicion
--   from pg_proc p
--   where p.oid in ('public.book_class(uuid, date)'::regprocedure,
--                   'public.admin_book_class(uuid, uuid, date)'::regprocedure);
--   -- md5_exacto       -> guarda 1 de esta migración
--   -- md5_sin_espacios -> verificación del rollback
--   -- permisos         -> caso (a) de la prueba
--   -- definicion       -> comparar contra el repo: si no es la de cancelar_clase_puntual,
--   --                     esta migración pisaría un cambio que no conocemos -> no correr.
--
-- Orden de despliegue OBLIGATORIO: esta migración -> PWA -> Admin.
-- (El código nuevo pide la columna fecha_unica: sin la migración, la Agenda y el Admin fallan.)
-- Prueba: prueba_clase_una_sola_vez.sql (DESPUÉS de esta migración).
-- Rollback: rollback_clase_una_sola_vez.sql.
-- =====================================================================================

begin;

-- ── Guardas 1 y 2: se reemplaza exactamente la versión de producción conocida, una sola vez ──
do $guarda$
begin
  if md5(pg_get_functiondef('public.book_class(uuid, date)'::regprocedure)) <> 'd216fb721e6363c8cbcef883d92b50b2' then
    raise exception 'Una sola vez: book_class no es la versión de producción (cambió su huella). No se aplicó nada.';
  end if;
  if md5(pg_get_functiondef('public.admin_book_class(uuid, uuid, date)'::regprocedure)) <> '78a229e208796be9d2bb89626861826c' then
    raise exception 'Una sola vez: admin_book_class no es la versión de producción (cambió su huella). No se aplicó nada.';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'classes' and column_name = 'fecha_unica'
  ) then
    raise exception 'Una sola vez: classes.fecha_unica ya existe. No se aplicó nada.';
  end if;
  if exists (select 1 from pg_trigger where tgname = 'classes_validar_fecha_unica') then
    raise exception 'Una sola vez: el trigger classes_validar_fecha_unica ya existe. No se aplicó nada.';
  end if;
end;
$guarda$;

-- ── Guarda 3 (foto): permisos de las 2 funciones antes de tocarlas ──
create temp table _usv_permisos_antes on commit drop as
select p.oid::regprocedure::text as funcion, coalesce(p.proacl::text, '(por defecto)') as permisos
from pg_proc p
where p.oid in ('public.book_class(uuid, date)'::regprocedure,
                'public.admin_book_class(uuid, uuid, date)'::regprocedure);

-- ============================================================
-- 1) Columna + CHECK
-- ============================================================
alter table public.classes add column fecha_unica date;

comment on column public.classes.fecha_unica is
  'Clase de una sola vez: si tiene valor, la clase existe SOLO ese día (y days_of_week = {dow(fecha_unica)}). null = se repite todas las semanas según days_of_week.';

-- Las filas existentes tienen fecha_unica null: el CHECK se valida sin tocar ninguna.
alter table public.classes
  add constraint classes_fecha_unica_dia_check
  check (fecha_unica is null or days_of_week = array[extract(dow from fecha_unica)::int]);

-- ============================================================
-- 2) Trigger -- R1 (no fecha pasada) y R2 (no dejar reservas futuras sin clase)
-- ============================================================
create function public.classes_validar_fecha_unica()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hoy date := (now() at time zone 'America/Argentina/Mendoza')::date;
  v_fechas text;
begin
  -- R1 -- solo al crearla o al cambiarle la fecha: editar el título/cupo de una clase de
  -- una sola vez que ya pasó no la frena (igual el Admin la muestra en solo lectura).
  if new.fecha_unica is not null
     and new.fecha_unica < v_hoy
     and (tg_op = 'INSERT' or new.fecha_unica is distinct from old.fecha_unica) then
    raise exception 'La fecha de una clase de una sola vez no puede ser anterior a hoy (%).',
      to_char(v_hoy, 'DD/MM/YYYY');
  end if;

  -- R2 -- reservas de hoy en adelante que eran válidas con la plantilla VIEJA y dejan de
  -- serlo con la NUEVA. Las que ya estaban fuera de la plantilla (ej. Kick, con {}) no
  -- cuentan: este cambio no las deja peor de lo que estaban.
  if tg_op = 'UPDATE'
     and (new.days_of_week is distinct from old.days_of_week
          or new.fecha_unica is distinct from old.fecha_unica) then
    select string_agg(format('%s (%s)', to_char(f.booking_date, 'DD/MM'), f.n), ', ' order by f.booking_date)
      into v_fechas
    from (
      select b.booking_date, count(*) as n
      from bookings b
      where b.class_id = new.id
        and b.booking_date >= v_hoy
        and extract(dow from b.booking_date)::int = any(old.days_of_week)
        and (old.fecha_unica is null or b.booking_date = old.fecha_unica)
        and not (
          extract(dow from b.booking_date)::int = any(new.days_of_week)
          and (new.fecha_unica is null or b.booking_date = new.fecha_unica)
        )
      group by b.booking_date
    ) f;

    if v_fechas is not null then
      raise exception 'Hay reservas de hoy en adelante en fechas donde la clase ya no se dictaría: %. Cancelá primero la clase en esas fechas (reintegra el crédito y avisa a los socios).',
        v_fechas;
    end if;
  end if;

  return new;
end;
$$;

-- Es una función de trigger: nadie tiene que poder llamarla directo.
revoke all on function public.classes_validar_fecha_unica() from public;
revoke all on function public.classes_validar_fecha_unica() from anon;
revoke all on function public.classes_validar_fecha_unica() from authenticated;

create trigger classes_validar_fecha_unica
  before insert or update of days_of_week, fecha_unica on public.classes
  for each row execute function public.classes_validar_fecha_unica();

-- ============================================================
-- 3) book_class() / admin_book_class() -- cuerpo vigente + la regla de fecha_unica
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
  v_fecha_unica date;
  v_booked_count int;
  v_credit_id uuid;
  v_booking_id uuid;
  v_xp_reserva int;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  select capacity, discipline_id, days_of_week, fecha_unica
    into v_capacity, v_discipline_id, v_days_of_week, v_fecha_unica
  from classes where id = p_class_id for update;
  if v_capacity is null then
    raise exception 'La clase no existe';
  end if;

  if not public.esta_habilitado_para_disciplina(v_user_id, v_discipline_id) then
    raise exception 'Tu plan/créditos para esta disciplina están vencidos. No podés reservar hasta regularizar tu situación.';
  end if;

  -- NUEVO -- clase de una sola vez (classes.fecha_unica): solo se reserva
  -- ese día. Las semanales (fecha_unica null) siguen exactamente igual.
  if v_fecha_unica is not null and p_booking_date <> v_fecha_unica then
    raise exception 'Esta clase es solo del %', to_char(v_fecha_unica, 'DD/MM');
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
  v_fecha_unica date;
  v_booked_count int;
  v_credit_id uuid;
  v_booking_id uuid;
  v_xp_reserva int;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select capacity, discipline_id, days_of_week, fecha_unica
    into v_capacity, v_discipline_id, v_days_of_week, v_fecha_unica
  from classes where id = p_class_id for update;
  if v_capacity is null then
    raise exception 'La clase no existe';
  end if;

  if not public.esta_habilitado_para_disciplina(p_user_id, v_discipline_id) then
    raise exception 'Tu plan/créditos para esta disciplina están vencidos. No podés reservar hasta regularizar tu situación.';
  end if;

  -- NUEVO -- clase de una sola vez (classes.fecha_unica): solo se reserva
  -- ese día. Las semanales (fecha_unica null) siguen exactamente igual.
  if v_fecha_unica is not null and p_booking_date <> v_fecha_unica then
    raise exception 'Esta clase es solo del %', to_char(v_fecha_unica, 'DD/MM');
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

-- ── Guarda 3 (chequeo): mismos permisos que antes, anon incluido ──
do $chequeo$
declare
  v_cambiados text;
begin
  select string_agg(a.funcion || ': antes ' || a.permisos || ' / ahora ' || coalesce(p.proacl::text, '(por defecto)'), ' | ')
    into v_cambiados
  from _usv_permisos_antes a
  join pg_proc p on p.oid = a.funcion::regprocedure
  where coalesce(p.proacl::text, '(por defecto)') <> a.permisos;
  if v_cambiados is not null then
    raise exception 'Una sola vez: cambiaron los permisos (%). No se aplicó nada.', v_cambiados;
  end if;
  if (select count(*) from _usv_permisos_antes) <> 2 then
    raise exception 'Una sola vez: no se pudo sacar la foto de permisos de las 2 funciones. No se aplicó nada.';
  end if;
  -- Ninguna clase existente cambió: todas siguen sin fecha_unica (Kick incluida, con {}).
  if exists (select 1 from public.classes where fecha_unica is not null) then
    raise exception 'Una sola vez: apareció una clase con fecha_unica dentro de la migración. No se aplicó nada.';
  end if;
end;
$chequeo$;

commit;

-- Verificación (solo lectura), después del commit:
-- select column_name, data_type, is_nullable from information_schema.columns
-- where table_schema = 'public' and table_name = 'classes' and column_name = 'fecha_unica';
-- -- esperado: fecha_unica | date | YES
-- select conname, convalidated from pg_constraint where conname = 'classes_fecha_unica_dia_check';
-- -- esperado: 1 fila, convalidated = true
-- select tgname, tgenabled from pg_trigger where tgname = 'classes_validar_fecha_unica';
-- -- esperado: 1 fila, tgenabled = 'O'
-- select id, title, days_of_week, fecha_unica from classes where id::text like 'c3328419%';
-- -- esperado: Kick igual que antes, days_of_week = {} y fecha_unica null
-- select p.oid::regprocedure, md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', '', 'g')) as huella_sin_espacios,
--        coalesce(p.proacl::text, '(por defecto)') as permisos
-- from pg_proc p
-- where p.oid in ('public.book_class(uuid, date)'::regprocedure,
--                 'public.admin_book_class(uuid, uuid, date)'::regprocedure);
-- -- esperado: permisos iguales a los de ANTES (los que devolvió la consulta del encabezado).
