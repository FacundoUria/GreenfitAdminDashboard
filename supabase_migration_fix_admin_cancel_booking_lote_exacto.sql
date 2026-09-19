-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ESTAMOS EN PRODUCCIÓN.
--
-- REGRESIÓN REAL: supabase_migration_admin_cancel_booking_forzar_reintegro.sql
-- (ya corrida) se escribió a partir de la versión de admin_cancel_booking()
-- del 2/9 (supabase_migration_cancel_booking_configurable.sql), NO de la
-- vigente del 7/9 (supabase_migration_lotes_creditos_fase2.sql, modelo de
-- lotes). Resultado: admin_cancel_booking() volvió a reintegrar a "la fila
-- más reciente" (order by created_at desc limit 1, sin filtrar
-- expires_at > now()) en vez de al lote EXACTO del que se descontó al
-- reservar (bookings.credit_lote_id) -- puede devolverle el crédito a un
-- lote vencido o a uno que no es el de origen.
--
-- FIX: se restaura EXACTAMENTE el criterio de cancel_booking() (la de la
-- PWA, fase2 -- NO se toca): mismo bloque de reintegro, copiado tal cual,
-- más el gate `or p_forzar_reintegro` que ya existía. Lo ÚNICO que cambia
-- respecto de la versión rota es CUÁL lote recibe el crédito y bajo qué
-- condición de vigencia:
--   1) Se lee bookings.credit_lote_id ANTES de borrar la reserva.
--   2) Con lote de origen: se reintegra SOLO si ese lote sigue vigente
--      (expires_at > now(), en el mismo UPDATE atómico). Si venció, NO se
--      reintegra nada, en ningún lado -- INCLUSO con p_forzar_reintegro =
--      true (forzar el reintegro salta el gate del tiempo de gracia, no
--      revive un lote muerto).
--   3) Sin credit_lote_id (reserva vieja): el lote VIGENTE que vence más
--      pronto (order by expires_at asc, expires_at > now()), nunca "el más
--      reciente por creación". Sin lote vigente, no hay a dónde reintegrar.
-- p_forzar_reintegro conserva su semántica: v_dentro_del_limite se sigue
-- calculando y devolviendo igual; el gate de reintegro por tiempo de gracia
-- se ignora cuando es true.
--
-- NO toca acreditar_pack, admin_acreditar_creditos_manual, cancel_booking()
-- ni ningún camino de otorgar créditos.

-- Por si quedó viva la versión de 4 argumentos (fase2) junto a la de 5.
drop function if exists public.admin_cancel_booking(uuid, uuid, date, text);

