-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- bookings.attended era boolean NOT NULL default false -- toda reserva
-- nacía marcada "Ausente" aunque la clase todavía no hubiera pasado. El
-- roster viejo (asistencias.asistio) sí distinguía "sin marcar" de
-- "ausente"; esto restaura ese tercer estado para bookings.

alter table bookings alter column attended drop not null;
alter table bookings alter column attended set default null;
