import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { irAClases } from './support/nav.js'
import { mockCancelacionGimnasio } from './support/rpcCancelacionGimnasio.js'
import { tablasBase, DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS, SOCIO_MARTINA, PROFILE_MARTINA } from './support/fixtures.js'

// PARTE A -- click en un inscripto (con dni) redirige a su ficha (deep-link
// ?editar=<dni>, mismo patrón que ?filtro=por_vencer). PARTE B -- "Quitar de
// la clase" reintegra el crédito SIEMPRE (admin_quitar_de_clase), sin importar
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

// Tanda 2 -- "Quitar de la clase" usa admin_quitar_de_clase (cancela EL
// GIMNASIO): el crédito se intenta devolver SIEMPRE, sin importar el tiempo
// de gracia, con las reglas de supabase_migration_cancelacion_gimnasio_
// reintegro.sql (simuladas en e2e/support/rpcCancelacionGimnasio.js). Seba ve
// qué pasó con el crédito y el socio recibe una notificación con la verdad.

test('PARTE B -- "Quitar de la clase" reintegra el crédito SIEMPRE, aunque falten solo 10 minutos (fuera del tiempo de gracia normal)', async ({
  page,
}) => {
  const tables = { ...tablasBase(), classes: [CLASE_A_PUNTO_DE_EMPEZAR], bookings: [BOOKING_MARTINA_PRONTO], notifications: [] }
  // Martina arranca con 4 créditos de CrossFit (USER_CREDITS_MARTINA) --
  // punto de partida, para poder confirmar el +1 real después.
  expect(tables.user_credits[0].remaining_credits).toBe(4)

  const { bodies, mensajes } = await quitarInscripto(page, tables)

  expect(bodies).toEqual([
    {
      p_user_id: PROFILE_MARTINA.id,
      p_class_id: CLASE_A_PUNTO_DE_EMPEZAR.id,
      p_booking_date: BOOKING_MARTINA_PRONTO.booking_date,
      p_reason: 'Quitado por el admin desde el panel',
    },
  ])
  // Con solo 10 minutos de anticipación (contra un tiempo de gracia de 120),
  // cuando cancela el socio no se reintegra -- acá sí, lo sacó el gimnasio.
  expect(tables.user_credits[0].remaining_credits).toBe(5)
  expect(mensajes.some((m) => m.startsWith('Socio quitado de la clase.') && m.includes('Martina Ríos: crédito devuelto'))).toBe(true)
  // Ahora también se le avisa al socio, con la verdad.
  expect(tables.notifications).toHaveLength(1)
  expect(tables.notifications[0]).toMatchObject({ target_user_id: PROFILE_MARTINA.id, title: 'Cambio en tu reserva' })
  expect(tables.notifications[0].body).toContain('El gimnasio te quitó de CrossFit 18hs de las 18:00 del 10/08/2026. Te devolvimos el crédito')
})

// ---- Reintegro por LOTE ----

function loteCrossfit(id, remaining, expiresAt, createdAt) {
  return {
    id,
    user_id: PROFILE_MARTINA.id,
    discipline_id: DISCIPLINA_CROSSFIT.id,
    remaining_credits: remaining,
    expires_at: expiresAt,
    created_at: createdAt,
    discipline: DISCIPLINA_CROSSFIT,
  }
}

// Corre el flujo real de UI ("Quitar de la clase") y devuelve los bodies que
// llegaron al RPC, los mensajes que vio Seba y los push enviados.
async function quitarInscripto(page, tables, titulo = 'CrossFit 18hs') {
  const mensajes = []
  const pushes = []
  page.on('dialog', async (dialog) => {
    if (dialog.type() !== 'confirm') mensajes.push(dialog.message())
    await dialog.accept()
  })
  const mock = mockCancelacionGimnasio(tables, { ahora: () => HORA_CONGELADA })
  await page.clock.setFixedTime(HORA_CONGELADA)
  await loginComoAdmin(page, {
    tables,
    rpc: { admin_quitar_de_clase: mock.admin_quitar_de_clase },
    functions: {
      'send-push': (request) => {
        pushes.push(request.postDataJSON())
        return { destinatarios: 1 }
      },
    },
  })
  await mockEmbedDisciplinesEnClasses(page, tables)
  await irAClases(page)
  await page.getByRole('button', { name: 'Ver Inscriptos' }).click()
  await expect(page.getByRole('heading', { name: titulo })).toBeVisible()
  await page.getByRole('button', { name: 'Quitar de la clase' }).click()
  await expect(page.getByText('Todavía no hay socios inscriptos en esta clase.')).toBeVisible()
  await expect.poll(() => mensajes.length).toBeGreaterThan(0)
  return { bodies: mock.llamadas.map((l) => l.body), mensajes, pushes }
}

