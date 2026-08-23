import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// Bug crítico reportado: el import masivo de Crossfy (scripts/importar_socios.js)
// trajo ~750 socios sin DNI cargado (matcheados solo por email en ese
// script) -- esos socios nunca tuvieron un balance real inicializado en
// user_credits (ver parche_creditos_sin_dni.sql), y clickear sus botones
// de crédito en el panel operaba sobre algo que nunca existió. Fix:
// bloquear la acción de entrada con un mensaje claro, en vez de dejar que
// siga adelante contra un estado inconsistente.
const SOCIO_SIN_DNI = {
  id: 'e2e-socio-sin-dni',
  nombre: 'Valentina',
  apellido: 'Cruz',
  dni: null,
  email: 'valentina@e2e.test',
  telefono: null,
  plan: ['CrossFit'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  created_at: '2025-03-01T00:00:00.000Z',
  ultimo_pago: '2026-07-01',
  creditos: 5,
  activo: true,
}

test.describe('Admin -- Socios sin DNI cargado (import masivo de Crossfy)', () => {
  test('intentar sumar/restar créditos a un socio sin DNI muestra la alerta y NO toca nada', async ({ page }) => {
    let mensajeAlerta = null
    const tablas = { ...tablasBase(), socios: [SOCIO_SIN_DNI] }
    await loginComoAdmin(page, { tables: tablas })

    page.once('dialog', async (dialog) => {
      mensajeAlerta = dialog.message()
      await dialog.accept()
    })

    await irASocios(page)
    await expect(page.getByRole('table').getByText('Valentina Cruz')).toBeVisible()

    await page.locator('[title="Sumar 1 crédito a CrossFit"]:visible').first().click()

    await expect.poll(() => mensajeAlerta).toBe(
      'No se pueden editar créditos: Este socio no tiene el DNI cargado. Por favor, edite el perfil y agregue el DNI primero.',
    )

    // El pozo global de socios.creditos no se tocó -- la acción se bloqueó
    // ANTES de llegar al UPDATE.
    expect(tablas.socios[0].creditos).toBe(5)
  })

  test('un socio CON DNI sigue pudiendo sumar créditos normalmente (no se rompió el caso sano)', async ({ page }) => {
    const socioConDni = { ...SOCIO_SIN_DNI, id: 'e2e-socio-con-dni', dni: '30777888' }
    const tablas = { ...tablasBase(), socios: [socioConDni] }
    await loginComoAdmin(page, { tables: tablas })

    await irASocios(page)
    await page.locator('[title="Sumar 1 crédito a CrossFit"]:visible').first().click()

    await expect.poll(() => tablas.socios[0].creditos).toBe(6)
  })
})
