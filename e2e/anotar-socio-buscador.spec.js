import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { irAClases } from './support/nav.js'
import { tablasBase, DISCIPLINA_CROSSFIT, PROFILE_MARTINA } from './support/fixtures.js'

// Buscador de "Ver inscriptos": la lista de socios y sus créditos se piden una
// vez al abrir el modal, el filtro corre en el navegador, y anotar usa
// admin_book_class (mismo RPC de siempre) -- por id si se elige de la lista,
// por DNI exacto si se tipea el DNI.

const HOY = new Date()
const FECHA_HOY = `${HOY.getFullYear()}-${String(HOY.getMonth() + 1).padStart(2, '0')}-${String(HOY.getDate()).padStart(2, '0')}`

const CLASE = {
  id: 'clase-e2e-buscador',
  discipline_id: DISCIPLINA_CROSSFIT.id,
  title: 'CrossFit Noche',
  instructor: 'Seba',
  capacity: 2,
  days_of_week: [HOY.getDay()],
  start_time: '20:00:00',
  end_time: '21:00:00',
}

const enDias = (n) => new Date(Date.now() + n * 86_400_000).toISOString()

const perfil = (id, nombre, dni) => ({
  id,
  dni,
  full_name: nombre,
  avatar_url: null,
  created_at: '2025-01-01T00:00:00.000Z',
  role: 'socio',
})

const lote = (id, userId, restantes, vence) => ({
  id,
  user_id: userId,
  discipline_id: DISCIPLINA_CROSSFIT.id,
  remaining_credits: restantes,
  expires_at: vence,
  created_at: '2026-07-01T00:00:00.000Z',
  discipline: DISCIPLINA_CROSSFIT,
})

function armarTablas() {
  return {
    ...tablasBase(),
    disciplines: [DISCIPLINA_CROSSFIT],
    classes: [CLASE],
    profiles: [
      PROFILE_MARTINA, // Martina Ríos, DNI de SOCIO_MARTINA
      perfil('e2e-lucia', 'Lucía Martínez', '31222333'),
      perfil('e2e-mariano', 'Mariano Ibáñez', '28999888'),
      perfil('e2e-jose', 'José Ángel Núñez', '44537978'),
      // Fuera de la búsqueda: no es socio (no se puede anotar).
      { ...perfil('e2e-profe', 'Seba Profesor', '20111000'), role: 'admin' },
    ],
    user_credits: [
      lote('uc-martina', PROFILE_MARTINA.id, 4, enDias(20)),
      lote('uc-lucia-vencido', 'e2e-lucia', 5, enDias(-3)), // vencido: NO cuenta
      lote('uc-mariano', 'e2e-mariano', 1, enDias(20)),
      lote('uc-mariano-2', 'e2e-mariano', 2, enDias(30)), // suma: 1 + 2 = 3
      lote('uc-jose-cero', 'e2e-jose', 0, enDias(20)), // sin saldo: NO cuenta
    ],
    bookings: [],
    class_occurrence_cancellations: [],
  }
}

// Mock de admin_book_class con lo justo para ejercitar el flujo: duplicado
// (violación de la restricción única, error crudo de Postgres), sin crédito,
// y el alta real (descuenta 1 del lote que vence antes + crea la reserva).
function mockAdminBookClass(tables, llamadas) {
  return (request) => {
    const body = request.postDataJSON()
    llamadas.push(body)
    const { p_user_id: userId, p_class_id: classId, p_booking_date: fecha } = body

    if ((tables.bookings ?? []).some((b) => b.user_id === userId && b.class_id === classId && b.booking_date === fecha)) {
      return {
        __e2eError: {
          status: 409,
          body: {
            code: '23505',
            message: 'duplicate key value violates unique constraint "bookings_user_id_class_id_booking_date_key"',
          },
        },
      }
    }

    const vigentes = (tables.user_credits ?? [])
      .filter((f) => f.user_id === userId && f.discipline_id === DISCIPLINA_CROSSFIT.id && (f.remaining_credits ?? 0) > 0 && new Date(f.expires_at) > new Date())
      .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at))
    if (vigentes.length === 0) {
      return { __e2eError: { status: 400, body: { message: 'No tenés créditos disponibles para esta disciplina.' } } }
    }
    vigentes[0].remaining_credits -= 1

    const perfilSocio = tables.profiles.find((p) => p.id === userId)
    tables.bookings.push({
      id: `booking-${userId}`,
      user_id: userId,
      class_id: classId,
      booking_date: fecha,
      attended: null,
      credit_lote_id: vigentes[0].id,
      profiles: { full_name: perfilSocio.full_name, dni: perfilSocio.dni },
    })
    return `booking-${userId}`
  }
}

