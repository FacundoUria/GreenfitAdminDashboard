import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS } from './support/fixtures.js'
import { irASocios } from './support/nav.js'
import { mockAdminEditarFechaVencimientoSocio, finDelDiaArgentinaISO } from './support/rpcMocks.js'

// CAMBIO 3 -- "Vencimiento del plan" en "Editar Socio" (CreditosEditablesSocio.jsx):
// editar la fecha única del plan mueve TODAS las disciplinas activas +
// Aparatos a la vez, sin tocar cantidades. ADITIVO -- admin_editar_fecha_
// vencimiento_socio() es un RPC nuevo, no reemplaza a "Cobrar".
//
// T2 (regla D): el corte se guarda como el FIN del día elegido en Argentina,
// la fecha que se ve sigue siendo el día elegido, y el editor acepta de hoy a
// hoy + 1 año. Las fechas de este spec son relativas a HOY en Argentina (antes
// eran fijas -- 05/10/2026 -- y el spec se venció solo).

const DISCIPLINA_BOXEO = { id: 'disc-boxeo', name: 'Boxeo', kind: 'credits' }
const DISCIPLINA_KICK = { id: 'disc-kick', name: 'Kickstrike', kind: 'credits' }

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

const ddmmaaaa = (fechaISO) => fechaISO.split('-').reverse().join('/')

// A las 18:00 de Argentina de ese día (como un pago real, con hora).
const a18hsArgentina = (fechaISO) => new Date(`${fechaISO}T18:00:00-03:00`).toISOString()

const HOY = hoyArgentinaISO()
const DIA_PLAN = sumarDias(HOY, 10)
const FECHA_NUEVA = sumarDias(HOY, 60)

const SOCIO_MULTI = {
  id: 'e2e-socio-fecha-plan',
  nombre: 'Facundo',
  apellido: 'Uria',
  dni: '20333444',
  email: 'facundo@e2e.test',
  telefono: null,
  plan: ['CrossFit', 'Boxeo', 'Aparatos'],
  estado: 'Activo',
  fecha_vencimiento: DIA_PLAN,
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

// CrossFit, Boxeo y Aparatos con la MISMA fecha -- el caso real que describe
// el ticket bajo "plan único". Más dos lotes en 0 de Kickstrike: uno del plan
// (mismo día, otra hora) y uno de OTRA fecha.
function userCreditsIniciales() {
  const fila = (id, disciplina, remaining, expiresAt) => ({
    id,
    user_id: PROFILE_MULTI.id,
    discipline_id: disciplina.id,
    remaining_credits: remaining,
    expires_at: expiresAt,
    created_at: '2026-08-01T00:00:00.000Z',
    discipline: disciplina,
  })
  return [
    fila('uc-crossfit', DISCIPLINA_CROSSFIT, 6, a18hsArgentina(DIA_PLAN)),
    fila('uc-boxeo', DISCIPLINA_BOXEO, 2, a18hsArgentina(DIA_PLAN)),
    fila('uc-aparatos', DISCIPLINA_APARATOS, null, a18hsArgentina(DIA_PLAN)),
    fila('uc-kick-cero-plan', DISCIPLINA_KICK, 0, new Date(`${DIA_PLAN}T03:00:00-03:00`).toISOString()),
    fila('uc-kick-cero-otra', DISCIPLINA_KICK, 0, a18hsArgentina(sumarDias(HOY, 4))),
  ]
}

function tablasMulti() {
  return {
    ...tablasBase(),
    disciplines: [...tablasBase().disciplines, DISCIPLINA_BOXEO, DISCIPLINA_KICK],
    socios: [SOCIO_MULTI],
    profiles: [PROFILE_MULTI],
    user_credits: userCreditsIniciales(),
  }
}

async function abrirEditarSocio(page) {
  await irASocios(page)
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Facundo Uria/ })
  await filaTabla.getByTitle('Editar').click()
  await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()
}

