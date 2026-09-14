import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { irAClases } from './support/nav.js'
import { tablasBase, DISCIPLINA_CROSSFIT, SOCIO_MARTINA, PROFILE_MARTINA } from './support/fixtures.js'

// PARTE A -- click en un inscripto (con dni) redirige a su ficha (deep-link
// ?editar=<dni>, mismo patrón que ?filtro=por_vencer). PARTE B -- "Quitar de
// la clase" reintegra el crédito SIEMPRE (p_forzar_reintegro), sin importar
// el tiempo de gracia normal.

// El mock compartido (supabaseMock.js) no resuelve joins reales -- el embed
// `disciplines(show_in_agenda)` que pide Clases.jsx no vendría poblado.
// Route handler LOCAL a este archivo, mismo patrón que
// agenda-oculta-membresia.spec.js.
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

// ============================================================
// PARTE A
// ============================================================

const HOY = new Date()

const CLASE_HOY = {
  id: 'clase-e2e-inscriptos',
  discipline_id: DISCIPLINA_CROSSFIT.id,
  title: 'CrossFit Mañana',
  instructor: 'Seba',
  capacity: 20,
  days_of_week: [HOY.getDay()],
  start_time: '09:00:00',
  end_time: '10:00:00',
}

const BOOKING_CON_DNI = {
  id: 'booking-e2e-con-dni',
  user_id: PROFILE_MARTINA.id,
  class_id: CLASE_HOY.id,
  booking_date: formatDateOnlyLocal(HOY),
  attended: false,
  profiles: { full_name: 'Martina Ríos', dni: SOCIO_MARTINA.dni },
}

const BOOKING_SIN_DNI = {
  id: 'booking-e2e-sin-dni',
  user_id: 'e2e-profile-sin-dni',
  class_id: CLASE_HOY.id,
  booking_date: formatDateOnlyLocal(HOY),
  attended: false,
  profiles: { full_name: 'Socio Sin Dni', dni: null },
}

test('PARTE A -- un inscripto con DNI es clickeable y navega a su ficha en Socios (?editar=<dni>)', async ({ page }) => {
  const tables = { ...tablasBase(), classes: [CLASE_HOY], bookings: [BOOKING_CON_DNI, BOOKING_SIN_DNI] }
  await loginComoAdmin(page, { tables })
  await mockEmbedDisciplinesEnClasses(page, tables)

  await irAClases(page)
  await page.getByRole('button', { name: 'Ver Inscriptos' }).click()
  // getByRole('heading') -- el mismo texto también aparece en la tarjeta de
  // la clase (detrás del modal), un getByText sin acotar matchea las dos.
  await expect(page.getByRole('heading', { name: 'CrossFit Mañana' })).toBeVisible()

  await page.getByRole('button', { name: 'Martina Ríos' }).click()

  await expect(page).toHaveURL(/\/socios/)
  await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()
  await expect(page.getByLabel('DNI')).toHaveValue(SOCIO_MARTINA.dni)
  // El deep-link se limpia solo apenas se resuelve -- no queda pegado en la
  // URL (evita que cerrar el modal y disparar un refetch lo reabra solo).
  await expect(page).not.toHaveURL(/editar=/)
})

