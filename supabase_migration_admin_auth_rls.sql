-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- Habilita el login real de Supabase Auth para el panel admin (hasta ahora
-- un usuario/clave hardcodeado en el cliente, sin JWT, por eso el panel
-- corría todo con la clave anon y RLS abierta a cualquiera -- ver el
-- comentario de supabase_migration_rls_y_clase_id.sql, que ya avisaba
-- "cuando agreguen login de verdad, reemplacen anon por authenticated").
--
-- Este script:
--   1. Cierra el acceso anon abierto en socios/classes (quedaba cualquiera
--      con la key pública pudiendo leer/escribir socios enteros).
--   2. Agrega policies para `authenticated` + is_admin() en su lugar.
--   3. Agrega policy de INSERT en bookings para que el admin pueda anotar
--      un socio a una clase desde el panel (antes solo el propio socio podía).
--   4. Agrega dos RPCs admin-only (admin_book_class / admin_cancel_booking)
--      que reusan la misma lógica atómica de cupo/créditos que ya usa la
--      PWA, pero para un user_id elegido por el admin en vez de auth.uid().
--
-- Prerrequisito: ya tiene que existir al menos un profile con role='admin'
-- (la cuenta de admin@greenfit.fit ya se creó y promovió aparte).

-- ── socios: cerrar anon, abrir a admin autenticado ─────────────────────
drop policy if exists "anon select socios" on socios;
drop policy if exists "anon insert socios" on socios;
drop policy if exists "anon update socios" on socios;
drop policy if exists "anon delete socios" on socios;

drop policy if exists "socios_admin_all" on socios;
create policy "socios_admin_all" on socios
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ── classes: cerrar anon (el select/write de authenticated ya existe
-- desde supabase-schema.sql: classes_select_all / classes_admin_write) ──
drop policy if exists "anon select classes" on classes;
drop policy if exists "anon insert classes" on classes;
drop policy if exists "anon update classes" on classes;
drop policy if exists "anon delete classes" on classes;

drop policy if exists "classes_select_all" on classes;
create policy "classes_select_all" on classes for select using (auth.role() = 'authenticated');
drop policy if exists "classes_admin_write" on classes;
create policy "classes_admin_write" on classes for all using (public.is_admin()) with check (public.is_admin());

-- ── bookings: el admin también puede anotar (insert) en nombre de un socio ──
drop policy if exists "bookings_insert_admin" on bookings;
create policy "bookings_insert_admin" on bookings
  for insert to authenticated
  with check (public.is_admin());

-- ── RPCs admin-only: mismo criterio atómico que book_class/cancel_booking,
-- pero para un p_user_id elegido por el admin en vez de auth.uid() ──────

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
  v_remaining int;
  v_booking_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select capacity, discipline_id, days_of_week into v_capacity, v_discipline_id, v_days_of_week
  from classes where id = p_class_id for update;
  if v_capacity is null then
    raise exception 'La clase no existe';
  end if;

  if not (extract(dow from p_booking_date)::int = any(v_days_of_week)) then
    raise exception 'Esta clase no se dicta ese día.';
  end if;

  select count(*) into v_booked_count
  from bookings where class_id = p_class_id and booking_date = p_booking_date;
  if v_booked_count >= v_capacity then
    raise exception 'Sin cupo';
  end if;

  select id, remaining_credits into v_credit_id, v_remaining
  from user_credits
  where user_id = p_user_id and discipline_id = v_discipline_id
  order by created_at desc
  limit 1
  for update;

  if v_credit_id is null or coalesce(v_remaining, 0) <= 0 then
    raise exception 'El socio no tiene créditos disponibles para esta disciplina';
  end if;

  insert into bookings (user_id, class_id, booking_date) values (p_user_id, p_class_id, p_booking_date)
  returning id into v_booking_id;

  update user_credits set remaining_credits = remaining_credits - 1 where id = v_credit_id;

  return v_booking_id;
end;
$$;

create or replace function public.admin_cancel_booking(p_user_id uuid, p_class_id uuid, p_booking_date date, p_reason text default null)
returns boolean
language plpgsql
security definer
as $$
declare
  v_discipline_id uuid;
  v_start_time time;
  v_credit_id uuid;
  v_class_start timestamptz;
  v_dentro_del_limite boolean;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select discipline_id, start_time into v_discipline_id, v_start_time
  from classes where id = p_class_id;

  v_class_start := (p_booking_date::text || ' ' || v_start_time::text)::timestamp
    at time zone 'America/Argentina/Mendoza';
  v_dentro_del_limite := now() <= (v_class_start - interval '2 hours');

  delete from bookings
  where user_id = p_user_id and class_id = p_class_id and booking_date = p_booking_date;
  if not found then
    raise exception 'Ese socio no tenía una reserva en esta clase';
  end if;

  insert into booking_cancellations (user_id, class_id, booking_date, reason)
  values (p_user_id, p_class_id, p_booking_date, nullif(trim(p_reason), ''));

  if v_dentro_del_limite then
    select id into v_credit_id
    from user_credits
    where user_id = p_user_id and discipline_id = v_discipline_id
    order by created_at desc
    limit 1
    for update;

    if v_credit_id is not null then
      update user_credits set remaining_credits = remaining_credits + 1 where id = v_credit_id;
    end if;
  end if;

  return v_dentro_del_limite;
end;
$$;

grant execute on function public.admin_book_class(uuid, uuid, date) to authenticated;
grant execute on function public.admin_cancel_booking(uuid, uuid, date, text) to authenticated;

-- Verificación rápida después de correr esto (logueado como admin en el panel):
--   select * from socios limit 1;              -- debe funcionar
--   select * from bookings limit 1;             -- debe funcionar (antes daba vacío)
