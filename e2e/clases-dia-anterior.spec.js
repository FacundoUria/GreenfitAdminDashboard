import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { irAClases } from './support/nav.js'
import { tablasBase, DISCIPLINA_CROSSFIT } from './support/fixtures.js'

// Ticket: agregar "Ayer" a la navegación de días de Clases.jsx (antes de
// "Hoy") -- Seba necesita poder revisar quién asistió o si hubo algún
// problema en la clase del día anterior. Mismo componente, mismo criterio
// de datos reales (clases, cupos, inscriptos) que cualquier otro día -- sin
// vista especial.

// El mock compartido no resuelve el embed `disciplines(show_in_agenda)` --
// mismo route handler LOCAL que agenda-oculta-membresia.spec.js/
// clases-inscriptos.spec.js.
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

// "YYYY-MM-DD" en horario local -- mismo criterio que formatDateOnly()
// (utils/clases.js), reimplementado acá para no depender de un import de
// src/ dentro de la suite e2e.
function formatDateOnlyLocal(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const HOY = new Date()
HOY.setHours(0, 0, 0, 0)
const AYER = new Date(HOY)
AYER.setDate(AYER.getDate() - 1)

const CLASE_AYER = {
  id: 'clase-e2e-ayer',
  discipline_id: DISCIPLINA_CROSSFIT.id,
  title: 'CrossFit de Ayer',
  instructor: 'Seba',
  capacity: 10,
  days_of_week: [AYER.getDay()],
  start_time: '08:00:00',
  end_time: '09:00:00',
}

const BOOKING_AYER = {
  id: 'booking-e2e-ayer',
  user_id: 'e2e-profile-ayer',
  class_id: CLASE_AYER.id,
  booking_date: formatDateOnlyLocal(AYER),
  attended: true,
  profiles: { full_name: 'Bruno Ayer', dni: '30999888' },
}

test('"Ayer" aparece antes de "Hoy" en la navegación y muestra las clases/cupos/inscriptos reales de esa fecha', async ({
  page,
}) => {
  const tables = { ...tablasBase(), classes: [CLASE_AYER], bookings: [BOOKING_AYER] }
  await loginComoAdmin(page, { tables })
  await mockEmbedDisciplinesEnClasses(page, tables)

  await irAClases(page)

  // La pantalla sigue abriendo en "Hoy" por defecto -- la única clase del
  // fixture es de AYER, así que hoy no debería verse todavía.
  await expect(page.getByText('No hay clases programadas para este día.')).toBeVisible()

  const tabAyer = page.getByRole('button', { name: /Ayer/ })
  await expect(tabAyer).toBeVisible()
  await tabAyer.click()

  // Mismos datos reales que cualquier otro día -- clase, cupo e inscriptos.
  await expect(page.getByText('CrossFit de Ayer', { exact: true })).toBeVisible()
  await expect(page.getByText('1 / 10 inscriptos')).toBeVisible()

  await page.getByRole('button', { name: 'Ver Inscriptos' }).click()
  await expect(page.getByText('Bruno Ayer')).toBeVisible()
})

test('editar/cancelar una clase de "Ayer" -- misma disponibilidad que en cualquier otro día (no hay gating por fecha hoy)', async ({
  page,
}) => {
  // La suite no encontró ninguna restricción existente que deshabilite
  // "Editar"/"Cancelar" para una clase ya ocurrida -- ClaseCard
  // (ClasesGrid.jsx) siempre los renderiza habilitados, sin mirar la fecha,
  // para CUALQUIER día (Hoy, Mañana, o cualquier otro). Este test confirma
  // ese comportamiento (documentado, no inventado) también para "Ayer" --
  // ver el mensaje final al usuario para la recomendación de agregar un
  // gating real como ticket aparte, si lo quiere.
  const tables = { ...tablasBase(), classes: [CLASE_AYER], bookings: [BOOKING_AYER] }
  await loginComoAdmin(page, { tables })
  await mockEmbedDisciplinesEnClasses(page, tables)

  await irAClases(page)
  await page.getByRole('button', { name: /Ayer/ }).click()
  await expect(page.getByText('CrossFit de Ayer', { exact: true })).toBeVisible()

  await expect(page.getByRole('button', { name: 'Editar' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Cancelar clase' })).toBeEnabled()
})