test('editar el vencimiento del plan mueve CrossFit + Boxeo + Aparatos al FIN del día nuevo, cantidades intactas', async ({
  page,
}) => {
  const tables = tablasMulti()

  page.on('dialog', (dialog) => dialog.accept())

  await loginComoAdmin(page, {
    tables,
    rpc: { admin_editar_fecha_vencimiento_socio: mockAdminEditarFechaVencimientoSocio(tables) },
  })

  await abrirEditarSocio(page)

  // Fecha actual visible antes de tocar nada.
  await expect(page.getByText('Vencimiento del plan:')).toBeVisible()
  await expect(page.getByText(ddmmaaaa(DIA_PLAN), { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Editar vencimiento del plan' }).click()
  const input = page.getByLabel('Nueva fecha de vencimiento del plan')
  await expect(input).toHaveValue(DIA_PLAN)
  await expect(input).toHaveAttribute('min', HOY)
  await input.fill(FECHA_NUEVA)
  await page.getByText('Guardar fecha').click()

  // Las 3 filas reales quedaron al FIN del día nuevo en Argentina -- cantidades sin tocar.
  const corte = finDelDiaArgentinaISO(FECHA_NUEVA)
  const filaPorId = (id) => tables.user_credits.find((f) => f.id === id)
  await expect.poll(() => filaPorId('uc-crossfit').expires_at).toBe(corte)
  expect(filaPorId('uc-boxeo').expires_at).toBe(corte)
  expect(filaPorId('uc-aparatos').expires_at).toBe(corte)
  expect(filaPorId('uc-crossfit').remaining_credits).toBe(6)
  expect(filaPorId('uc-boxeo').remaining_credits).toBe(2)

  // Lote en 0 del plan: se mueve. Lote en 0 de otra fecha: se vence.
  expect(filaPorId('uc-kick-cero-plan').expires_at).toBe(corte)
  expect(filaPorId('uc-kick-cero-plan').remaining_credits).toBe(0)
  expect(filaPorId('uc-kick-cero-otra').expires_at < new Date().toISOString()).toBe(true)
  expect(filaPorId('uc-kick-cero-otra').remaining_credits).toBe(0)

  // Espejo en socios.fecha_vencimiento: el día elegido.
  expect(tables.socios.find((s) => s.dni === SOCIO_MULTI.dni).fecha_vencimiento).toBe(FECHA_NUEVA)

  // Lo que se ve es el día elegido, no el siguiente (el corte es 23:59:59 de ese día).
  await expect(page.getByText(ddmmaaaa(FECHA_NUEVA), { exact: true })).toBeVisible()
  await expect(page.getByText(ddmmaaaa(sumarDias(FECHA_NUEVA, 1)), { exact: true })).toHaveCount(0)
})

test('elegir HOY: el corte queda al fin de hoy y el plan se sigue viendo vigente hoy', async ({ page }) => {
  const tables = tablasMulti()
  page.on('dialog', (dialog) => dialog.accept())

  await loginComoAdmin(page, {
    tables,
    rpc: { admin_editar_fecha_vencimiento_socio: mockAdminEditarFechaVencimientoSocio(tables) },
  })

  await abrirEditarSocio(page)
  await page.getByRole('button', { name: 'Editar vencimiento del plan' }).click()
  await page.getByLabel('Nueva fecha de vencimiento del plan').fill(HOY)
  await page.getByText('Guardar fecha').click()

  await expect.poll(() => tables.user_credits.find((f) => f.id === 'uc-crossfit').expires_at).toBe(finDelDiaArgentinaISO(HOY))
  await expect(page.getByText('Vencimiento del plan:')).toBeVisible()
  await expect(page.getByText(ddmmaaaa(HOY), { exact: true })).toBeVisible()
})

test('una fecha pasada tipeada a mano: avisa y no cambia nada', async ({ page }) => {
  const tables = tablasMulti()
  const antes = JSON.stringify(tables.user_credits)
  const avisos = []
  page.on('dialog', (dialog) => {
    avisos.push(dialog.message())
    dialog.accept()
  })

  await loginComoAdmin(page, {
    tables,
    rpc: { admin_editar_fecha_vencimiento_socio: mockAdminEditarFechaVencimientoSocio(tables) },
  })

  await abrirEditarSocio(page)
  await page.getByRole('button', { name: 'Editar vencimiento del plan' }).click()
  await page.getByLabel('Nueva fecha de vencimiento del plan').fill(sumarDias(HOY, -1))
  await page.getByText('Guardar fecha').click()

  await expect.poll(() => avisos).toContain(`No se puede poner un vencimiento anterior a hoy (${ddmmaaaa(HOY)}).`)
  expect(JSON.stringify(tables.user_credits)).toBe(antes)
  expect(tables.socios[0].fecha_vencimiento).toBe(DIA_PLAN)
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
