import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT } from './support/fixtures.js'
import { irAClases } from './support/nav.js'

// Ticket "cancelar clase puntual" -- ANTES "Cancelar" hacía un DELETE
// directo sobre `classes` (borraba la plantilla recurrente ENTERA, todos
// los días programados, para siempre) y fallaba con un error genérico si
// había cualquier reserva asociada (foreign key de `bookings`, sin
// cascade -- ver investigacion_cancelar_clase_prueba_fk.sql). Ahora cancela
// la OCURRENCIA de un día puntual -- `classes` nunca se toca, se reintegra
// el crédito a cada anotado de ESE día (mismo criterio incondicional que
// "Quitar de la clase") y se les notifica.

// El mock compartido no resuelve joins reales -- mismo route handler LOCAL
// que clases-inscriptos.spec.js/agenda-oculta-membresia.spec.js.
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
const FECHA_HOY = formatDateOnlyLocal(HOY)

const CLASE_A_CANCELAR = {
  id: 'clase-e2e-cancelar-puntual',
  discipline_id: DISCIPLINA_CROSSFIT.id,
  title: 'CrossFit',
  instructor: 'Seba',
  capacity: 20,
  days_of_week: [HOY.getDay()],
  start_time: '18:00:00',
  end_time: '19:00:00',
}

function socioDePrueba(n) {
  const userId = `e2e-profile-cancelar-${n}`
  const loteId = `uc-cancelar-${n}`
  return {
    profile: {
      id: userId,
      dni: `4000000${n}`,
      full_name: `Socio Prueba ${n}`,
      avatar_url: null,
      created_at: '2025-01-01T00:00:00.000Z',
      role: 'socio',
    },
    lote: {
      id: loteId,
      user_id: userId,
      discipline_id: DISCIPLINA_CROSSFIT.id,
      remaining_credits: 5,
      expires_at: '2099-01-01T12:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      discipline: DISCIPLINA_CROSSFIT,
    },
    booking: {
      id: `booking-cancelar-${n}`,
      user_id: userId,
      class_id: CLASE_A_CANCELAR.id,
      booking_date: FECHA_HOY,
      attended: false,
      credit_lote_id: loteId,
      profiles: { full_name: `Socio Prueba ${n}`, dni: `4000000${n}` },
    },
  }
}

const SOCIOS = [1, 2, 3].map(socioDePrueba)

// Simulación server-side de admin_cancelar_clase_dia() -- mismo criterio
// que el resto de e2e/support/rpcMocks.js: no reimplementa el SQL entero,
// solo lo suficiente para que `tables` quede en el estado que produciría el
// RPC real -- reintegra el lote de origen de cada booking de esa
// clase+fecha (si sigue vigente), las borra, marca la ocurrencia como
// cancelada e inserta una notification por socio afectado.
function mockAdminCancelarClaseDia(tables) {
  return (request) => {
    const { p_class_id: classId, p_occurrence_date: fecha } = request.postDataJSON()
    const afectados = (tables.bookings ?? []).filter((b) => b.class_id === classId && b.booking_date === fecha)

    tables.notifications = tables.notifications ?? []
    for (const booking of afectados) {
      const lote = (tables.user_credits ?? []).find((uc) => uc.id === booking.credit_lote_id)
      if (lote && new Date(lote.expires_at).getTime() > Date.now()) {
        lote.remaining_credits = (lote.remaining_credits ?? 0) + 1
      }
      tables.notifications.push({
        id: `notif-${booking.user_id}`,
        sender_id: 'e2e-admin-0000-0000-0000-000000000000',
        audience_type: 'user',
        target_user_id: booking.user_id,
        title: 'Clase cancelada',
        body: 'CrossFit de las 18:00 del ' + fecha + ' fue cancelada por el gimnasio. Ya te reintegramos el crédito.',
      })
    }

    tables.bookings = (tables.bookings ?? []).filter((b) => !(b.class_id === classId && b.booking_date === fecha))

    tables.class_occurrence_cancellations = tables.class_occurrence_cancellations ?? []
    tables.class_occurrence_cancellations.push({
      id: `cancel-${classId}-${fecha}`,
      class_id: classId,
      occurrence_date: fecha,
      cancelled_by: 'e2e-admin-0000-0000-0000-000000000000',
    })

    return afectados.length
  }
}

// Mock de admin_book_class -- solo lo suficiente para probar el guard
// nuevo (rechaza si la ocurrencia ya está cancelada); no reimplementa
// cupo/créditos/XP, fuera del alcance de este ticket.
function mockAdminBookClass(tables) {
  return (request) => {
    const { p_class_id: classId, p_booking_date: fecha } = request.postDataJSON()
    const cancelada = (tables.class_occurrence_cancellations ?? []).some(
      (c) => c.class_id === classId && c.occurrence_date === fecha,
    )
    if (cancelada) {
      return { __e2eError: { status: 400, body: { message: 'Esta clase fue cancelada para esta fecha.' } } }
    }
    return 'booking-nuevo-e2e'
  }
}