const VIGENTE = '2026-12-01T12:00:00.000Z'
const VENCIDO = '2026-08-01T12:00:00.000Z' // antes de HORA_CONGELADA (2026-08-10)

test('lote de origen VIGENTE -- reintegra ahí exacto, no en otro lote (aunque el otro sea más reciente)', async ({ page }) => {
  const tables = {
    ...tablasBase(),
    classes: [CLASE_A_PUNTO_DE_EMPEZAR],
    bookings: [{ ...BOOKING_MARTINA_PRONTO, credit_lote_id: 'lote-origen' }],
    user_credits: [
      loteCrossfit('lote-origen', 3, VIGENTE, '2026-07-01T00:00:00.000Z'),
      loteCrossfit('lote-mas-reciente', 5, VIGENTE, '2026-08-05T00:00:00.000Z'),
    ],
  }
  await quitarInscripto(page, tables)

  expect(tables.user_credits.find((f) => f.id === 'lote-origen').remaining_credits).toBe(4)
  expect(tables.user_credits.find((f) => f.id === 'lote-mas-reciente').remaining_credits).toBe(5)
})

// Tanda 2, decisión D1 = O1: ANTES un lote de origen vencido no devolvía nada.
// Ahora, cuando cancela el gimnasio, el crédito se suma al lote VIGENTE de esa
// disciplina que vence antes (con su fecha).
test('lote de origen VENCIDO -- el crédito se suma al lote vigente que vence antes, y Seba lo ve', async ({ page }) => {
  const tables = {
    ...tablasBase(),
    classes: [CLASE_A_PUNTO_DE_EMPEZAR],
    bookings: [{ ...BOOKING_MARTINA_PRONTO, credit_lote_id: 'lote-vencido' }],
    user_credits: [
      loteCrossfit('lote-vencido', 3, VENCIDO, '2026-07-01T00:00:00.000Z'),
      loteCrossfit('lote-vigente', 5, VIGENTE, '2026-08-05T00:00:00.000Z'),
    ],
  }
  const { mensajes, pushes } = await quitarInscripto(page, tables)

  expect(tables.user_credits.find((f) => f.id === 'lote-vencido').remaining_credits).toBe(3)
  expect(tables.user_credits.find((f) => f.id === 'lote-vigente').remaining_credits).toBe(6)
  expect(mensajes.some((m) => m.includes('su lote original ya estaba vencido o lo reemplazó un pago posterior'))).toBe(true)
  await expect.poll(() => pushes.length).toBe(1)
  expect(pushes[0]).toMatchObject({ title: 'Cambio en tu reserva', audience: 'users', targetUserIds: [PROFILE_MARTINA.id] })
  expect(pushes[0].body).toContain('Te devolvimos el crédito (vence el 01/12/2026)')
})

test('reserva vieja SIN credit_lote_id -- reintegra al lote vigente que VENCE antes, no al más reciente por creación', async ({
  page,
}) => {
  const tables = {
    ...tablasBase(),
    classes: [CLASE_A_PUNTO_DE_EMPEZAR],
    bookings: [{ ...BOOKING_MARTINA_PRONTO, credit_lote_id: null }],
    user_credits: [
      loteCrossfit('lote-vence-antes', 2, '2026-09-15T12:00:00.000Z', '2026-07-01T00:00:00.000Z'),
      loteCrossfit('lote-mas-reciente', 6, '2026-12-01T12:00:00.000Z', '2026-08-05T00:00:00.000Z'),
      loteCrossfit('lote-vencido', 1, VENCIDO, '2026-06-01T00:00:00.000Z'),
    ],
  }
  await quitarInscripto(page, tables)

  expect(tables.user_credits.find((f) => f.id === 'lote-vence-antes').remaining_credits).toBe(3)
  expect(tables.user_credits.find((f) => f.id === 'lote-mas-reciente').remaining_credits).toBe(6)
  expect(tables.user_credits.find((f) => f.id === 'lote-vencido').remaining_credits).toBe(1)
})

