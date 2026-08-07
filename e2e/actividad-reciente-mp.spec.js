import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, PROFILE_MARTINA } from './support/fixtures.js'

// Checklist "Registro en Actividad Reciente": una compra aprobada por
// Mercado Pago (mp_process_payment la inserta en pagos_socio, ver
// backend/supabase_migration_mercadopago_payments.sql en greenfit-app) se
// ve en el Dashboard del Admin -- sin ninguna tabla de auditoría nueva, se
// reusa pagos_socio (mismo criterio de "una sola fuente de verdad" que ya
// usan Reservas/Check-ins/Reversiones en este mismo widget).
test('una compra aprobada por Mercado Pago aparece en Actividad Reciente con el detalle completo', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: {
      ...tablasBase(),
      pagos_socio: [
        {
          id: 'pago-mp-1',
          user_id: PROFILE_MARTINA.id,
          paquete: 'Pack 12 clases CrossFit',
          monto: 30000,
          metodo_pago: 'mercado_pago',
          estado: 'pagado',
          origen: 'mercado_pago',
          mercado_pago_payment_id: 'mp-98765',
          created_at: new Date().toISOString(),
          profiles: { full_name: 'Martina Ríos' },
        },
      ],
    },
  })

  await expect(page.getByText('Actividad Reciente')).toBeVisible()
  await expect(
    page.getByText(/Martina Ríos.*Compró Pack 12 clases CrossFit por \$.*30\.000.*\(Mercado Pago\)/),
  ).toBeVisible()
})

// Un intento pendiente/rechazado no es "actividad" todavía -- solo lo
// aprobado (estado='pagado') tiene que verse acá. tablasBase() ya trae sus
// propios xp_events (asistencias reales de Martina), así que el feed NO
// está vacío -- lo que se prueba puntualmente es que ESTE pago pendiente
// en particular no aparece mezclado ahí.
test('un pago pendiente de Mercado Pago (todavía no aprobado) NO aparece en Actividad Reciente', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: {
      ...tablasBase(),
      pagos_socio: [
        {
          id: 'pago-mp-pendiente',
          user_id: PROFILE_MARTINA.id,
          paquete: 'Pack 12 clases CrossFit',
          monto: 30000,
          metodo_pago: 'mercado_pago',
          estado: 'pendiente',
          origen: 'mercado_pago',
          mercado_pago_payment_id: 'mp-11111',
          created_at: new Date().toISOString(),
          profiles: { full_name: 'Martina Ríos' },
        },
      ],
    },
  })

  await expect(page.getByText('Actividad Reciente')).toBeVisible()
  await expect(page.getByText(/Mercado Pago/)).toHaveCount(0)
})