// Acepta el window.confirm de siempre, captura cualquier window.alert
// posterior (mismo patrón que cobro-mostrador.spec.js) para poder revisar
// el texto real mostrado.
function capturarAlertas(page) {
  const mensajes = []
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'confirm') {
      await dialog.accept()
    } else {
      mensajes.push(dialog.message())
      await dialog.dismiss()
    }
  })
  return mensajes
}

test('cancelar una clase de hoy con 3 socios anotados -- reintegra el crédito a los 3, notifica, y NO borra la clase', async ({
  page,
}) => {
  const tables = {
    ...tablasBase(),
    disciplines: [DISCIPLINA_CROSSFIT],
    classes: [CLASE_A_CANCELAR],
    profiles: SOCIOS.map((s) => s.profile),
    user_credits: SOCIOS.map((s) => s.lote),
    bookings: SOCIOS.map((s) => s.booking),
    class_occurrence_cancellations: [],
    notifications: [],
  }

  const mensajes = capturarAlertas(page)

  let pushBody = null
  await loginComoAdmin(page, {
    tables,
    rpc: { admin_cancelar_clase_dia: mockAdminCancelarClaseDia(tables) },
    functions: {
      'send-push': (request) => {
        pushBody = request.postDataJSON()
        return { destinatarios: pushBody.targetUserIds?.length ?? 0 }
      },
    },
  })
  await mockEmbedDisciplinesEnClasses(page, tables)

  await irAClases(page)
  await expect(page.getByText('CrossFit', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Cancelar clase' }).click()

  // Badge visible y el botón ya no se puede volver a tocar.
  await expect(page.getByText('Cancelada este día')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancelar clase' })).toBeDisabled()

  await expect.poll(() => mensajes.some((m) => m.includes('se reintegró el crédito a 3 socio'))).toBe(true)

  // `classes` NUNCA se tocó -- sigue existiendo con sus days_of_week de siempre.
  expect(tables.classes).toHaveLength(1)
  expect(tables.classes[0].id).toBe(CLASE_A_CANCELAR.id)

  // Las 3 reservas de ese día se cancelaron y los 3 recuperaron el crédito.
  expect(tables.bookings).toHaveLength(0)
  for (const s of SOCIOS) {
    expect(tables.user_credits.find((uc) => uc.id === s.lote.id).remaining_credits).toBe(6)
  }

  // Notificación individual por cada socio afectado -- NO audience_type='class'.
  expect(tables.notifications).toHaveLength(3)
  for (const s of SOCIOS) {
    expect(
      tables.notifications.some((n) => n.target_user_id === s.profile.id && n.audience_type === 'user'),
    ).toBe(true)
  }

  // Push real -- mismos userIds afectados, audiencia 'users' (no 'class').
  expect(pushBody.audience).toBe('users')
  expect([...pushBody.targetUserIds].sort()).toEqual(SOCIOS.map((s) => s.profile.id).sort())
})

test('intentar anotar a alguien nuevo en esa misma clase+fecha después de cancelada -- admin_book_class rechaza con el mensaje claro', async ({
  page,
}) => {
  const tables = {
    ...tablasBase(),
    disciplines: [DISCIPLINA_CROSSFIT],
    classes: [CLASE_A_CANCELAR],
    profiles: [
      {
        id: 'e2e-profile-nuevo',
        dni: '50000000',
        full_name: 'Socio Nuevo',
        avatar_url: null,
        created_at: '2025-01-01T00:00:00.000Z',
        role: 'socio',
      },
    ],
    bookings: [],
    class_occurrence_cancellations: [
      { id: 'cancel-1', class_id: CLASE_A_CANCELAR.id, occurrence_date: FECHA_HOY, cancelled_by: 'e2e-admin' },
    ],
  }

  const mensajes = capturarAlertas(page)

  await loginComoAdmin(page, {
    tables,
    rpc: { admin_book_class: mockAdminBookClass(tables) },
  })
  await mockEmbedDisciplinesEnClasses(page, tables)

  await irAClases(page)
  await expect(page.getByText('Cancelada este día')).toBeVisible()

  await page.getByRole('button', { name: 'Ver Inscriptos' }).click()
  await expect(page.getByRole('heading', { name: 'CrossFit' })).toBeVisible()
  await expect(page.getByText('Todavía no hay socios inscriptos en esta clase.')).toBeVisible()

  await page.getByPlaceholder('Anotar socio por DNI...').fill('50000000')
  await page.getByRole('button', { name: 'Anotar' }).click()

  await expect
    .poll(() => mensajes.some((m) => m === 'No se pudo anotar al socio: Esta clase fue cancelada para esta fecha.'))
    .toBe(true)
})
