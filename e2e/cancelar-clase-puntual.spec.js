import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS } from './support/fixtures.js'
import { irAClases } from './support/nav.js'
import { mockCancelacionGimnasio } from './support/rpcCancelacionGimnasio.js'

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

// Cada caso arma sus propios socios, con lotes nuevos: la base simulada les suma
// créditos al cancelar, y si fueran compartidos un caso le pisaría el saldo al siguiente.
const nuevosSocios = () => [1, 2, 3].map(socioDePrueba)

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
  const SOCIOS = nuevosSocios()
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
    rpc: { admin_cancelar_clase_dia_v2: mockCancelacionGimnasio(tables).admin_cancelar_clase_dia_v2 },
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

  await expect.poll(() => mensajes.some((m) => m.includes('Crédito devuelto a 3 de 3.'))).toBe(true)

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

  // Lo que se le dice al socio es la verdad: se le devolvió, con la fecha del lote.
  const textoDevuelto = `CrossFit de las 18:00 del ${FECHA_HOY.split('-').reverse().join('/')} fue cancelada por el gimnasio. Te devolvimos el crédito (vence el 01/01/2099).`
  expect(tables.notifications.every((n) => n.body === textoDevuelto)).toBe(true)
  expect(pushBody.body).toBe(textoDevuelto)
})

// Tanda 2 -- cancela el gimnasio: cada socio recibe la verdad sobre SU crédito
// y Seba ve el resumen (a cuántos sí, a cuántos no y por qué).
test('cancelar una clase con un crédito devuelto y dos no devueltos -- resumen para Seba y un push por cada texto', async ({
  page,
}) => {
  const SOCIOS = nuevosSocios()
  const [conVigente, deAnulado, sinNada] = SOCIOS
  const loteAnulado = { ...deAnulado.lote, id: 'uc-cancelar-anulado', remaining_credits: 0, expires_at: '2026-01-01T12:00:00.000Z' }
  const loteVencido = { ...sinNada.lote, id: 'uc-cancelar-vencido', remaining_credits: 0, expires_at: '2026-01-01T12:00:00.000Z' }
  const tables = {
    ...tablasBase(),
    disciplines: [DISCIPLINA_CROSSFIT],
    classes: [CLASE_A_CANCELAR],
    profiles: SOCIOS.map((s) => s.profile),
    user_credits: [conVigente.lote, loteAnulado, loteVencido],
    bookings: [
      conVigente.booking,
      { ...deAnulado.booking, credit_lote_id: loteAnulado.id },
      { ...sinNada.booking, credit_lote_id: loteVencido.id },
    ],
    pagos_socio: [
      {
        id: 'pago-anulado-e2e',
        user_id: deAnulado.profile.id,
        estado: 'anulado',
        created_at: '2026-10-02T15:00:00.000Z',
        detalle_acreditacion: { reversion: { filas_vencidas: [{ user_credit_id: loteAnulado.id }] } },
      },
    ],
    class_occurrence_cancellations: [],
    notifications: [],
  }

  const mensajes = capturarAlertas(page)
  const pushes = []
  await loginComoAdmin(page, {
    tables,
    rpc: { admin_cancelar_clase_dia_v2: mockCancelacionGimnasio(tables).admin_cancelar_clase_dia_v2 },
    functions: {
      'send-push': (request) => {
        pushes.push(request.postDataJSON())
        return { destinatarios: 1 }
      },
    },
  })
  await mockEmbedDisciplinesEnClasses(page, tables)

  await irAClases(page)
  await page.getByRole('button', { name: 'Cancelar clase' }).click()
  await expect(page.getByText('Cancelada este día')).toBeVisible()

  await expect.poll(() => mensajes.find((m) => m.startsWith('Clase cancelada para ese día'))).toBeTruthy()
  const resumen = mensajes.find((m) => m.startsWith('Clase cancelada para ese día'))
  expect(resumen).toContain('Crédito devuelto a 1 de 3.')
  expect(resumen).toContain('NO devueltos (2):')
  expect(resumen).toContain('Socio Prueba 2: NO se devolvió el crédito, era de un pago anulado (del 02/10/2026).')
  expect(resumen).toContain('Socio Prueba 3: NO se devolvió el crédito, no tiene créditos vigentes de CrossFit.')

  // Créditos: +1 solo al lote vigente; los otros dos, intactos.
  expect(tables.user_credits.find((f) => f.id === conVigente.lote.id).remaining_credits).toBe(6)
  expect(tables.user_credits.find((f) => f.id === loteAnulado.id).remaining_credits).toBe(0)
  expect(tables.user_credits.find((f) => f.id === loteVencido.id).remaining_credits).toBe(0)

  // Un push por cada texto distinto, cada uno a su socio, ninguno miente.
  const fecha = FECHA_HOY.split('-').reverse().join('/')
  await expect.poll(() => pushes.length).toBe(3)
  const porSocio = Object.fromEntries(pushes.map((p) => [p.targetUserIds[0], p.body]))
  expect(porSocio[conVigente.profile.id]).toContain('Te devolvimos el crédito')
  expect(porSocio[deAnulado.profile.id]).toBe(
    `La clase del ${fecha} se canceló. Ese crédito no se reintegró porque pertenecía a un pago anulado. Consultá con el gimnasio.`,
  )
  expect(porSocio[sinNada.profile.id]).toContain('no se reintegró porque no tenés créditos vigentes de CrossFit')
  expect(pushes.every((p) => p.targetUserIds.length === 1 && p.audience === 'users')).toBe(true)
})

