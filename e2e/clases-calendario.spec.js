import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { irAClases } from './support/nav.js'
import { tablasBase, DISCIPLINA_CROSSFIT } from './support/fixtures.js'

// Pantalla Clases -- días pasados + "Ver calendario". Reloj del navegador
// congelado el jueves 22/10/2026 a las 12:00 de Argentina (15:00Z), y el
// navegador en hora de Argentina y en UTC: el resultado no puede depender de
// la zona de la PC.

// El mock compartido no resuelve el embed `disciplines(show_in_agenda)` --
// mismo route handler LOCAL que clases-dia-anterior.spec.js.
async function mockEmbedDisciplinesEnClasses(page, tables) {
  await page.route('**/rest/v1/classes*', async (route) => {
    const request = route.request()
    if (request.method() !== 'GET') {
      await route.fallback()
      return
    }
    const filas = (tables.classes ?? []).map((fila) => ({
      ...fila,
      disciplines: (tables.disciplines ?? []).find((d) => d.id === fila.discipline_id) ?? null,
    }))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(filas) })
  })
}

const MEDIODIA_22_10 = new Date('2026-10-22T15:00:00Z')

// Caso real de producción: hoy se dicta lun/mié/vie, pero tiene reservas de
// martes y jueves de agosto/septiembre.
const TURNO_NOCHE = {
  id: '56e73799-640c-478c-8b55-69b0cc2d816e',
  discipline_id: DISCIPLINA_CROSSFIT.id,
  title: 'CrossFit - Turno Noche',
  instructor: 'Seba',
  capacity: 20,
  days_of_week: [1, 3, 5],
  start_time: '20:00:00',
  end_time: '21:00:00',
  created_at: '2026-07-01T12:00:00Z',
}
const KICK_LUNES = {
  ...TURNO_NOCHE,
  id: 'clase-e2e-kick-lunes',
  title: 'Kick Lunes',
  days_of_week: [1],
  start_time: '07:00:00',
  end_time: '08:00:00',
}

let n = 0
const reserva = (classId, fecha, nombre) => ({
  id: `booking-e2e-cal-${++n}`,
  user_id: `e2e-profile-cal-${n}`,
  class_id: classId,
  booking_date: fecha,
  attended: null,
  profiles: { full_name: nombre, dni: null },
})

function tablas() {
  n = 0
  return {
    ...tablasBase(),
    classes: [TURNO_NOCHE, KICK_LUNES],
    // La más vieja primero: el mock compartido no ordena, y "primera reserva"
    // toma la primera fila.
    bookings: [
      reserva(TURNO_NOCHE.id, '2026-07-06', 'Julio Uno'),
      reserva(TURNO_NOCHE.id, '2026-08-18', 'Martes Uno'),
      reserva(TURNO_NOCHE.id, '2026-08-18', 'Martes Dos'),
      reserva(TURNO_NOCHE.id, '2026-08-18', 'Martes Tres'),
      reserva(TURNO_NOCHE.id, '2026-10-05', 'Lunes Uno'),
      reserva(TURNO_NOCHE.id, '2026-10-05', 'Lunes Dos'),
      reserva(TURNO_NOCHE.id, '2026-10-20', 'Anteayer Uno'),
      reserva(TURNO_NOCHE.id, '2026-10-21', 'Ayer Uno'),
    ],
    class_occurrence_cancellations: [{ id: 'oc-e2e-1', class_id: KICK_LUNES.id, occurrence_date: '2026-09-07', cancelled_by: null }],
  }
}

async function entrar(page, { reloj = 'fijo', instante = MEDIODIA_22_10 } = {}) {
  if (reloj === 'fijo') await page.clock.setFixedTime(instante)
  else await page.clock.install({ time: instante })
  const tables = tablas()
  await loginComoAdmin(page, { tables })
  await mockEmbedDisciplinesEnClasses(page, tables)
  await irAClases(page)
  return tables
}

const chip = (page, etiqueta, dia) => page.getByRole('button', { name: new RegExp(`^${etiqueta}\\s*${dia}$`) })
const calendario = (page) => page.getByRole('dialog', { name: 'Calendario de inscriptos' })
const tarjeta = (page, titulo) => page.locator('div.rounded-2xl').filter({ hasText: titulo })