// Tanda 2: un lote de un pago ANULADO no se devuelve, aunque siga vigente
// (reversión anterior a la regla F, detectada por creditos[].lote_id). Ni
// siquiera sirve de destino para otro reintegro.
test('lote de un PAGO ANULADO -- no se devuelve, Seba ve el motivo y el socio recibe la verdad', async ({ page }) => {
  const tables = {
    ...tablasBase(),
    classes: [CLASE_A_PUNTO_DE_EMPEZAR],
    bookings: [{ ...BOOKING_MARTINA_PRONTO, credit_lote_id: 'lote-de-pago-anulado' }],
    user_credits: [
      loteCrossfit('lote-de-pago-anulado', 2, VIGENTE, '2026-07-01T00:00:00.000Z'),
      loteCrossfit('lote-bueno', 5, '2026-12-20T12:00:00.000Z', '2026-08-05T00:00:00.000Z'),
    ],
    pagos_socio: [
      {
        id: 'pago-anulado-pre-f',
        user_id: PROFILE_MARTINA.id,
        estado: 'anulado',
        created_at: '2026-07-01T15:00:00.000Z',
        detalle_acreditacion: {
          creditos: [{ discipline_id: DISCIPLINA_CROSSFIT.id, credits_otorgados: 8, lote_id: 'lote-de-pago-anulado' }],
        },
      },
    ],
    notifications: [],
  }
  const { mensajes, pushes } = await quitarInscripto(page, tables)

  expect(tables.user_credits.find((f) => f.id === 'lote-de-pago-anulado').remaining_credits).toBe(2)
  expect(tables.user_credits.find((f) => f.id === 'lote-bueno').remaining_credits).toBe(5)
  expect(mensajes.some((m) => m.includes('Martina Ríos: NO se devolvió el crédito, era de un pago anulado (del 01/07/2026).'))).toBe(true)
  const texto =
    'El gimnasio te quitó de la clase del 10/08/2026. Ese crédito no se reintegró porque pertenecía a un pago anulado. Consultá con el gimnasio.'
  expect(tables.notifications[0].body).toBe(texto)
  await expect.poll(() => pushes.length).toBe(1)
  expect(pushes[0].body).toBe(texto)
})

// Tanda 2 (decisión de Facu): Aparatos (kind = 'membership') no usa créditos.
// Si el gimnasio quita al socio, NO se suma nada a remaining_credits; el aviso
// dice hasta cuándo sigue su acceso.
test('clase de APARATOS -- no se suma ningún crédito y el aviso dice hasta cuándo sigue el acceso', async ({ page }) => {
  const claseAparatos = { ...CLASE_A_PUNTO_DE_EMPEZAR, id: 'clase-e2e-aparatos', discipline_id: DISCIPLINA_APARATOS.id, title: 'Aparatos 18hs' }
  const accesoAparatos = {
    id: 'acceso-aparatos',
    user_id: PROFILE_MARTINA.id,
    discipline_id: DISCIPLINA_APARATOS.id,
    remaining_credits: null,
    expires_at: '2026-12-15T12:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
    discipline: DISCIPLINA_APARATOS,
  }
  const tables = {
    ...tablasBase(),
    classes: [claseAparatos],
    bookings: [{ ...BOOKING_MARTINA_PRONTO, class_id: claseAparatos.id, credit_lote_id: null }],
    user_credits: [...tablasBase().user_credits, accesoAparatos],
    notifications: [],
  }
  // La fila de CrossFit de la fixture es un objeto compartido entre tests del
  // archivo (otro test ya pudo sumarle): se compara contra su valor inicial.
  const crossfitAntes = tables.user_credits.find((f) => f.discipline_id === DISCIPLINA_CROSSFIT.id).remaining_credits
  const { mensajes, pushes } = await quitarInscripto(page, tables, 'Aparatos 18hs')

  expect(tables.user_credits.find((f) => f.id === 'acceso-aparatos')).toMatchObject({ remaining_credits: null, expires_at: '2026-12-15T12:00:00.000Z' })
  expect(tables.user_credits.find((f) => f.discipline_id === DISCIPLINA_CROSSFIT.id).remaining_credits).toBe(crossfitAntes) // CrossFit tampoco se toca
  const texto = 'El gimnasio te quitó de Aparatos 18hs de las 18:00 del 10/08/2026. Aparatos no usa créditos: tu acceso sigue igual hasta el 15/12/2026.'
  expect(tables.notifications).toHaveLength(1)
  expect(tables.notifications[0].body).toBe(texto)
  await expect.poll(() => pushes.length).toBe(1)
  expect(pushes[0].body).toBe(texto)
  expect(
    mensajes.some((m) => m.includes('Martina Ríos: Aparatos no usa créditos, no había nada que devolver; su acceso sigue igual hasta el 15/12/2026.')),
  ).toBe(true)
})
