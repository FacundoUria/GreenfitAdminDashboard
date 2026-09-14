import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS } from './support/fixtures.js'
import { irASocios } from './support/nav.js'
import { mockAdminEditarFechaVencimientoSocio } from './support/rpcMocks.js'

// CAMBIO 3 -- "Vencimiento del plan" en "Editar Socio" (CreditosEditablesSocio.jsx):
// editar la fecha única del plan mueve TODAS las disciplinas activas +
// Aparatos a la vez, sin tocar cantidades. ADITIVO -- admin_editar_fecha_
// vencimiento_socio() es un RPC nuevo, no reemplaza a "Cobrar".

const DISCIPLINA_BOXEO = { id: 'disc-boxeo', name: 'Boxeo', kind: 'credits' }

const SOCIO_MULTI = {
  id: 'e2e-socio-fecha-plan',
  nombre: 'Facundo',
  apellido: 'Uria',
  dni: '20333444',
  email: 'facundo@e2e.test',
  telefono: null,
  plan: ['CrossFit', 'Boxeo', 'Aparatos'],
  estado: 'Activo',
  fecha_vencimiento: '2026-10-05',
  dia_corte: null,
  created_at: '2025-01-01T00:00:00.000Z',
  ultimo_pago: '2026-08-01',
  creditos: 8,
  activo: true,
}

const PROFILE_MULTI = {
  id: 'e2e-profile-fecha-plan',
  dni: SOCIO_MULTI.dni,
  full_name: 'Facundo Uria',
  avatar_url: null,
  created_at: '2025-01-01T00:00:00.000Z',
  role: 'socio',
}

// Las 3 filas (CrossFit, Boxeo, Aparatos) con la MISMA fecha -- el caso real
// que describe el ticket bajo "plan único".
const FECHA_ACTUAL = '2026-10-05T12:00:00.000Z'

function userCreditsIniciales() {
  return [
    {
      id: 'uc-crossfit',
      user_id: PROFILE_MULTI.id,
      discipline_id: DISCIPLINA_CROSSFIT.id,
      remaining_credits: 6,
      expires_at: FECHA_ACTUAL,
      created_at: '2026-08-01T00:00:00.000Z',
      discipline: DISCIPLINA_CROSSFIT,
    },
    {
      id: 'uc-boxeo',
      user_id: PROFILE_MULTI.id,
      discipline_id: DISCIPLINA_BOXEO.id,
      remaining_credits: 2,
      expires_at: FECHA_ACTUAL,
      created_at: '2026-08-01T00:00:00.000Z',
      discipline: DISCIPLINA_BOXEO,
    },
    {
      id: 'uc-aparatos',
      user_id: PROFILE_MULTI.id,
      discipline_id: DISCIPLINA_APARATOS.id,
      remaining_credits: null,
      expires_at: FECHA_ACTUAL,
      created_at: '2026-08-01T00:00:00.000Z',
      discipline: DISCIPLINA_APARATOS,
    },
  ]
}

test('editar el vencimiento del plan mueve CrossFit + Boxeo + Aparatos al mismo valor nuevo, cantidades intactas', async ({
  page,
}) => {
  const tables = {
    ...tablasBase(),
    disciplines: [...tablasBase().disciplines, DISCIPLINA_BOXEO],
    socios: [SOCIO_MULTI],
    profiles: [PROFILE_MULTI],
    user_credits: userCreditsIniciales(),
  }

  page.on('dialog', (dialog) => dialog.accept())

  await loginComoAdmin(page, {
    tables,
    rpc: { admin_editar_fecha_vencimiento_socio: mockAdminEditarFechaVencimientoSocio(tables) },
  })

  await irASocios(page)
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Facundo Uria/ })
  await filaTabla.getByTitle('Editar').click()
  await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

  // Fecha actual visible antes de tocar nada.
  await expect(page.getByText('Vencimiento del plan:')).toBeVisible()
  await expect(page.getByText('05/10/2026', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Editar vencimiento del plan' }).click()
  await page.getByLabel('Nueva fecha de vencimiento del plan').fill('2027-01-15')
  await page.getByText('Guardar fecha').click()

  // Las 3 filas reales quedaron en la fecha nueva -- cantidades sin tocar.
  await expect.poll(() => tables.user_credits.find((f) => f.id === 'uc-crossfit').expires_at).toContain('2027-01-15')
  await expect.poll(() => tables.user_credits.find((f) => f.id === 'uc-boxeo').expires_at).toContain('2027-01-15')
  await expect.poll(() => tables.user_credits.find((f) => f.id === 'uc-aparatos').expires_at).toContain('2027-01-15')
  expect(tables.user_credits.find((f) => f.id === 'uc-crossfit').remaining_credits).toBe(6)
  expect(tables.user_credits.find((f) => f.id === 'uc-boxeo').remaining_credits).toBe(2)

  // Espejo en socios.fecha_vencimiento también actualizado.
  expect(tables.socios.find((s) => s.dni === SOCIO_MULTI.dni).fecha_vencimiento).toBe('2027-01-15')

  // El label de la sección refleja la fecha nueva.
  await expect(page.getByText('15/01/2027', { exact: true })).toBeVisible()
})

test('un socio SIN nada activo no muestra "Vencimiento del plan" -- la opción no existe en absoluto', async ({ page }) => {
  const SOCIO_SIN_NADA = { ...SOCIO_MULTI, id: 'e2e-socio-sin-nada', dni: '20555666', fecha_vencimiento: null }
  const PROFILE_SIN_NADA = { ...PROFILE_MULTI, id: 'e2e-profile-sin-nada', dni: SOCIO_SIN_NADA.dni }

  const tables = {
    ...tablasBase(),
    socios: [SOCIO_SIN_NADA],
    profiles: [PROFILE_SIN_NADA],
    user_credits: [],
  }

  await loginComoAdmin(page, { tables })

  await irASocios(page)
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Facundo Uria/ })
  await filaTabla.getByTitle('Editar').click()
  await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

  await expect(page.getByText('Vencimiento del plan:')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Editar vencimiento del plan' })).toHaveCount(0)
})
