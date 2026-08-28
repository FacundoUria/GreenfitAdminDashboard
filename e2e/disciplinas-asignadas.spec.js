import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// BUG CRÍTICO (2026-08-07): la fila de un socio en la tabla de Socios tiene
// que listar ÚNICA Y EXCLUSIVAMENTE las disciplinas que ese socio tiene
// asignadas en `socios.plan` -- ni en el texto de Plan/Membresía ni en el
// desglose de Créditos. Root cause encontrado: el formulario de "Nuevo
// Socio" arrancaba con 'Pase Libre' ya tildado por defecto
// (PLANES_DISPONIBLES[0] en NuevoSocioModal.jsx) -- fácil de dejar así sin
// querer al cargar un socio de Kickstrike/CrossFit, lo que además terminaba
// sincronizando un balance de Aparatos en la PWA (ver el fallback de
// sincronizarVencimientoPwa en utils/creditosPwa.js).

const DISCIPLINA_KICKSTRIKE = { id: 'disc-kickstrike', name: 'Kickstrike', kind: 'credits' }

const SOCIO_KICKSTRIKE = {
  id: 'e2e-socio-kick',
  nombre: 'Valentina',
  apellido: 'Cruz',
  dni: '20555666',
  email: 'valen@e2e.test',
  telefono: null,
  plan: ['Kickstrike'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  created_at: '2025-01-01T00:00:00.000Z',
  ultimo_pago: '2026-08-01',
  creditos: 6,
  activo: true,
}

const SOCIO_CROSSFIT = {
  id: 'e2e-socio-xfit',
  nombre: 'Nico',
  apellido: 'Paz',
  dni: '20777888',
  email: 'nico@e2e.test',
  telefono: null,
  plan: ['CrossFit'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  created_at: '2025-01-01T00:00:00.000Z',
  ultimo_pago: '2026-08-01',
  creditos: 3,
  activo: true,
}

test('un socio con solo Kickstrike no muestra "Aparatos" ni en Plan/Membresía ni en Créditos', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: {
      ...tablasBase(),
      disciplines: [...tablasBase().disciplines, DISCIPLINA_KICKSTRIKE],
      socios: [SOCIO_KICKSTRIKE],
    },
  })

  await irASocios(page)
  const fila = page.getByRole('table').getByRole('row', { name: /Valentina Cruz/ })
  await expect(fila).toBeVisible()

  await expect(fila.getByText('Kickstrike', { exact: true })).toBeVisible()
  await expect(fila.getByText('Aparatos', { exact: false })).toHaveCount(0)
  await expect(fila.getByTitle(/Aparatos/)).toHaveCount(0)
})

test('un socio con solo CrossFit no muestra "Aparatos" ni en Plan/Membresía ni en Créditos', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: { ...tablasBase(), socios: [SOCIO_CROSSFIT] },
  })

  await irASocios(page)
  const fila = page.getByRole('table').getByRole('row', { name: /Nico Paz/ })
  await expect(fila).toBeVisible()

  await expect(fila.getByText('CrossFit', { exact: true })).toBeVisible()
  await expect(fila.getByText('Aparatos', { exact: false })).toHaveCount(0)
  await expect(fila.getByTitle(/Aparatos/)).toHaveCount(0)
})

test('crear un socio nuevo marcando SOLO Kickstrike lo guarda con ese único plan -- "Pase Libre" no viaja de arrastre', async ({
  page,
}) => {
  const tables = {
    ...tablasBase(),
    disciplines: [...tablasBase().disciplines, DISCIPLINA_KICKSTRIKE],
    socios: [],
  }
  await loginComoAdmin(page, { tables })

  await irASocios(page)
  await page.getByRole('button', { name: 'Nuevo Socio' }).click()

  await page.getByLabel('Nombre').fill('Carla')
  await page.getByLabel('Apellido').fill('Suárez')
  await page.getByLabel('DNI').fill('20999000')
  await page.getByLabel('Email').fill('carla@e2e.test')
  await page.getByRole('checkbox', { name: 'Kickstrike' }).check()
  await page.getByLabel('Fecha de Inicio').fill('2026-08-01')
  await page.getByRole('button', { name: 'Guardar' }).click()

  await expect.poll(() => tables.socios.length).toBe(1)
  expect(tables.socios[0].plan).toEqual(['Kickstrike'])
})
