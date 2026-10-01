-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- Exige DNI válido (6 a 10 dígitos, mismo criterio que NuevoSocioModal.jsx y
-- handle_socio_dni_upsert) en toda fila NUEVA de `socios` y en todo CAMBIO de
-- DNI -- para que una importación nueva o una carga manual desde el Table
-- Editor no vuelva a crear socios sin DNI (que quedan sin cuenta en la app y
-- sin ningún cruce posible con profiles/user_credits).
--
-- Es un trigger y no un NOT NULL/CHECK a propósito: hay socios históricos sin
-- DNI válido (683 al 2026-10-01), y una constraint (aun NOT VALID) se evalúa
-- en CADA update de la fila -- bloquearía cualquier edición de esos socios
-- (créditos, vencimiento, baja, teléfono) hasta cargarles el DNI. El día que
-- estén todos cargados se puede sumar el NOT NULL + CHECK reales encima.
--
-- No modifica ninguna fila existente. Idempotente.
-- Probar con prueba_socios_dni_obligatorio.sql.

create or replace function public.validar_dni_socio()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- En UPDATE, si el DNI no cambia no se valida: los socios históricos sin
  -- DNI válido se tienen que poder seguir editando (créditos, vencimiento,
  -- baja, teléfono) hasta que se les cargue el DNI a mano.
  if TG_OP = 'UPDATE' and NEW.dni is not distinct from OLD.dni then
    return NEW;
  end if;

  if NEW.dni is null or NEW.dni !~ '^\d{6,10}$' then
    raise exception 'El DNI del socio es obligatorio y tiene que tener entre 6 y 10 dígitos, sin puntos ni espacios (recibido: %).',
      coalesce('"' || NEW.dni || '"', 'vacío')
      using errcode = '23514', constraint = 'socios_dni_valido';
  end if;

  return NEW;
end;
$$;

drop trigger if exists socios_validar_dni on public.socios;
create trigger socios_validar_dni
  before insert or update on public.socios
  for each row execute function public.validar_dni_socio();