// El mock compartido no resuelve el embed disciplines(show_in_agenda) de Clases.jsx.
async function mockEmbedDisciplinesEnClasses(page, tables) {
  await page.route('**/rest/v1/classes*', async (route) => {
    if (route.request().method() !== 'GET') {
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

async function abrirModal(page, tables, extra = {}) {
  const mensajes = capturarAlertas(page)
  const llamadas = []
  await loginComoAdmin(page, { tables, rpc: { admin_book_class: mockAdminBookClass(tables, llamadas) }, ...extra })
  await mockEmbedDisciplinesEnClasses(page, tables)
  await irAClases(page)
  await page.getByRole('button', { name: 'Ver Inscriptos' }).click()
  await expect(page.getByRole('heading', { name: 'CrossFit' })).toBeVisible()
  return { mensajes, llamadas, buscador: page.getByPlaceholder('Buscar socio por DNI, nombre o apellido...') }
}

test('buscar por nombre (sin tildes ni mayúsculas) o por DNI con puntos: solo aparecen socios CON créditos vigentes, y se ven cuántos', async ({ page }) => {
  const tables = armarTablas()
  const { buscador } = await abrirModal(page, tables)

  // Lucía: su único lote está vencido -> 0 vigentes -> no aparece.
  await buscador.fill('MARTINEZ')
  await expect(page.getByText(/no tienen? créditos vigentes en esta disciplina/)).toBeVisible()
  await expect(page.getByTestId('resultado-socio-e2e-lucia')).toHaveCount(0)

  await buscador.fill('ibañez')
  // 1 + 2 créditos de dos lotes vigentes = 3.
  await expect(page.getByTestId('resultado-socio-e2e-mariano')).toContainText('3 créditos')

  // José: lote vigente pero con saldo 0 -> no aparece.
  await buscador.fill('44.537.978')
  await expect(page.getByText(/no tienen? créditos vigentes en esta disciplina/)).toBeVisible()
  await expect(page.getByTestId('resultado-socio-e2e-jose')).toHaveCount(0)

  await buscador.fill('rios')
  await expect(page.getByTestId('resultado-socio-e2e-profile-martina')).toContainText('4 créditos')

  // Un admin (role != 'socio') nunca aparece: no es anotable.
  await buscador.fill('profesor')
  await expect(page.getByText('Ningún socio coincide con esa búsqueda.')).toBeVisible()
})

test('elegir un socio de la lista lo anota por id (sin volver a buscar por DNI), descuenta y actualiza la lista', async ({ page }) => {
  const tables = armarTablas()
  const consultasPorDni = []
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().includes('/rest/v1/profiles') && /dni=eq\./.test(decodeURIComponent(req.url()))) {
      consultasPorDni.push(req.url())
    }
  })
  const { llamadas, buscador } = await abrirModal(page, tables)

  await buscador.fill('martina')
  await page.getByTestId('resultado-socio-e2e-profile-martina').click()

  // Aparece como inscripta y el buscador se limpia.
  await expect(page.getByRole('button', { name: 'Martina Ríos', exact: true })).toBeVisible()
  await expect(buscador).toHaveValue('')

  expect(llamadas).toHaveLength(1)
  expect(llamadas[0]).toEqual({ p_user_id: PROFILE_MARTINA.id, p_class_id: CLASE.id, p_booking_date: FECHA_HOY })
  expect(consultasPorDni).toHaveLength(0) // ningún lookup por DNI
  expect(tables.user_credits.find((f) => f.id === 'uc-martina').remaining_credits).toBe(3)

  // Si la busco de nuevo: figura "Ya anotado" y con los créditos ya descontados no se ofrece.
  await buscador.fill('martina')
  await expect(page.getByTestId('resultado-socio-e2e-profile-martina')).toContainText('Ya anotado')
  await expect(page.getByTestId('resultado-socio-e2e-profile-martina')).toBeDisabled()
})

test('DNI exacto + Enter: se anota como siempre, buscando el perfil por DNI (también si se tipea con puntos)', async ({ page }) => {
  const tables = armarTablas()
  const consultasPorDni = []
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().includes('/rest/v1/profiles') && /dni=eq\.28999888/.test(decodeURIComponent(req.url()))) {
      consultasPorDni.push(req.url())
    }
  })
  const { llamadas, buscador } = await abrirModal(page, tables)

  await buscador.fill('28.999.888')
  await buscador.press('Enter')

  await expect(page.getByRole('button', { name: 'Mariano Ibáñez', exact: true })).toBeVisible()
  expect(consultasPorDni.length).toBeGreaterThanOrEqual(1)
  expect(llamadas).toEqual([{ p_user_id: 'e2e-mariano', p_class_id: CLASE.id, p_booking_date: FECHA_HOY }])
  // Descuenta del lote que vence antes (el de 1 crédito).
  expect(tables.user_credits.find((f) => f.id === 'uc-mariano').remaining_credits).toBe(0)
  expect(tables.user_credits.find((f) => f.id === 'uc-mariano-2').remaining_credits).toBe(2)
})