// Tanda 2 (decisión de Facu): una clase de Aparatos (kind = 'membership') no
// usa créditos. Sin acceso vigente, el aviso lo dice; en el resumen de Seba va
// aparte (no es "devuelto" ni "no devuelto").
test('cancelar una clase de APARATOS con un socio sin acceso vigente -- no se crea nada y el aviso lo dice', async ({ page }) => {
  const SOCIOS = nuevosSocios()
  const claseAparatos = { ...CLASE_A_CANCELAR, id: 'clase-e2e-aparatos-cancelar', discipline_id: DISCIPLINA_APARATOS.id, title: 'Aparatos' }
  const [socio] = SOCIOS
  const tables = {
    ...tablasBase(),
    disciplines: [DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS],
    classes: [claseAparatos],
    profiles: [socio.profile],
    user_credits: [socio.lote], // solo CrossFit: ningún acceso a Aparatos
    bookings: [{ ...socio.booking, class_id: claseAparatos.id, credit_lote_id: null }],
    class_occurrence_cancellations: [],
    notifications: [],
  }
  const mensajes = capturarAlertas(page)
  const pushes = []
  await loginComoAdmin(page, {
    tables,
    rpc: { admin_cancelar_clase_dia_v2: mockCancelacionGimnasio(tables).admin_cancelar_clase_dia_v2 },
    functions: {
      'send-push': (request) => {
        pushes.push(request.postDataJSON())
        return { destinatarios: 1 }
      },
    },
  })
  await mockEmbedDisciplinesEnClasses(page, tables)

  await irAClases(page)
  await page.getByRole('button', { name: 'Cancelar clase' }).click()
  await expect(page.getByText('Cancelada este día')).toBeVisible()

  await expect.poll(() => mensajes.find((m) => m.startsWith('Clase cancelada para ese día'))).toBeTruthy()
  const resumen = mensajes.find((m) => m.startsWith('Clase cancelada para ese día'))
  expect(resumen).toContain('Aparatos, no usa créditos (1):')
  expect(resumen).toContain('Socio Prueba 1: Aparatos no usa créditos, no había nada que devolver; no tiene acceso vigente a Aparatos.')
  expect(resumen).not.toContain('NO devueltos')

  expect(tables.user_credits).toHaveLength(1)
  expect(tables.user_credits[0].remaining_credits).toBe(5)
  const fecha = FECHA_HOY.split('-').reverse().join('/')
  const texto = `Aparatos de las 18:00 del ${fecha} fue cancelada por el gimnasio. Aparatos no usa créditos y hoy no tenés acceso vigente a Aparatos. Consultá con el gimnasio.`
  expect(tables.notifications.map((n) => n.body)).toEqual([texto])
  await expect.poll(() => pushes.length).toBe(1)
  expect(pushes[0].body).toBe(texto)
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

  await page.getByPlaceholder('Buscar socio por DNI, nombre o apellido...').fill('50000000')
  await page.getByRole('button', { name: 'Anotar' }).click()

  await expect
    .poll(() => mensajes.some((m) => m === 'No se pudo anotar al socio: Esta clase fue cancelada para esta fecha.'))
    .toBe(true)
})
