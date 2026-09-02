-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- Es 100% de SOLO LECTURA -- ningún UPDATE/DELETE, cero riesgo de correrlo.
--
-- Fase C1: antes de siquiera pensar en un script de borrado para la
-- cuenta duplicada, hay que saber si el id
-- 6b1104aa-a8f5-456b-9575-2720b1deffe3 aparece referenciado en alguna
-- fila real de cualquier tabla. Este script lo confirma tabla por tabla.

-- 1) La cuenta en sí -- confirmar que el id es realmente el de seba@gmail.com.
select id, email, created_at from auth.users where id = '6b1104aa-a8f5-456b-9575-2720b1deffe3';
select id, email, full_name, role, dni from profiles where id = '6b1104aa-a8f5-456b-9575-2720b1deffe3';

-- 2) Conteo por tabla/columna -- cualquier fila con cantidad > 0 es una
--    referencia real que hay que resolver ANTES de poder borrar la cuenta
--    (reasignar a la otra cuenta admin, o dejar la fila intacta y no
--    borrar, según el caso). Marcadas [RESTRICT] las 4 columnas que van a
--    hacer FALLAR el DELETE directamente si tienen alguna fila -- esas son
--    las más importantes de revisar primero.
select 'credit_transactions.user_id' as tabla_columna, count(*) from credit_transactions where user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'credit_transactions.created_by [RESTRICT]', count(*) from credit_transactions where created_by = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'user_credits.user_id', count(*) from user_credits where user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'bookings.user_id', count(*) from bookings where user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'booking_cancellations.user_id', count(*) from booking_cancellations where user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'notifications.sender_id [RESTRICT]', count(*) from notifications where sender_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'notifications.target_user_id', count(*) from notifications where target_user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'push_subscriptions.user_id', count(*) from push_subscriptions where user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'community_posts.author_id', count(*) from community_posts where author_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'community_reactions.user_id', count(*) from community_reactions where user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'community_comments.author_id', count(*) from community_comments where author_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'community_groups.created_by', count(*) from community_groups where created_by = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'community_group_members.user_id', count(*) from community_group_members where user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'community_group_messages.author_id', count(*) from community_group_messages where author_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'community_dm_threads.user_a', count(*) from community_dm_threads where user_a = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'community_dm_threads.user_b', count(*) from community_dm_threads where user_b = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'community_dm_messages.author_id', count(*) from community_dm_messages where author_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'routine_exercise_weights.user_id', count(*) from routine_exercise_weights where user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'xp_events.user_id', count(*) from xp_events where user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'xp_events.created_by [RESTRICT]', count(*) from xp_events where created_by = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'metas_personales.user_id', count(*) from metas_personales where user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'pagos_socio.user_id', count(*) from pagos_socio where user_id = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
union all
select 'pagos_socio.created_by [RESTRICT]', count(*) from pagos_socio where created_by = '6b1104aa-a8f5-456b-9575-2720b1deffe3'
order by 1;

-- 3) Extra -- socios.dni no es un FK real (el puente es por DNI, no por
--    id), pero vale la pena confirmar si este email/profile está vinculado
--    a alguna ficha de socio real (por las dudas de que la cuenta
--    "duplicada" en realidad tenga uso real como socio también).
select s.id, s.nombre, s.apellido, s.dni
from socios s
join profiles p on p.dni = s.dni
where p.id = '6b1104aa-a8f5-456b-9575-2720b1deffe3';