test('DNI que no existe: mismo aviso de siempre', async ({ page }) => {
  const tables = armarTablas()
  const { mensajes, buscador } = await abrirModal(page, tables)

  await buscador.fill('99999999')
  await buscador.press('Enter')

  await expect
    .poll(() => mensajes.some((m) => m === 'No se encontró ningún socio con ese DNI (o todavía no tiene cuenta creada en la app).'))
    .toBe(true)
})

test('ya anotado (por si la lista quedó desactualizada): mensaje claro, nunca el error crudo de Postgres', async ({ page }) => {
  const tables = armarTablas()
  const { mensajes, buscador } = await abrirModal(page, tables)

  // Otra persona anota a Martina desde otro dispositivo DESPUÉS de abrir el modal:
  // este modal todavía no lo sabe (bookings ya cargados) y deja tocarla.
  tables.bookings.push({
    id: 'booking-externo',
    user_id: PROFILE_MARTINA.id,
    class_id: CLASE.id,
    booking_date: FECHA_HOY,
    attended: null,
    profiles: { full_name: 'Martina Ríos', dni: PROFILE_MARTINA.dni },
  })

  await buscador.fill('martina')
  await page.getByTestId('resultado-socio-e2e-profile-martina').click()

  await expect.poll(() => mensajes.length).toBeGreaterThan(0)
  expect(mensajes[0]).toBe('Ya anotado: Martina Ríos ya está en esta clase.')
  expect(mensajes.join(' ')).not.toMatch(/duplicate|constraint|23505/i)
})

test('sin créditos: se conserva el mensaje real del RPC', async ({ page }) => {
  const tables = armarTablas()
  const { mensajes, buscador } = await abrirModal(page, tables)

  // Lucía no aparece en la lista (sin créditos vigentes), pero tipeando su DNI
  // completo el intento sigue su camino de siempre y el RPC decide.
  await buscador.fill('31222333')
  await expect(page.getByTestId('resultado-socio-e2e-lucia')).toHaveCount(0)
  await buscador.press('Enter')

  await expect
    .poll(() => mensajes.some((m) => m === 'No se pudo anotar al socio: No tenés créditos disponibles para esta disciplina.'))
    .toBe(true)
  expect(tables.bookings).toHaveLength(0)
})

test('si la lista de socios no carga, el modal sigue sirviendo para anotar por DNI', async ({ page }) => {
  const tables = armarTablas()
  const llamadas = []
  const mensajes = capturarAlertas(page)
  await loginComoAdmin(page, { tables, rpc: { admin_book_class: mockAdminBookClass(tables, llamadas) } })
  await mockEmbedDisciplinesEnClasses(page, tables)

  // La consulta masiva del buscador (sin filtro de dni) falla; la búsqueda por
  // DNI exacto sigue pasando por el mock normal.
  await page.route('**/rest/v1/profiles*', async (route) => {
    const url = decodeURIComponent(route.request().url())
    if (route.request().method() === 'GET' && /role=eq\.socio/.test(url) && !/dni=eq\./.test(url)) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'boom' }) })
      return
    }
    await route.fallback()
  })

  await irAClases(page)
  await page.getByRole('button', { name: 'Ver Inscriptos' }).click()
  const buscador = page.getByPlaceholder('Buscar socio por DNI, nombre o apellido...')

  await buscador.fill('31222333')
  await expect(page.getByText(/No se pudo cargar la lista de socios/)).toBeVisible()
  await buscador.press('Enter')

  // Lucía tiene el único lote vencido -> el RPC lo rechaza, pero el camino por DNI llegó hasta el RPC.
  await expect.poll(() => llamadas.length).toBe(1)
  expect(llamadas[0].p_user_id).toBe('e2e-lucia')
  await expect.poll(() => mensajes.some((m) => m.startsWith('No se pudo anotar al socio:'))).toBe(true)
})
