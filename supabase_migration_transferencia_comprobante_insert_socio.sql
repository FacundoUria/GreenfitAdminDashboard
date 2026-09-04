-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor).
-- NO SE CORRIÓ TODAVÍA.
--
-- ============================================================
-- POR QUÉ HACE FALTA ESTE ARCHIVO (no estaba en la Fase 1)
-- ============================================================
-- La Fase 1 (supabase_migration_transferencia_comprobante_fase1.sql)
-- agregó comprobante_url/pack_id a pagos_socio y las funciones de
-- aprobación/rechazo del ADMIN, pero pagos_socio solo tiene estas dos
-- policies (supabase_migration_ficha360.sql):
--   - pagos_socio_select_own_or_admin: SELECT propio o admin.
--   - pagos_socio_admin_write: "for all" (insert/update/delete) SOLO admin.
-- Un socio activo (no admin) NO puede insertar su propia fila pendiente
-- con un `supabase.from('pagos_socio').insert(...)` directo desde la PWA
-- -- RLS lo bloquea. Hace falta una función (mismo patrón que
-- book_class/cancel_booking/admin_aprobar_comprobante: security definer,
-- valida el rol, y NO deja que el cliente controle campos sensibles).

create or replace function public.crear_pago_pendiente_transferencia(
  p_pack_id uuid,
  p_comprobante_url text,
  p_monto numeric
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_pack_name text;
  v_id uuid;
begin
  -- is_active_socio() (supabase_migration_comunidad.sql) excluye admins a
  -- propósito -- mismo criterio que ya usa la policy de Storage
  -- "comprobantes_insert_own" de la Fase 1 para este mismo flujo.
  if not public.is_active_socio() then
    raise exception 'Esta acción requiere una cuenta de socio activa.';
  end if;

  if p_comprobante_url is null or length(trim(p_comprobante_url)) = 0 then
    raise exception 'Falta el comprobante.';
  end if;

  -- El nombre del pack ("paquete", NOT NULL en pagos_socio) sale del
  -- propio pack real, no de lo que mande el cliente -- mismo criterio que
  -- paymentsApi.ts/create-payment-preference con el precio: el cliente no
  -- decide el texto, solo indica QUÉ pack.
  select name into v_pack_name from packs where id = p_pack_id and is_active = true;
  if v_pack_name is null then
    raise exception 'El pack indicado no existe o ya no está disponible.';
  end if;

  insert into public.pagos_socio (
    user_id, paquete, monto, metodo_pago, estado, origen, pack_id, comprobante_url, created_by
  ) values (
    auth.uid(), v_pack_name, p_monto, 'transferencia', 'pendiente', 'transferencia_comprobante',
    p_pack_id, p_comprobante_url, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.crear_pago_pendiente_transferencia(uuid, text, numeric) to authenticated;

-- ── Verificación manual (correr DESPUÉS de aplicar lo de arriba) ───────
-- 1) Logueado como un socio de prueba real (activo, con cuenta PWA):
--    select crear_pago_pendiente_transferencia('<PACK_ID>', 'comprobantes-pago/<MI_USER_ID>/123.jpg', 15000);
--    Tiene que devolver un uuid nuevo.
-- 2) select estado, origen, paquete, monto, comprobante_url, pack_id
--      from pagos_socio where id = '<ESE UUID>';
--    Tiene que quedar estado='pendiente', origen='transferencia_comprobante'.
-- 3) Confirmar que otro socio (o el mismo, sin sesión) NO puede leer esa
--    fila salvo la propia (pagos_socio_select_own_or_admin ya lo cubre,
--    sin cambios en este archivo).
-- 4) Confirmar que admin_aprobar_comprobante('<ESE UUID>') (Fase 1) sigue
--    funcionando igual sobre una fila creada por esta función nueva.
