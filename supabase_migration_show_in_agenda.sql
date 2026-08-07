-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- Switch de visibilidad por disciplina en la Agenda de reservas de la PWA
-- (checklist punto 2). Pensado para "pases libres" como Aparatos/
-- Musculación -- no tienen turnos que reservar (es acceso libre por
-- vencimiento), así que sus franjas horarias (cargadas en `classes` solo
-- para mostrar el horario del gimnasio en la landing/Disciplinas) no
-- deberían aparecer como "clases para reservar" en la Agenda del socio.
--
-- A propósito es una columna DISTINTA de `is_active`:
--   - is_active = la disciplina existe/se puede vender (afecta TODO:
--     Admin, PWA, Landing).
--   - show_in_agenda = sus clases aparecen en la Agenda de RESERVAS de la
--     PWA (no afecta la Landing, que sigue mostrando horarios de
--     Aparatos siempre -- ver index.html, filtra solo por is_active).
--
-- Default true: ninguna disciplina existente cambia de comportamiento
-- hasta que alguien la desmarque a mano desde "Editar Disciplina".
alter table disciplines
  add column if not exists show_in_agenda boolean not null default true;
