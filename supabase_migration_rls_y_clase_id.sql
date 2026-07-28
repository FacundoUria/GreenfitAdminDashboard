-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- Contexto: la app hoy usa la clave publicable (anon) sin login. Verifiqué en vivo que:
--   - INSERT en socios/classes/asistencias falla con 401 "new row violates row-level
--     security policy" (esto SÍ se ve como error en la app).
--   - UPDATE en socios/classes devuelve 200/204 "exitoso" pero afecta 0 filas (RLS lo
--     descarta en silencio) -> "Registrar Pago" parecía funcionar y no guardaba nada.
--   - asistencias.clase_id quedó como bigint después de migrar clases -> classes (que
--     usa uuid), así que ninguna asistencia puede referenciar una clase real todavía.
--
-- Esto habilita lectura/escritura para el rol `anon` en las 3 tablas. Cuando agreguen
-- login de verdad, reemplacen `anon` por `authenticated` (y agreguen policies acordes,
-- p.ej. filtrando por usuario/rol) en vez de dejarlo abierto a cualquiera con la key.

-- ── socios ──────────────────────────────────────────────────────────────
alter table socios enable row level security;

drop policy if exists "anon select socios" on socios;
drop policy if exists "anon insert socios" on socios;
drop policy if exists "anon update socios" on socios;
drop policy if exists "anon delete socios" on socios;

create policy "anon select socios" on socios for select to anon using (true);
create policy "anon insert socios" on socios for insert to anon with check (true);
create policy "anon update socios" on socios for update to anon using (true) with check (true);
create policy "anon delete socios" on socios for delete to anon using (true);

-- ── classes ─────────────────────────────────────────────────────────────
alter table classes enable row level security;

drop policy if exists "anon select classes" on classes;
drop policy if exists "anon insert classes" on classes;
drop policy if exists "anon update classes" on classes;
drop policy if exists "anon delete classes" on classes;

create policy "anon select classes" on classes for select to anon using (true);
create policy "anon insert classes" on classes for insert to anon with check (true);
create policy "anon update classes" on classes for update to anon using (true) with check (true);
create policy "anon delete classes" on classes for delete to anon using (true);

-- ── asistencias ─────────────────────────────────────────────────────────
alter table asistencias enable row level security;

drop policy if exists "anon select asistencias" on asistencias;
drop policy if exists "anon insert asistencias" on asistencias;
drop policy if exists "anon update asistencias" on asistencias;
drop policy if exists "anon delete asistencias" on asistencias;

create policy "anon select asistencias" on asistencias for select to anon using (true);
create policy "anon insert asistencias" on asistencias for insert to anon with check (true);
create policy "anon update asistencias" on asistencias for update to anon using (true) with check (true);
create policy "anon delete asistencias" on asistencias for delete to anon using (true);

-- ── fix: asistencias.clase_id debe ser uuid para poder referenciar classes.id ──
-- (la tabla está vacía hoy, así que este cambio de tipo es seguro / no pierde datos)
alter table asistencias
  alter column clase_id type uuid using clase_id::text::uuid;

alter table asistencias
  add constraint asistencias_clase_id_fkey foreign key (clase_id) references classes(id);