for (const timezoneId of ['America/Argentina/Mendoza', 'UTC']) {
  test.describe(`Clases -- calendario y días pasados (navegador en ${timezoneId})`, () => {
    test.use({ timezoneId })

    test('mes con datos: inscriptos por día, y se navega hacia atrás hasta la primera reserva', async ({ page }) => {
      await entrar(page)
      await page.getByRole('button', { name: 'Ver calendario' }).click()
      const cal = calendario(page)
      await expect(cal.getByText('Octubre 2026')).toBeVisible()
      await expect(cal.getByRole('button', { name: '5 de Octubre 2026: 2 inscriptos' })).toBeVisible()
      await expect(cal.getByRole('button', { name: '21 de Octubre 2026: 1 inscripto' })).toBeVisible()
      await expect(cal.getByRole('button', { name: 'Mes siguiente' })).toBeDisabled()

      await cal.getByRole('button', { name: 'Mes anterior' }).click()
      await expect(cal.getByRole('button', { name: '7 de Septiembre 2026: 0 inscriptos, con clase cancelada' })).toBeVisible()
      await cal.getByRole('button', { name: 'Mes anterior' }).click()
      await expect(cal.getByRole('button', { name: '18 de Agosto 2026: 3 inscriptos' })).toBeVisible()
      await cal.getByRole('button', { name: 'Mes anterior' }).click()
      await expect(cal.getByRole('button', { name: '6 de Julio 2026: 1 inscripto' })).toBeVisible()
      await expect(cal.getByRole('button', { name: 'Mes anterior' })).toBeDisabled()
    })

    test('día pasado con la clase que cambió de días: el martes 18/08 aparece Turno Noche con aviso y en solo lectura', async ({ page }) => {
      await entrar(page)
      await page.getByRole('button', { name: 'Ver calendario' }).click()
      const cal = calendario(page)
      await cal.getByRole('button', { name: 'Mes anterior' }).click()
      await cal.getByRole('button', { name: 'Mes anterior' }).click()
      await cal.getByRole('button', { name: '18 de Agosto 2026: 3 inscriptos' }).click()

      await expect(cal).toHaveCount(0)
      await expect(page.getByText(/día pasado, solo lectura/)).toBeVisible()
      await expect(page.getByRole('button', { name: /^Elegido\s*18\/08$/ })).toBeVisible()
      const noche = tarjeta(page, 'CrossFit - Turno Noche')
      await expect(noche.getByText('3 / 20 inscriptos')).toBeVisible()
      await expect(noche.getByText(/Hoy esta clase se dicta lun, mié y vie/)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Cancelar clase' })).toHaveCount(0)

      await page.getByRole('button', { name: 'Volver a hoy' }).click()
      await expect(page.getByText(/día pasado, solo lectura/)).toHaveCount(0)
    })

    test('día con clase cancelada: marca en el calendario y "Cancelada este día" en el panel', async ({ page }) => {
      await entrar(page)
      await page.getByRole('button', { name: 'Ver calendario' }).click()
      const cal = calendario(page)
      await cal.getByRole('button', { name: 'Mes anterior' }).click()
      await cal.getByRole('button', { name: '7 de Septiembre 2026: 0 inscriptos, con clase cancelada' }).click()

      await expect(tarjeta(page, 'Kick Lunes').getByText('Cancelada este día')).toBeVisible()
    })

    test('días anteriores a "ayer" en solo lectura; "ayer" con todas sus acciones', async ({ page }) => {
      await entrar(page)

      await chip(page, 'mar', 20).click()
      await expect(page.getByText(/día pasado, solo lectura/)).toBeVisible()
      const noche = tarjeta(page, 'CrossFit - Turno Noche')
      await expect(noche.getByText('1 / 20 inscriptos')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Cancelar clase' })).toHaveCount(0)
      await noche.getByRole('button', { name: /Ver Inscriptos/ }).click()
      await expect(page.getByText(/Día pasado: solo lectura/)).toBeVisible()
      await expect(page.getByText('Anteayer Uno')).toBeVisible()
      await expect(page.getByLabel('Buscar socio para anotar')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Marcar Asistió' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Quitar de la clase' })).toHaveCount(0)
      await page.getByRole('button', { name: 'Cerrar', exact: true }).click()

      await chip(page, 'Ayer', 21).click()
      await expect(page.getByText(/día pasado, solo lectura/)).toHaveCount(0)
      await expect(tarjeta(page, 'CrossFit - Turno Noche').getByText('1 / 20 inscriptos')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Editar' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Cancelar clase' })).toBeVisible()
    })

    test('medianoche con el panel abierto: "Hoy" pasa al día siguiente sin recargar', async ({ page }) => {
      await entrar(page, { reloj: 'avanza', instante: new Date('2026-10-23T02:59:50Z') }) // jueves 23:59:50
      await expect(chip(page, 'Hoy', 22)).toBeVisible()

      await page.clock.runFor(70_000)

      await expect(chip(page, 'Hoy', 23)).toBeVisible()
      await expect(chip(page, 'Ayer', 22)).toBeVisible()
    })

    test('error de red: el calendario y las cancelaciones del día lo dicen y dejan reintentar', async ({ page }) => {
      await entrar(page)

      // Cancelaciones del día que falla una vez -> aviso, Reintentar -> se va.
      let fallarCancelaciones = true
      await page.route('**/rest/v1/class_occurrence_cancellations*', async (route) => {
        if (fallarCancelaciones && route.request().method() === 'GET') {
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'network' }) })
          return
        }
        await route.fallback()
      })
      await chip(page, 'Ayer', 21).click()
      await expect(page.getByText(/No se pudieron cargar las cancelaciones de este día/)).toBeVisible()
      fallarCancelaciones = false
      await page.getByRole('button', { name: 'Reintentar' }).click()
      await expect(page.getByText(/No se pudieron cargar las cancelaciones de este día/)).toHaveCount(0)

      // Pedido del mes (rango sobre booking_date) que falla una vez.
      let fallarMes = true
      await page.route('**/rest/v1/bookings*', async (route) => {
        const url = route.request().url()
        if (fallarMes && route.request().method() === 'GET' && url.includes('booking_date=gte')) {
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'network' }) })
          return
        }
        await route.fallback()
      })
      await page.getByRole('button', { name: 'Ver calendario' }).click()
      const cal = calendario(page)
      await expect(cal.getByText(/No se pudieron cargar los inscriptos de este mes/)).toBeVisible()
      fallarMes = false
      await cal.getByRole('button', { name: 'Reintentar' }).click()
      await expect(cal.getByRole('button', { name: '5 de Octubre 2026: 2 inscriptos' })).toBeVisible()
    })
  })
}
