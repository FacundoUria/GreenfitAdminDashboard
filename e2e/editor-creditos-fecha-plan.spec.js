import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS } from './support/fixtures.js'
import { irASocios } from './support/nav.js'
import {
  mockAdminFijarCreditosDisciplina,
  mockAdminAjustarCreditoDisciplina,
  mockAdminAgregarAparatosSocio,
} from './support/rpcMocks.js'

// T3 (supabase_migration_t3_fecha_plan_editor_creditos.sql) -- el editor de
// créditos de "Editar Socio" y "+ Agregar Aparatos" usan la fecha del plan
// calculada ANTES de tocar nada. Los mocks de rpcMocks.js simulan el RPC T3;
// la prueba real de la base es prueba_t3.sql. Fechas relativas a HOY en
// Argentina.

const DISCIPLINA_BOXEO = { id: 'disc-boxeo', name: 'Boxeo', kind: 'credits' }

function hoyArgentinaISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Mendoza',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function sumarDias(fechaISO, dias) {
  const fecha = new Date(`${fechaISO}T00:00:00.000Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

// A las 18:00 de Argentina de ese día (como un pago real, con hora).
const a18hsArgentina = (fechaISO) => new Date(`${fechaISO}T18:00:00-03:00`).toISOString()

const HOY = hoyArgentinaISO()
const DIA_PLAN = sumarDias(HOY, 10)

const SOCIO = {
  id: 'e2e-socio-t3',
  nombre: 'Facundo',
  apellido: 'Uria',
  dni: '20333444',
  email: 'facundo@e2e.test',
  telefono: null,
  plan: ['CrossFit', 'Boxeo'],
  estado: 'Activo',
  fecha_vencimiento: DIA_PLAN,
  dia_corte: null,
  created_at: '2025-01-01T00:00:00.000Z',
  ultimo_pago: '2026-08-01',
  creditos: 6,
  activo: true,
}

const PROFILE = {
  id: 'e2e-profile-t3',
  dni: SOCIO.dni,
  full_name: 'Facundo Uria',
  avatar_url: null,
  created_at: '2025-01-01T00:00:00.000Z',
  role: 'socio',
}

function fila(id, disciplina, remaining, expiresAt, createdAt = '2026-08-01T00:00:00.000Z') {
  return {
    id,
    user_id: PROFILE.id,
    discipline_id: disciplina.id,
    remaining_credits: remaining,
    expires_at: expiresAt,
    created_at: createdAt,
    discipline: disciplina,
  }
}

function tablas(userCredits) {
  return {
    ...tablasBase(),
    disciplines: [
      { ...DISCIPLINA_CROSSFIT, is_active: true },
      { ...DISCIPLINA_BOXEO, is_active: true },
      { ...DISCIPLINA_APARATOS, is_active: true },
    ],
    socios: [{ ...SOCIO }],
    profiles: [PROFILE],
    user_credits: userCredits,
  }
}

async function abrirEditarSocio(page) {
  await irASocios(page)
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Facundo Uria/ })
  await filaTabla.getByTitle('Editar').click()
  await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()
}

test('T3 -- fijar usa la fecha del plan aunque haya un residuo en 0 más nuevo de otra disciplina, y vence el lote de otra fecha', async ({
  page,
}) => {
  const tables = tablas([
    fila('uc-crossfit', DISCIPLINA_CROSSFIT, 6, a18hsArgentina(DIA_PLAN)),
    fila('uc-crossfit-otra', DISCIPLINA_CROSSFIT, 0, a18hsArgentina(sumarDias(HOY, 4))),
    // Residuo en 0 de Boxeo, creado DESPUÉS y con otra fecha: antes de T3, la
    // fecha salía de acá.
    fila('uc-boxeo-residuo', DISCIPLINA_BOXEO, 0, a18hsArgentina(sumarDias(HOY, 25)), new Date().toISOString()),
  ])
  page.on('dialog', (dialog) => dialog.accept())
  await loginComoAdmin(page, { tables, rpc: { admin_fijar_creditos_disciplina: mockAdminFijarCreditosDisciplina(tables) } })

  await abrirEditarSocio(page)
  await page.getByLabel('Créditos de CrossFit').fill('8')
  // El "Guardar" de la fila (type=button), no el submit del modal.
  await page.getByRole('button', { name: 'Guardar', exact: true }).and(page.locator('[type="button"]')).click()

  await expect.poll(() => tables.user_credits.some((f) => f.discipline_id === 'disc-crossfit' && f.remaining_credits === 8)).toBe(true)
  const nuevo = tables.user_credits.find((f) => f.discipline_id === 'disc-crossfit' && f.remaining_credits === 8)
  expect(nuevo.expires_at).toBe(a18hsArgentina(DIA_PLAN))
  // D-T3a: el lote en 0 de CrossFit de OTRA fecha quedó vencido; el residuo de Boxeo, intacto.
  expect(new Date(tables.user_credits.find((f) => f.id === 'uc-crossfit-otra').expires_at).getTime()).toBeLessThan(Date.now())
  expect(tables.user_credits.find((f) => f.id === 'uc-boxeo-residuo').expires_at).toBe(a18hsArgentina(sumarDias(HOY, 25)))
  expect(tables.socios[0].creditos).toBe(8)
  expect(tables.socios[0].fecha_vencimiento).toBe(DIA_PLAN)
})

test('T3 -- +1 va al lote del plan de esa disciplina aunque esté en 0, no al lote con saldo de otra fecha', async ({ page }) => {
  const tables = tablas([
    fila('uc-crossfit', DISCIPLINA_CROSSFIT, 6, a18hsArgentina(DIA_PLAN)),
    fila('uc-boxeo-otra', DISCIPLINA_BOXEO, 2, a18hsArgentina(sumarDias(HOY, 5))),
    fila('uc-boxeo-plan', DISCIPLINA_BOXEO, 0, new Date(`${DIA_PLAN}T03:00:00-03:00`).toISOString()),
  ])
  await loginComoAdmin(page, { tables, rpc: { admin_ajustar_credito_disciplina: mockAdminAjustarCreditoDisciplina(tables) } })

  await abrirEditarSocio(page)
  await page.getByTitle('Sumar 1 crédito a Boxeo').click()

  await expect.poll(() => tables.user_credits.find((f) => f.id === 'uc-boxeo-plan').remaining_credits).toBe(1)
  expect(tables.user_credits.find((f) => f.id === 'uc-boxeo-otra').remaining_credits).toBe(2)
  expect(tables.user_credits.filter((f) => f.discipline_id === 'disc-boxeo')).toHaveLength(2) // sin lote nuevo
})

test('T3 -- "+ Agregar Aparatos" toma la fecha del plan de créditos y la ficha queda con ese día', async ({ page }) => {
  const tables = tablas([fila('uc-crossfit', DISCIPLINA_CROSSFIT, 6, a18hsArgentina(DIA_PLAN))])
  tables.socios[0].fecha_vencimiento = null
  page.on('dialog', (dialog) => dialog.accept())
  await loginComoAdmin(page, { tables, rpc: { admin_agregar_aparatos_socio: mockAdminAgregarAparatosSocio(tables) } })

  await abrirEditarSocio(page)
  await page.getByRole('button', { name: /Agregar Aparatos/ }).click()

  await expect.poll(() => tables.user_credits.some((f) => f.discipline_id === DISCIPLINA_APARATOS.id)).toBe(true)
  const aparatos = tables.user_credits.find((f) => f.discipline_id === DISCIPLINA_APARATOS.id)
  expect(aparatos.expires_at).toBe(a18hsArgentina(DIA_PLAN))
  expect(aparatos.remaining_credits).toBeNull()
  expect(tables.socios[0].fecha_vencimiento).toBe(DIA_PLAN)
})
