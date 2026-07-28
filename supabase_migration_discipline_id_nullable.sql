-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- Contexto: probé "Nueva Clase" end-to-end y falló con:
--   null value in column "discipline_id" of relation "classes" violates not-null constraint
--
-- classes.discipline_id es NOT NULL y referencia a la tabla `disciplines`, que hoy
-- está vacía. La pantalla de Clases no tiene (todavía) un selector real de disciplinas
-- vinculado a esa tabla -- el campo "Disciplina" del formulario escribe directo en
-- `classes.title` (texto libre: "Crossfit", "Yoga", etc.), así que no hay forma de
-- completar discipline_id al crear una clase nueva.
--
-- Esta es la opción mínima para desbloquear la creación de clases ya mismo. Si más
-- adelante quieren manejar disciplinas como entidad propia (con su propia pantalla de
-- ABM), avisen y conecto el formulario a la tabla `disciplines` en vez de dejar
-- discipline_id sin usar.

alter table classes
  alter column discipline_id drop not null;
