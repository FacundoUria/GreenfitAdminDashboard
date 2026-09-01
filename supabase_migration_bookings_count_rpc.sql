-- Ejecutar en el SQL Editor de Supabase.
--
-- Bug real reportado: la Agenda de la PWA mostraba "0 de X cupos" para
-- cualquier disciplina, mientras el Dashboard Admin, para la MISMA clase en
-- el mismo momento, mostraba el número real de inscriptos (ej. 15).
--
-- Causa real: `loadClassesForDate()` (greenfit-app/src/lib/classesApi.ts)
-- calculaba `bookedCount` con un SELECT directo a `bookings`. La policy RLS
-- de esa tabla (backend/supabase-schema.sql) es:
--   bookings_select_own_or_admin: auth.uid() = user_id or is_admin()
-- Un socio común NO es admin, así que ese SELECT solo le devolvía SUS
-- PROPIAS filas -- como mucho 1 por clase (0 si el socio no se había
-- anotado él mismo), sin importar cuántos otros socios estuvieran
-- anotados. El Dashboard Admin (Clases.jsx) hace básicamente la misma
-- consulta, pero como corre logueado como admin, is_admin() lo deja ver
-- TODAS las filas -- de ahí la desconexión de números entre los dos.
--
-- Fix: una función SECURITY DEFINER que hace el mismo COUNT() real sobre
-- la MISMA tabla, con el MISMO filtro (booking_date + class_id) que ya usa
-- el Admin, pero corriendo con privilegios elevados -- misma fuente de
-- verdad para los dos paneles. Devuelve nada más que un número por clase
-- (sin PII: no expone qué socios en particular están anotados), así que es
-- seguro exponerla a cualquier usuario autenticado.
--
-- Idempotente: create or replace + grant repetible.
create or replace function public.get_bookings_count_por_clase(p_class_ids uuid[], p_booking_date date)
returns table(class_id uuid, booked_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select b.class_id, count(*)::bigint as booked_count
  from bookings b
  where b.booking_date = p_booking_date
    and b.class_id = any(p_class_ids)
  group by b.class_id;
$$;

grant execute on function public.get_bookings_count_por_clase(uuid[], date) to authenticated;

-- ── Verificación (opcional) ─────────────────────────────────────────────
-- Comparar contra el conteo real de una clase puntual:
-- select * from get_bookings_count_por_clase(array['<class_id>']::uuid[], '<YYYY-MM-DD>'::date);
-- select class_id, count(*) from bookings where booking_date = '<YYYY-MM-DD>' group by class_id; -- debería coincidir
