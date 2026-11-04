-- =====================================================================================
-- ROLLBACK de T7 -- saca el candado (los 2 triggers de user_credits y su función).
-- Deja todo como antes de supabase_migration_t7_candado_una_fecha.sql. No toca datos.
-- Se puede correr aunque la migración no esté aplicada (no hace nada).
-- =====================================================================================

begin;

drop trigger if exists candado_una_fecha_vigente_ins on public.user_credits;
drop trigger if exists candado_una_fecha_vigente_upd on public.user_credits;
drop function if exists public.candado_una_fecha_vigente();

do $chequeo$
begin
  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.user_credits'::regclass
      and tgname in ('candado_una_fecha_vigente_ins', 'candado_una_fecha_vigente_upd')
  ) or to_regprocedure('public.candado_una_fecha_vigente()') is not null then
    raise exception 'Rollback T7: el candado sigue ahí. No se aplicó nada.';
  end if;
end;
$chequeo$;

commit;

-- Verificación (solo lectura): 0 filas.
-- select tgname from pg_trigger
-- where tgrelid = 'public.user_credits'::regclass and tgname like 'candado_una_fecha_vigente%';
