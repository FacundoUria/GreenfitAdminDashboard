import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT } from './support/fixtures.js'
import { irASocios } from './support/nav.js'
import { mockAdminAcreditarCreditosManual } from './support/rpcMocks.js'

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

// Fase 2 (NuevoSocioModal.jsx) -- el alta CON créditos iniciales ya no usa
// sincronizarCreditosPwa()/sincronizarVencimientoPwa() por disciplina
// suelta, llama a admin_acreditar_creditos_manual() (Fase 1) una sola vez
// con todo junto.
const PROFILE_FACUNDO = {
  id: 'e2e-profile-facundo-alta',
  dni: '44537978',
  full_name: 'Facundo Uria',
  avatar_url: null,
  created_at: '2026-08-01T00:00:00.000Z',
  role: 'socio',
}

test('alta de socio nuevo CON créditos iniciales de 2 disciplinas -- ambas quedan con la misma fecha', async ({ page }) => {
  const tables = {
    ...tablasBase(),
    disciplines: [...tablasBase().disciplines, DISCIPLINA_KICKSTRIKE],
    socios: [],
    // Pre-sembrado -- en producción esta fila la crea el trigger
    // on_socio_dni_upsert de forma asíncrona apenas se inserta el socio
    // (ver esperarCuentaPwa en NuevoSocioModal.jsx); el mock E2E no simula
    // ese trigger, así que se simula el caso "la cuenta ya está lista" (el
    // primer intento de esperarCuentaPwa la encuentra) en vez de la
    // condición de carrera en sí -- eso ya lo cubre el propio código de
    // esperarCuentaPwa, no es el foco de este test.
    profiles: [PROFILE_FACUNDO],
  }
  await loginComoAdmin(page, {
    tables,
    rpc: { admin_acreditar_creditos_manual: mockAdminAcreditarCreditosManual(tables) },
  })

  await irASocios(page)
  await page.getByRole('button', { name: 'Nuevo Socio' }).click()

  await page.getByLabel('Nombre').fill('Facundo')
  await page.getByLabel('Apellido').fill('Uria')
  await page.getByLabel('DNI').fill(PROFILE_FACUNDO.dni)
  await page.getByLabel('Email').fill('facundo@e2e.test')
  await page.getByRole('checkbox', { name: 'CrossFit' }).check()
  await page.getByRole('checkbox', { name: 'Kickstrike' }).check()
  await page.getByLabel('Fecha de Inicio').fill('2026-08-01')

  // Créditos iniciales por actividad -- un input propio por disciplina de
  // créditos tildada (#credito-<Disciplina>, ver NuevoSocioModal.jsx).
  await page.locator('#credito-CrossFit').fill('12')
  await page.locator('#credito-Kickstrike').fill('12')

  await page.getByRole('button', { name: 'Guardar' }).click()

  await expect.poll(() => tables.socios.length).toBe(1)
  // Ningún aviso de "no se pudieron cargar los créditos" -- si algo hubiera
  // fallado en el RPC, handleSubmit dispara un window.alert() con ese
  // mensaje y el test se colgaría esperando el diálogo sin este chequeo.
  await expect(page.getByRole('heading', { name: 'Nuevo Socio' })).toHaveCount(0)

  const filasCrossfit = tables.user_credits.filter((f) => f.discipline_id === DISCIPLINA_CROSSFIT.id)
  const filasKickstrike = tables.user_credits.filter((f) => f.discipline_id === DISCIPLINA_KICKSTRIKE.id)
  expect(filasCrossfit).toHaveLength(1)
  expect(filasKickstrike).toHaveLength(1)
  expect(filasCrossfit[0].remaining_credits).toBe(12)
  expect(filasKickstrike[0].remaining_credits).toBe(12)
  // Plan único -- una sola fecha para las dos disciplinas de este alta.
  expect(filasCrossfit[0].expires_at).toBe(filasKickstrike[0].expires_at)

  expect(tables.socios[0].creditos).toBe(24)
})
