-- =====================================================================================
-- ROLLBACK de Tanda EC (supabase_migration_tanda_ec_clase_en_curso.sql).
-- NO SE CORRIÓ TODAVÍA. ESTAMOS EN PRODUCCIÓN. Solo si la prueba falla.
--
-- Vuelve book_class a la versión de la Tanda RP ("Esta clase ya empezó"), ejecutando tal
-- cual la definición guardada en respaldo.tanda_ec_funciones.definicion_antes. create or
-- replace conserva dueño y permisos: no hay ningún grant. admin_book_class no se toca.
-- Ningún dato se modifica (el respaldo queda guardado).
-- Si la PWA ya se publicó con la Tanda EC, conviene volverla atrás también: con este rollback
-- la Agenda mostraría clases en curso que el servidor rechaza ("Esta clase ya empezó").
--
-- Guardas (si alguna falla, no se hace nada):
--   G1) Existe el respaldo de la tanda.
--   G2) book_class hoy es la versión que dejó la Tanda EC (huella_nueva). Si alguien la cambió
--       después, no se pisa nada.
--   DESPUÉS:
--   G3) book_class vuelve a la huella de antes (la de la Tanda RP). Si solo difiere en
--       espacios, se acepta y se avisa.
--   G4) Permisos de book_class iguales a los del respaldo; admin_book_class idéntica.
-- =====================================================================================

begin;

do $rollback$
declare
  c_oid   constant oid := 'public.book_class(uuid, date)'::regprocedure;
  c_admin constant oid := 'public.admin_book_class(uuid, uuid, date)'::regprocedure;
  v record;
  v_admin_antes text;
  v_def text;
begin
  -- G1
  if to_regclass('respaldo.tanda_ec_funciones') is null then
    raise exception 'Rollback Tanda EC: no existe respaldo.tanda_ec_funciones. No se hizo nada.';
  end if;
  select * into v from respaldo.tanda_ec_funciones where funcion = 'public.book_class(uuid, date)';
  if not found then
    raise exception 'Rollback Tanda EC: no hay respaldo de book_class. No se hizo nada.';
  end if;

  -- G2
  if md5(pg_get_functiondef(c_oid)) is distinct from v.huella_nueva then
    raise exception 'Rollback Tanda EC: book_class no es la versión que dejó la Tanda EC (huella %, se esperaba %). No se hizo nada.',
      md5(pg_get_functiondef(c_oid)), v.huella_nueva;
  end if;

  select md5(pg_get_functiondef(q.oid)) || '|' || coalesce(q.proacl::text, 'NULL') into v_admin_antes
  from pg_proc q where q.oid = c_admin;

  -- Volver a la versión de la Tanda RP, tal cual.
  execute v.definicion_antes;

  -- G3
  v_def := pg_get_functiondef(c_oid);
  if md5(v_def) <> v.huella_antes then
    if md5(regexp_replace(v_def, '\s+', '', 'g')) <> md5(regexp_replace(v.definicion_antes, '\s+', '', 'g')) then
      raise exception 'Rollback Tanda EC: book_class no volvió a la versión de la Tanda RP. Se deshace todo.';
    end if;
    raise notice 'Rollback Tanda EC: book_class volvió a la versión de la Tanda RP (difiere solo en espacios).';
  end if;

  -- G4
  if (select coalesce(p.proacl::text, 'NULL') from pg_proc p where p.oid = c_oid) <> v.permisos then
    raise exception 'Rollback Tanda EC: los permisos de book_class no son los del respaldo. Se deshace todo.';
  end if;
  if (select md5(pg_get_functiondef(q.oid)) || '|' || coalesce(q.proacl::text, 'NULL')
      from pg_proc q where q.oid = c_admin) <> v_admin_antes then
    raise exception 'Rollback Tanda EC: cambió admin_book_class. Se deshace todo.';
  end if;

  raise notice 'Rollback Tanda EC aplicado: book_class volvió a la versión de la Tanda RP (huella %).', md5(pg_get_functiondef(c_oid));
end;
$rollback$;

commit;
