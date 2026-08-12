import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// Lógica inteligente de fechas -- EXCLUSIVA de "Registrar Pago". Cubre los
// dos casos pedidos y, en el mismo spec, que "Editar Socio" (el otro lugar
// donde se puede tocar fecha_vencimiento) NO cambió: sigue mostrando la
// fecha real de la base tal cual está, vencida o no.

// Mismo criterio UTC que registrar-pago-fechas.spec.js/cobro-mostrador.spec.js
// -- evita que un test corrido cerca de medianoche en un huso detrás de UTC
// calcule "hoy" distinto de lo que calcula el browser.
function isoUTC(date) {
  return date.toISOString().slice(0, 10)
}
function sumarDiasUTC(iso, dias) {
  const fecha = new Date(`${iso}T00:00:00.000Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return isoUTC(fecha)
}

const HOY = isoUTC(new Date())
const VENCIMIENTO_VENCIDO = sumarDiasUTC(HOY, -10) // venció hace 10 días
const VENCIMIENTO_FUTURO = sumarDiasUTC(HOY, 15) // vence en 15 días

const SOCIO_VENCIDO = {
  id: 'e2e-socio-vencido-inteligente',
  nombre: 'Diego',
  apellido: 'Morales',
  dni: '28777888',
  email: 'diego@e2e.test',
  telefono: '2610000005',
  plan: ['Pase Libre'],
  estado: 'Vencido',
  fecha_vencimiento: VENCIMIENTO_VENCIDO,
  dia_corte: new Date(`${VENCIMIENTO_VENCIDO}T00:00:00`).getDate(),
  created_at: '2025-02-01T00:00:00.000Z',
  ultimo_pago: sumarDiasUTC(VENCIMIENTO_VENCIDO, -30),
  creditos: 0,
  activo: true,
}

const SOCIO_ACTIVO = {
  id: 'e2e-socio-activo-inteligente',
  nombre: 'Estefanía',
  apellido: 'Ríos',
  dni: '28888999',
  email: 'estefania@e2e.test',
  telefono: '2610000006',
  plan: ['Pase Libre'],
  estado: 'Activo',
  fecha_vencimiento: VENCIMIENTO_FUTURO,
  dia_corte: new Date(`${VENCIMIENTO_FUTURO}T00:00:00`).getDate(),
  created_at: '2025-02-01T00:00:00.000Z',
  ultimo_pago: sumarDiasUTC(VENCIMIENTO_FUTURO, -30),
  creditos: 0,
  activo: true,
}

test.describe('Registrar Pago -- sugerencia inteligente de fechas', () => {
  test('Caso 1 (socio VENCIDO): sugiere fecha de inicio = HOY y vencimiento = HOY + 1 mes', async ({ page }) => {
    await loginComoAdmin(page, { tables: { ...tablasBase(), socios: [SOCIO_VENCIDO] } })

    await irASocios(page)
    await expect(page.getByRole('table').getByText('Diego Morales')).toBeVisible()
    await page.locator('[title="Registrar Pago / Renovar Cuota"]:visible').click()
    await expect(page.getByText('Registrar Pago / Renovar Cuota')).toBeVisible()

    // Aviso explícito de que está vencido, no el texto genérico de "vencimiento actual".
    await expect(page.getByText(/El socio está vencido/)).toBeVisible()

    await expect(page.getByLabel('Fecha de inicio')).toHaveValue(HOY)

    const vencimientoEsperado = new Date(`${HOY}T00:00:00`)
    vencimientoEsperado.setMonth(vencimientoEsperado.getMonth() + 1)
    const anio = vencimientoEsperado.getFullYear()
    const mes = String(vencimientoEsperado.getMonth() + 1).padStart(2, '0')
    const dia = String(vencimientoEsperado.getDate()).padStart(2, '0')
    await expect(page.getByLabel('Fecha de vencimiento')).toHaveValue(`${anio}-${mes}-${dia}`)
  })

  test('Caso 2 (socio ACTIVO, vencimiento futuro): mantiene la sugerencia original -- inicio = vencimiento vigente', async ({
    page,
  }) => {
    await loginComoAdmin(page, { tables: { ...tablasBase(), socios: [SOCIO_ACTIVO] } })

    await irASocios(page)
    await expect(page.getByRole('table').getByText('Estefanía Ríos')).toBeVisible()
    await page.locator('[title="Registrar Pago / Renovar Cuota"]:visible').click()
    await expect(page.getByText('Registrar Pago / Renovar Cuota')).toBeVisible()

    await expect(page.getByText(/El socio está vencido/)).toHaveCount(0)
    await expect(page.getByLabel('Fecha de inicio')).toHaveValue(VENCIMIENTO_FUTURO)
    await expect(page.getByLabel('Fecha de vencimiento')).not.toHaveValue(VENCIMIENTO_FUTURO)
  })

  // RESTRICCIÓN ESTRICTA del ticket: la lógica inteligente de arriba es
  // EXCLUSIVA de "Registrar Pago" -- "Editar Socio" tiene que seguir
  // mostrando la fecha real de la base tal cual está, aunque sea del
  // pasado. Mismo socio VENCIDO del Caso 1, pero por la otra puerta.
  test('Editar Socio (aislado): sigue mostrando la fecha_vencimiento REAL y vencida, sin "inteligencia" ninguna', async ({
    page,
  }) => {
    await loginComoAdmin(page, { tables: { ...tablasBase(), socios: [SOCIO_VENCIDO] } })

    await irASocios(page)
    await expect(page.getByRole('table').getByText('Diego Morales')).toBeVisible()
    await page.locator('[title="Editar"]:visible').click()
    await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

    // La fecha real y vencida, no HOY -- ninguna sugerencia "inteligente" acá.
    await expect(page.getByLabel('Fecha de vencimiento')).toHaveValue(VENCIMIENTO_VENCIDO)
    await expect(page.getByLabel('Fecha de vencimiento')).not.toHaveValue(HOY)
  })
})