create or replace function public.admin_cancel_booking(
  p_user_id uuid,
  p_class_id uuid,
  p_booking_date date,
  p_reason text default null,
  p_forzar_reintegro boolean default false
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_discipline_id uuid;
  v_start_time time;
  v_booking_id uuid;
  v_credit_lote_id uuid;
  v_credit_id uuid;
  v_class_start timestamptz;
  v_dentro_del_limite boolean;
  v_limite_minutos int;
begin
  if not public.is_admin() then
    raise exception 'Esta acción requiere permisos de administrador.';
  end if;

  select discipline_id, start_time into v_discipline_id, v_start_time
  from classes where id = p_class_id;

  v_class_start := (p_booking_date::text || ' ' || v_start_time::text)::timestamp
    at time zone 'America/Argentina/Mendoza';

  begin
    select coalesce(limite_cancelacion_minutos, 120) into v_limite_minutos
    from configuracion where id = 1;
  exception when others then
    v_limite_minutos := null;
  end;
  if v_limite_minutos is null then
    v_limite_minutos := 120;
  end if;

  v_dentro_del_limite := now() <= (v_class_start - (v_limite_minutos || ' minutes')::interval);

  -- Se lee credit_lote_id ANTES de borrar la reserva (una vez borrada, ese
  -- dato ya no está en ningún lado). `for update` evita que un doble
  -- cancel casi simultáneo lea la misma fila dos veces.
  select id, credit_lote_id into v_booking_id, v_credit_lote_id
  from bookings
  where user_id = p_user_id and class_id = p_class_id and booking_date = p_booking_date
  for update;

  if v_booking_id is null then
    raise exception 'Ese socio no tenía una reserva en esta clase';
  end if;

  delete from bookings where id = v_booking_id;

  insert into booking_cancellations (user_id, class_id, booking_date, reason)
  values (p_user_id, p_class_id, p_booking_date, nullif(trim(p_reason), ''));

  if v_dentro_del_limite or p_forzar_reintegro then
    if v_credit_lote_id is not null then
      -- Reintegro preciso -- SOLO si el lote de origen sigue vigente. Un
      -- único UPDATE atómico (expires_at>now() y el +1 en la misma
      -- sentencia): si el lote ya venció no matchea ninguna fila y no se
      -- reintegra NADA, ni acá ni en otro lote, forzado o no.
      update user_credits
      set remaining_credits = remaining_credits + 1
      where id = v_credit_lote_id and expires_at > now();
    else
      -- Fallback -- reserva sin credit_lote_id (anterior al modelo de
      -- lotes): el lote VIGENTE que vence más pronto (FIFO).
      select id into v_credit_id
      from user_credits
      where user_id = p_user_id and discipline_id = v_discipline_id
        and expires_at > now()
      order by expires_at asc
      limit 1
      for update;

      if v_credit_id is not null then
        update user_credits set remaining_credits = remaining_credits + 1 where id = v_credit_id;
      end if;
    end if;
  end if;

  return v_dentro_del_limite;
end;
$$;

grant execute on function public.admin_cancel_booking(uuid, uuid, date, text, boolean) to authenticated;

-- ============================================================
-- VERIFICACIÓN -- correr a mano con un socio de PRUEBA.
-- ============================================================

-- 0) La firma vigente tiene que ser UNA sola, con p_forzar_reintegro, y el
-- cuerpo tiene que mencionar credit_lote_id (y NO "created_at desc"):
-- select pg_get_function_identity_arguments(oid), pg_get_functiondef(oid) like '%credit_lote_id%' as usa_lote,
--        pg_get_functiondef(oid) like '%created_at desc%' as version_rota
-- from pg_proc where proname = 'admin_cancel_booking';

-- Preparación común: una reserva de prueba con su lote de origen.
-- select b.id, b.credit_lote_id, uc.remaining_credits, uc.expires_at
-- from bookings b left join user_credits uc on uc.id = b.credit_lote_id
-- where b.user_id = '<USER_ID_PRUEBA>' and b.class_id = '<CLASS_ID>' and b.booking_date = '<FECHA>';

-- CASO 1 -- lote de origen VIGENTE: reintegra ahí exacto (+1 en ESE lote).
-- select admin_cancel_booking('<USER_ID_PRUEBA>', '<CLASS_ID>', '<FECHA>', 'prueba', false);
-- select id, remaining_credits from user_credits where id = '<LOTE_ORIGEN>';   -- +1 (si estaba dentro del tiempo de gracia)
-- select id, remaining_credits from user_credits where user_id = '<USER_ID_PRUEBA>' and id <> '<LOTE_ORIGEN>'; -- SIN cambios

-- CASO 2 -- lote de origen VENCIDO: no reintegra NADA, ni con forzar=true.
-- update user_credits set expires_at = now() - interval '1 day' where id = '<LOTE_ORIGEN_2>';  -- solo en un socio de PRUEBA
-- select admin_cancel_booking('<USER_ID_PRUEBA>', '<CLASS_ID_2>', '<FECHA>', 'prueba', true);
-- select id, remaining_credits, expires_at from user_credits where user_id = '<USER_ID_PRUEBA>';  -- NINGUNA fila cambió

-- CASO 3 -- reserva vieja SIN credit_lote_id: reintegra al lote vigente que vence antes.
-- update bookings set credit_lote_id = null where id = '<BOOKING_ID_3>';   -- solo en un socio de PRUEBA
-- select admin_cancel_booking('<USER_ID_PRUEBA>', '<CLASS_ID_3>', '<FECHA>', 'prueba', true);
-- select id, remaining_credits, expires_at from user_credits
-- where user_id = '<USER_ID_PRUEBA>' and discipline_id = '<DISCIPLINE_ID>' order by expires_at;
-- -- esperado: +1 en el primer lote VIGENTE por expires_at, no en el más reciente por created_at.

-- CASO 4 -- cancel_booking() (PWA) y las funciones de acreditar NO cambiaron:
-- select proname, md5(pg_get_functiondef(oid)) from pg_proc
-- where proname in ('cancel_booking', 'acreditar_pack', 'admin_acreditar_creditos_manual');
-- -- comparar contra el mismo select ANTES de correr esta migración: los md5 tienen que ser idénticos.
