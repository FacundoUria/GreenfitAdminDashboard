-- =====================================================================================
-- ROLLBACK de Tanda RP (supabase_migration_tanda_rp_book_class_pasado.sql).
-- NO SE CORRIÓ TODAVÍA. ESTAMOS EN PRODUCCIÓN. Solo si la prueba falla.
--
-- Vuelve book_class a la definición EXACTA de antes de la tanda (la guardada en
-- respaldo.tanda_rp_funciones.definicion_antes, sacada de producción con pg_get_functiondef).
-- create or replace conserva dueño y permisos: no hay ningún grant. admin_book_class no se
-- toca. Ningún dato se modifica (el respaldo queda guardado).
--
-- Guardas (si alguna falla, no se hace nada):
--   G1) Existe el respaldo de la tanda.
--   G2) book_class hoy es la versión que dejó la migración (huella_nueva). Si alguien la cambió
--       después, no se pisa nada.
--   DESPUÉS:
--   G3) book_class vuelve a tener la huella de antes (huella_antes). Si solo difiere en
--       espacios, se acepta y se avisa.
--   G4) Permisos de book_class iguales a los del respaldo; admin_book_class idéntica (definición
--       y permisos) a la de antes del rollback.
-- =====================================================================================

begin;

do $rollback$
declare
  c_oid constant oid := 'public.book_class(uuid, date)'::regprocedure;
  c_admin constant oid := 'public.admin_book_class(uuid, uuid, date)'::regprocedure;
  v record;
  v_admin_antes text;
  v_def text;
begin
  -- G1
  if to_regclass('respaldo.tanda_rp_funciones') is null then
    raise exception 'Rollback Tanda RP: no existe respaldo.tanda_rp_funciones. No se hizo nada.';
  end if;
  select * into v from respaldo.tanda_rp_funciones where funcion = 'public.book_class(uuid, date)';
  if not found then
    raise exception 'Rollback Tanda RP: no hay respaldo de book_class. No se hizo nada.';
  end if;

  -- G2
  if md5(pg_get_functiondef(c_oid)) is distinct from v.huella_nueva then
    raise exception 'Rollback Tanda RP: book_class no es la versión que dejó la migración (huella %, se esperaba %). No se hizo nada.',
      md5(pg_get_functiondef(c_oid)), v.huella_nueva;
  end if;

  select md5(pg_get_functiondef(q.oid)) || '|' || coalesce(q.proacl::text, 'NULL') into v_admin_antes
  from pg_proc q where q.oid = c_admin;

  -- Volver a la definición de antes, tal cual.
  execute v.definicion_antes;

  -- G3
  v_def := pg_get_functiondef(c_oid);
  if md5(v_def) <> v.huella_antes then
    if md5(regexp_replace(v_def, '\s+', '', 'g')) <> md5(regexp_replace(v.definicion_antes, '\s+', '', 'g')) then
      raise exception 'Rollback Tanda RP: book_class no volvió a la definición de antes. Se deshace todo.';
    end if;
    raise notice 'Rollback Tanda RP: book_class volvió a la definición de antes (difiere solo en espacios).';
  end if;

  -- G4
  if (select coalesce(p.proacl::text, 'NULL') from pg_proc p where p.oid = c_oid) <> v.permisos then
    raise exception 'Rollback Tanda RP: los permisos de book_class no son los del respaldo. Se deshace todo.';
  end if;
  if (select md5(pg_get_functiondef(q.oid)) || '|' || coalesce(q.proacl::text, 'NULL')
      from pg_proc q where q.oid = c_admin) <> v_admin_antes then
    raise exception 'Rollback Tanda RP: cambió admin_book_class. Se deshace todo.';
  end if;

  raise notice 'Rollback Tanda RP aplicado: book_class volvió a la versión de antes (huella %).', md5(pg_get_functiondef(c_oid));
end;
$rollback$;

commit;
