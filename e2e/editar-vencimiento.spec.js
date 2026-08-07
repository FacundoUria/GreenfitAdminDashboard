import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// Socio de plan "por vencimiento" (Aparatos / Musculación) con fecha ya
// cargada -- para probar la edición DIRECTA, sin pasar por "Registrar Pago".
const SOCIO_APARATOS = {
  id: 'e2e-socio-aparatos',
  nombre: 'Lucía',
  apellido: 'Paz',
  dni: '30222333',
  email: 'lucia@e2e.test',
  telefono: '2610000001',
  plan: ['Aparatos / Musculación'],
  estado: 'Activo',
  fecha_vencimiento: '2026-08-10',
  dia_corte: 10,
  created_at: '2025-02-01T00:00:00.000Z',
  ultimo_pago: '2026-07-10',
  creditos: 0,
  activo: true,
}

const PROFILE_APARATOS = {
  id: 'e2e-profile-aparatos',
  dni: SOCIO_APARATOS.dni,
  full_name: 'Lucía Paz',
  role: 'socio',
  created_at: '2025-02-01T00:00:00.000Z',
}

test.describe('Admin -- Edición directa de vencimiento (sin pasar por "Cobrar")', () => {
  test('editar la fecha de vencimiento desde "Editar Socio" persiste en socios Y sincroniza con la PWA', async ({
    page,
  }) => {
    const tablas = { ...tablasBase(), socios: [SOCIO_APARATOS], profiles: [PROFILE_APARATOS] }
    await loginComoAdmin(page, { tables: tablas })

    await irASocios(page)
    await expect(page.getByRole('table').getByText('Lucía Paz')).toBeVisible()
    await page.locator('[title="Editar"]:visible').click()

    await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()
    const inputFecha = page.getByLabel('Fecha de vencimiento')
    await expect(inputFecha).toHaveValue('2026-08-10')

    await inputFecha.fill('2026-09-15')
    await page.getByRole('button', { name: 'Guardar' }).click()

    await expect(page.getByText('Vencimiento actualizado')).toBeVisible()

    // Persistió en `socios` -- el vencimiento nuevo y el dia_corte
    // recalculado del día-del-mes de esa fecha (15).
    expect(tablas.socios[0].fecha_vencimiento).toBe('2026-09-15')
    expect(tablas.socios[0].dia_corte).toBe(15)

    // Se sincronizó con la PWA -- sin esto, la app le seguiría mostrando la
    // fecha vieja hasta el próximo "Registrar Pago" (el bug que se pidió cerrar).
    const filaSync = tablas.user_credits.find((uc) => uc.user_id === PROFILE_APARATOS.id)
    expect(filaSync, 'esperaba una fila nueva en user_credits para el socio').toBeTruthy()
    expect(filaSync.expires_at).toContain('2026-09-15')
  })

  test('un socio 100% de créditos no muestra el campo de vencimiento al editar (no le aplica)', async ({ page }) => {
    await loginComoAdmin(page, { tables: tablasBase() }) // socio base del fixture: plan ['CrossFit']

    await irASocios(page)
    await page.locator('[title="Editar"]:visible').click()
    await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()
    await expect(page.getByLabel('Fecha de vencimiento')).toHaveCount(0)
  })
})