test('PARTE A -- un inscripto sin DNI no es clickeable -- texto plano, sin romper el modal', async ({ page }) => {
  const tables = { ...tablasBase(), classes: [CLASE_HOY], bookings: [BOOKING_CON_DNI, BOOKING_SIN_DNI] }
  await loginComoAdmin(page, { tables })
  await mockEmbedDisciplinesEnClasses(page, tables)

  await irAClases(page)
  await page.getByRole('button', { name: 'Ver Inscriptos' }).click()

  await expect(page.getByText('Socio Sin Dni')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Socio Sin Dni' })).toHaveCount(0)

  // El resto del modal sigue andando -- el inscripto de al lado (con dni)
  // sigue clickeable, y los botones de asistencia de la fila sin dni también.
  await expect(page.getByRole('button', { name: 'Martina Ríos' })).toBeVisible()
  const filaSinDni = page.getByRole('listitem').filter({ hasText: 'Socio Sin Dni' })
  await expect(filaSinDni.getByRole('button', { name: 'Marcar Asistió' })).toBeVisible()
})

// ============================================================
// PARTE B
// ============================================================

// Lunes 17:50 -- la clase de abajo arranca a las 18:00, en 10 minutos.
// Reloj CONGELADO (mismo criterio que checkin-rapido.spec.js) -- Node y el
// browser corren en procesos separados, así que `HORA_CONGELADA` se pasa
// explícita al mock del RPC (que corre del lado de Node) en vez de que este
// confíe en su propio `new Date()`, que NO está congelado.
const HORA_CONGELADA = new Date('2026-08-10T17:50:00')

const CLASE_A_PUNTO_DE_EMPEZAR = {
  id: 'clase-e2e-forzar-reintegro',
  discipline_id: DISCIPLINA_CROSSFIT.id,
  title: 'CrossFit 18hs',
  instructor: 'Seba',
  capacity: 20,
  days_of_week: [HORA_CONGELADA.getDay()], // Lunes
  start_time: '18:00:00',
  end_time: '19:00:00',
}

const BOOKING_MARTINA_PRONTO = {
  id: 'booking-e2e-forzar-reintegro',
  user_id: PROFILE_MARTINA.id,
  class_id: CLASE_A_PUNTO_DE_EMPEZAR.id,
  booking_date: formatDateOnlyLocal(HORA_CONGELADA),
  attended: false,
  profiles: { full_name: 'Martina Ríos', dni: SOCIO_MARTINA.dni },
}

// Simulación server-side de admin_cancel_booking() -- mismo criterio que el
// resto de e2e/support/rpcMocks.js: no reimplementa el SQL entero, solo lo
// suficiente para que `tables` quede en el estado que produciría el RPC
// real. Réplica el mismo cálculo de "tiempo de gracia" que la migración
// (limite_cancelacion_minutos, default 120) Y el override nuevo de
// p_forzar_reintegro -- así el test ejercita la diferencia real de
// comportamiento, no un mock que "siempre reintegra" sin condición.
function mockAdminCancelBooking(tables, ahoraFija) {
  return (request) => {
    const {
      p_user_id: userId,
      p_class_id: classId,
      p_booking_date: bookingDate,
      p_forzar_reintegro: forzarReintegro,
    } = request.postDataJSON()

    const clase = (tables.classes ?? []).find((c) => c.id === classId)
    if (!clase) return { __e2eError: { status: 400, body: { message: `No existe la clase ${classId}` } } }

    const limiteMinutos = tables.configuracion?.[0]?.limite_cancelacion_minutos ?? 120
    const claseInicio = new Date(`${bookingDate}T${clase.start_time}`)
    const dentroDelLimite = ahoraFija <= new Date(claseInicio.getTime() - limiteMinutos * 60_000)

    const idx = (tables.bookings ?? []).findIndex(
      (b) => b.user_id === userId && b.class_id === classId && b.booking_date === bookingDate,
    )
    if (idx === -1) {
      return { __e2eError: { status: 400, body: { message: 'Ese socio no tenía una reserva en esta clase' } } }
    }
    tables.bookings.splice(idx, 1)

    if (dentroDelLimite || forzarReintegro) {
      const lote = (tables.user_credits ?? [])
        .filter((f) => f.user_id === userId && f.discipline_id === clase.discipline_id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
      if (lote) lote.remaining_credits = (lote.remaining_credits ?? 0) + 1
    }

    return dentroDelLimite
  }
}

test('PARTE B -- "Quitar de la clase" reintegra el crédito SIEMPRE, aunque falten solo 10 minutos (fuera del tiempo de gracia normal)', async ({
  page,
}) => {
  const tables = { ...tablasBase(), classes: [CLASE_A_PUNTO_DE_EMPEZAR], bookings: [BOOKING_MARTINA_PRONTO] }
  // Martina arranca con 4 créditos de CrossFit (USER_CREDITS_MARTINA) --
  // punto de partida, para poder confirmar el +1 real después.
  expect(tables.user_credits[0].remaining_credits).toBe(4)

  page.on('dialog', (dialog) => dialog.accept())

  let bodyRecibido = null
  await page.clock.setFixedTime(HORA_CONGELADA)
  await loginComoAdmin(page, {
    tables,
    rpc: {
      admin_cancel_booking: (request) => {
        bodyRecibido = request.postDataJSON()
        return mockAdminCancelBooking(tables, HORA_CONGELADA)(request)
      },
    },
  })
  await mockEmbedDisciplinesEnClasses(page, tables)

  await irAClases(page)
  await page.getByRole('button', { name: 'Ver Inscriptos' }).click()
  await expect(page.getByRole('heading', { name: 'CrossFit 18hs' })).toBeVisible()

  await page.getByRole('button', { name: 'Quitar de la clase' }).click()
  await expect(page.getByText('Todavía no hay socios inscriptos en esta clase.')).toBeVisible()

  expect(bodyRecibido.p_forzar_reintegro).toBe(true)
  // Con solo 10 minutos de anticipación (contra un tiempo de gracia
  // configurado en 120), cancel_booking()/admin_cancel_booking() de ANTES
  // de este ticket NO hubieran reintegrado nada -- acá sí, porque Seba lo
  // sacó desde el Admin (p_forzar_reintegro:true), no el socio por su cuenta.
  expect(tables.user_credits[0].remaining_credits).toBe(5)
})
