-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor) CUANDO SE
-- QUIERA activar: XP correcto por disciplina (doble turno legítimo),
-- Check-in Rápido de Musculación y la Actividad Reciente con reversión.
--
-- Mismo proyecto de Supabase que usa la PWA (greenfit-app) -- xp_events,
-- disciplines, bookings, classes ya existen ahí. No se ejecuta
-- automáticamente: es un cambio de schema sobre producción.

-- ============================================================
-- 1) xp_events: discipline_id real (antes solo se podía inferir vía
--    reference_id -> bookings -> classes, lo que dejaba afuera cualquier
--    evento sin reserva, como el nuevo Check-in Rápido de Musculación) +
--    created_by (quién generó/otorgó el evento -- para el feed de
--    Actividad Reciente y las reversiones).
-- ============================================================

alter table xp_events add column if not exists discipline_id uuid references disciplines(id);
alter table xp_events add column if not exists created_by uuid references profiles(id);

-- Backfill: todo lo que ya se generó vía reserva de clase (reference_id
-- apunta a un booking) ahora puede resolver su discipline_id real -- sin
-- esto, el ranking filtrado por disciplina y la Actividad Reciente
-- mostrarían huecos para todo el historial previo a esta migración.
update xp_events xe
set discipline_id = c.discipline_id
from bookings b
join classes c on c.id = b.class_id
where xe.reference_id = b.id
  and xe.event_type = 'asistencia'
  and xe.discipline_id is null;

-- 'reversion': nueva fila NEGATIVA que compensa un evento anterior (nunca
-- se borra un xp_events -- ver RPC admin_revertir_xp_evento más abajo).
alter table xp_events drop constraint if exists xp_events_event_type_check;
alter table xp_events add constraint xp_events_event_type_check
  check (event_type in ('asistencia', 'pr', 'meta', 'post', 'reversion'));

-- ============================================================
-- 2) Doble turno legítimo: el cupo diario de 'asistencia' pasa de "1 por
--    día a secas" a "1 por día POR DISCIPLINA" -- así CrossFit a la mañana
--    + Boxeo a la tarde suman +100 XP cada una, de forma independiente.
--    El Check-in Rápido de Musculación comparte este mismo mecanismo (su
--    discipline_id es el de Aparatos/Musculación).
--
--    El botón "¡Hoy entrené!" autoreportado de la PWA NO manda disciplina
--    (discipline_id queda null) -- se mantiene con su propio cupo
--    independiente de 1/día, sin tocar su comportamiento actual.
-- ============================================================

drop index if exists idx_xp_events_asistencia_por_dia;

create unique index if not exists idx_xp_events_asistencia_por_dia_disciplina
  on xp_events(user_id, event_date, discipline_id)
  where event_type = 'asistencia' and discipline_id is not null;

create unique index if not exists idx_xp_events_asistencia_por_dia_sin_disciplina
  on xp_events(user_id, event_date)
  where event_type = 'asistencia' and discipline_id is null;

-- ============================================================
-- 3) Trigger de asistencia de clase -- ahora también guarda discipline_id
--    y created_by (quién marcó `attended`, sea el admin desde el panel o
--    vía las RPCs admin_book_class/admin_cancel_booking).
-- ============================================================

create or replace function public.award_xp_asistencia()
returns trigger as $$
declare
  v_kind text;
  v_discipline_id uuid;
begin
  select d.kind, c.discipline_id into v_kind, v_discipline_id
  from classes c
  join disciplines d on d.id = c.discipline_id
  where c.id = new.class_id;

  if v_kind = 'credits' and new.attended = true and (old.attended is distinct from true) then
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
-- 4) RPC: Check-in Rápido de Musculación (Navbar del panel admin) -- +100
--    XP de entreno libre, 1 vez por día por socio (lo hace cumplir el
--    índice único de arriba: si ya tiene un check-in de Musculación hoy,
--    esto tira 23505 y el cliente lo trata como "ya registrado hoy", no
--    como un error real).
-- ============================================================

create or replace function public.admin_otorgar_checkin_musculacion(p_user_id uuid)
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

  insert into xp_events (user_id, event_type, xp_amount, discipline_id, created_by)
  values (p_user_id, 'asistencia', 100, v_discipline_id, auth.uid())
  returning id into v_xp_event_id;

  return v_xp_event_id;
end;
$$;

grant execute on function public.admin_otorgar_checkin_musculacion(uuid) to authenticated;

-- ============================================================
-- 5) RPC: revertir un evento de XP desde la Actividad Reciente -- inserta
--    una fila de compensación NEGATIVA en vez de borrar (auditoría
--    completa, nunca se pierde el historial real). Idempotente: revertir
--    dos veces el mismo evento tira error en vez de descontar doble.
-- ============================================================

create or replace function public.admin_revertir_xp_evento(p_xp_event_id uuid)
returns uuid
language plpgsql
security definer
as $$
declare
  v_original xp_events%rowtype;
  v_ya_revertido boolean;
  v_reversion_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select * into v_original from xp_events where id = p_xp_event_id;
  if v_original.id is null then
    raise exception 'El evento de XP no existe.';
  end if;
  if v_original.event_type = 'reversion' then
    raise exception 'Este registro ya es una reversión -- no se puede revertir de nuevo.';
  end if;

  select exists(
    select 1 from xp_events where reference_id = p_xp_event_id and event_type = 'reversion'
  ) into v_ya_revertido;
  if v_ya_revertido then
    raise exception 'Este evento ya fue revertido anteriormente.';
  end if;

  insert into xp_events (user_id, event_type, xp_amount, discipline_id, reference_id, created_by)
  values (v_original.user_id, 'reversion', -v_original.xp_amount, v_original.discipline_id, v_original.id, auth.uid())
  returning id into v_reversion_id;

  return v_reversion_id;
end;
$$;

grant execute on function public.admin_revertir_xp_evento(uuid) to authenticated;

-- ============================================================
-- 6) Ranking por disciplina, simplificado: ahora filtra directo por
--    xe.discipline_id en vez de un join contra bookings/classes -- antes
--    dejaba afuera cualquier evento sin reserva (como el Check-in Rápido),
--    y de paso hacía la función mucho más simple.
-- ============================================================

create or replace function public.community_ranking_xp(p_discipline_id uuid default null)
returns table (user_id uuid, full_name text, avatar_url text, total_xp int)
language sql
security definer
stable
as $$
  select xe.user_id, p.full_name, p.avatar_url, sum(xe.xp_amount)::int as total_xp
  from xp_events xe
  join profiles p on p.id = xe.user_id
  where p_discipline_id is null or xe.discipline_id = p_discipline_id
  group by xe.user_id, p.full_name, p.avatar_url
  order by total_xp desc
  limit 20;
$$;
