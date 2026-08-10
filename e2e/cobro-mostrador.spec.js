import { test, expect } from '@playwright/test'
import { loginComoAdmin, ADMIN_DEMO } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// Flujo completo de "Cobro Mostrador": Seba selecciona un socio, toca
// "Cobrar", le asigna créditos a una disciplina puntual (ej. Kickboxing) y
// confirma. Cubre de punta a punta:
//   1) El pago se registra sin ningún alert() de error ni mensaje genérico.
//   2) Los créditos se acreditan DIRECTO en `user_credits` (fuente de verdad
//      real de la PWA) sumados al balance vigente de ESA disciplina.
//   3) El historial en `pagos_socio` queda con los nombres de campo exactos
//      que espera la tabla real (supabase_migration_ficha360.sql).
//   4) La tabla de Socios refleja el saldo nuevo sin recargar la página.

const DISCIPLINA_KICKBOXING = { id: 'disc-kickboxing', name: 'Kickboxing', kind: 'credits' }

const SOCIO_KICK = {
  id: 'e2e-socio-kick',
  nombre: 'Braian',
  apellido: 'Gómez',
  dni: '20555666',
  email: 'braian@e2e.test',
  telefono: '2610000002',
  plan: ['Kickboxing'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  created_at: '2025-03-01T00:00:00.000Z',
  ultimo_pago: '2026-07-01',
  creditos: 2,
  activo: true,
}

const PROFILE_KICK = {
  id: 'e2e-profile-kick',
  dni: SOCIO_KICK.dni,
  full_name: 'Braian Gómez',
  avatar_url: null,
  created_at: '2025-03-01T00:00:00.000Z',
  role: 'socio',
}

function userCreditsIniciales() {
  return [
    {
      id: 'uc-kick-1',
      user_id: PROFILE_KICK.id,
      discipline_id: DISCIPLINA_KICKBOXING.id,
      remaining_credits: 2,
      created_at: '2026-08-01T00:00:00.000Z',
    },
  ]
}

// El mock E2E compartido (supabaseMock.js, usado por otras 17 specs) no
// resuelve joins de verdad -- devuelve las filas de `user_credits` tal cual
// están en el fixture, sin el `discipline:{...}` embebido que pide
// fetchCreditosPorDisciplina. El resto de la suite esquiva esto embebiendo
// el campo a mano en las filas de fixture (ver creditos-por-disciplina.spec.js),
// pero eso no alcanza para ESTE test: necesitamos que la fila que la propia
// UI inserta en caliente (sincronizarCreditosPwa) también quede embebida,
// para poder probar que la tabla de Socios refleja el saldo nuevo de verdad
// -- sin reload -- en vez de solo inspeccionar el estado interno del mock.
// Por eso se registra acá, LOCAL a este archivo, un route handler adicional
// que solo resuelve ese embed (a partir de discipline_id + tables.disciplines)
// y no toca el mock compartido ni el resto de la suite.
async function mockEmbedUserCredits(page, tables) {
  await page.route('**/rest/v1/user_credits*', async (route) => {
    const request = route.request()
    if (request.method() !== 'GET') {
      await route.fallback()
      return
    }

    const url = new URL(request.url())
    const userIdParam = url.searchParams.get('user_id') ?? ''
    const match = userIdParam.match(/^in\.\((.*)\)$/)
    const userIds = match ? match[1].split(',').map((v) => v.replace(/^"|"$/g, '')) : null

    // `created_at` en producción lo pone el default de la columna (`now()`)
    // -- una fila recién insertada por sincronizarCreditosPwa no lo manda
    // en el payload, así que acá (el mock no simula defaults de columna)
    // llega sin ese campo. Sin fallback, "sin fecha" ordenaba como más
    // vieja en vez de más nueva, y la fila recién insertada perdía contra
    // la de la fixture al desempatar por (user_id, discipline_id).
    const timestamp = (fila) => (fila.created_at ? new Date(fila.created_at).getTime() : Number.MAX_SAFE_INTEGER)
    const filas = (tables.user_credits ?? [])
      .filter((fila) => !userIds || userIds.includes(String(fila.user_id)))
      .map((fila) => ({
        ...fila,
        discipline: (tables.disciplines ?? []).find((d) => d.id === fila.discipline_id) ?? null,
      }))
      .sort((a, b) => timestamp(b) - timestamp(a))

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(filas) })
  })
}

test('Cobro mostrador: acreditar créditos a una disciplina se refleja en la tabla sin recargar y sin alertas de error', async ({
  page,
}) => {
  const tables = {
    ...tablasBase(),
    disciplines: [...tablasBase().disciplines, DISCIPLINA_KICKBOXING],
    socios: [SOCIO_KICK],
    profiles: [PROFILE_KICK],
    user_credits: userCreditsIniciales(),
  }

  // Cualquier window.alert() disparado durante el flujo es, por definición,
  // el "mensaje de error" que este test tiene que probar que NO aparece.
  let huboAlerta = false
  page.on('dialog', async (dialog) => {
    huboAlerta = true
    await dialog.dismiss()
  })

  await loginComoAdmin(page, { tables })
  await mockEmbedUserCredits(page, tables)

  await irASocios(page)
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Braian Gómez/ })
  await expect(filaTabla).toBeVisible()

  // Saldo real ANTES del cobro (viene de la fixture) -- confirma que la
  // lectura ya funciona antes de tocar nada.
  await expect(filaTabla.getByTitle('Créditos reales de Kickboxing en la app')).toHaveText('2')

  await filaTabla.locator('[title="Registrar Pago / Renovar Cuota"]').click()
  await expect(page.getByText('Registrar Pago / Renovar Cuota')).toBeVisible()

  // Kickboxing ya viene pre-tildado (es el único plan de Braian). Se le
  // asignan 8 créditos con el pack rápido -- último "+8" en el DOM: el modal
  // se monta después de SociosTabla (mobile card + desktop table coexisten).
  await page.getByRole('button', { name: '+8' }).last().click()
  await page.getByLabel('Monto cobrado (opcional)').fill('12000')

  await page.getByRole('button', { name: 'Confirmar' }).click()

  await expect(page.getByText('Pago registrado correctamente')).toBeVisible({ timeout: 10_000 })
  expect(huboAlerta, 'no debe dispararse ningún alert() de error durante el cobro').toBe(false)

  // La tabla muestra el saldo REAL actualizado (2 + 8 = 10) sin recargar la
  // página -- fetchSocios() dispara el refetch de créditos por disciplina
  // automáticamente apenas se confirma el pago.
  await expect(filaTabla.getByTitle('Créditos reales de Kickboxing en la app')).toHaveText('10', {
    timeout: 10_000,
  })

  // Historial de pagos (pagos_socio) -- nombres de campo EXACTOS que espera
  // la tabla real (ver supabase_migration_ficha360.sql).
  expect(tables.pagos_socio).toHaveLength(1)
  const pago = tables.pagos_socio[0]
  expect(pago.user_id).toBe(PROFILE_KICK.id)
  expect(pago.paquete).toBe('Kickboxing')
  expect(pago.monto).toBe(12000)
  expect(pago.metodo_pago).toBe('efectivo')
  expect(pago.estado).toBe('pagado')
  expect(pago.origen).toBe('manual')
  expect(pago.periodo_hasta).toBeNull()
  expect(pago.created_by).toBe(ADMIN_DEMO.id)

  // Acreditación directa en user_credits -- la fila nueva (ledger append-only,
  // ver sincronizarCreditosPwa) es la que realmente sube el saldo.
  const filasKickboxing = tables.user_credits.filter((f) => f.discipline_id === DISCIPLINA_KICKBOXING.id)
  expect(filasKickboxing).toHaveLength(2)
  expect(filasKickboxing.at(-1).remaining_credits).toBe(10)

  // El pozo global legacy (socios.creditos) también queda al día -- lo sigue
  // usando `esPlanDeCreditos`/`socios.creditos` como fallback en otras vistas.
  expect(tables.socios[0].creditos).toBe(10)
})

// Regresión: en producción, cuando el UPDATE de `socios` fallaba (típico:
// RLS bloqueando la escritura porque el admin logueado no matchea
// `public.is_admin()`), el alert que veía Seba era siempre el genérico "No
// se pudo registrar el pago. Intentá nuevamente.", sin ninguna pista de la
// causa real -- este branch tenía su propio alert hardcodeado, ajeno al
// try/catch general que ya mostraba el motivo real para otras fallas del
// mismo flujo. Este test fija ESE caso puntual.
test('Registrar Pago: si el UPDATE de socios falla, el alert muestra el motivo real (no el genérico) y el botón no queda trabado', async ({
  page,
}) => {
  const tables = tablasBase()

  let mensajeDialogo = null
  page.on('dialog', async (dialog) => {
    mensajeDialogo = dialog.message()
    await dialog.dismiss()
  })

  await loginComoAdmin(page, { tables })

  // Simula el UPDATE de `socios` bloqueado (Postgrest real responde 200 con
  // 0 filas cuando una policy RLS bloquea la escritura, sin `error`).
  await page.route('**/rest/v1/socios*', async (route) => {
    const request = route.request()
    if (request.method() !== 'PATCH') {
      await route.fallback()
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })

  await irASocios(page)
  await expect(page.getByRole('table').getByText('Martina Ríos')).toBeVisible()
  await page.locator('[title="Registrar Pago / Renovar Cuota"]:visible').click()
  await expect(page.getByText('Registrar Pago / Renovar Cuota')).toBeVisible()

  // CrossFit ya viene pre-tildado -- hace falta cargar algún crédito para
  // pasar la validación local y llegar a onConfirmar().
  await page.getByRole('button', { name: '+8' }).last().click()

  const botonConfirmar = page.getByRole('button', { name: 'Confirmar' })
  await botonConfirmar.click()

  await expect.poll(() => mensajeDialogo, { timeout: 10_000 }).not.toBeNull()
  expect(mensajeDialogo).not.toBe('No se pudo registrar el pago. Intentá nuevamente.')
  expect(mensajeDialogo.startsWith('No se pudo registrar el pago:')).toBe(true)
  expect(mensajeDialogo.length).toBeGreaterThan('No se pudo registrar el pago:'.length)

  // El modal sigue abierto y el botón volvió a habilitarse -- no quedó
  // trabado en "Guardando...".
  await expect(botonConfirmar).toBeEnabled()
  await expect(botonConfirmar).toHaveText('Confirmar')
})

// Regresión de producción real (2026-08-08): con el alert ya desenmascarado,
// el motivo exacto resultó ser "Could not find the 'fecha_inicio_cuota'
// column of 'socios' in the schema cache" -- la migración
// supabase_migration_fecha_inicio_cuota.sql (ya existe en el repo) todavía
// no se había corrido en ese ambiente. Postgrest rechaza el UPDATE ENTERO
// por esa única columna faltante, no solo esa columna -- sin el fallback de
// abajo, NINGÚN cobro de un socio con plan de vencimiento se guardaba (ni
// fecha_vencimiento, ni dia_corte, ni estado, que sí son columnas reales).
const SOCIO_PASE_LIBRE_MIGRACION_PENDIENTE = {
  id: 'e2e-socio-pase-libre-migracion',
  nombre: 'Rocío',
  apellido: 'Funes',
  dni: '27444555',
  email: 'rocio@e2e.test',
  telefono: '2610000003',
  plan: ['Pase Libre'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  created_at: '2025-04-01T00:00:00.000Z',
  ultimo_pago: '2026-07-01',
  creditos: 0,
  activo: true,
}

test('Registrar Pago: si falta la columna fecha_inicio_cuota (migración pendiente), el resto del cobro se guarda igual y no hay alert de error', async ({
  page,
}) => {
  const tables = { ...tablasBase(), socios: [SOCIO_PASE_LIBRE_MIGRACION_PENDIENTE] }

  let huboAlerta = false
  page.on('dialog', async (dialog) => {
    huboAlerta = true
    await dialog.dismiss()
  })

  await loginComoAdmin(page, { tables })

  // Cualquier UPDATE de `socios` que incluya `fecha_inicio_cuota` en el
  // payload responde con el error real de producción; sin esa columna, deja
  // pasar al mock compartido normalmente (simula que el resto de columnas sí
  // existen en la tabla real).
  await page.route('**/rest/v1/socios*', async (route) => {
    const request = route.request()
    if (request.method() !== 'PATCH') {
      await route.fallback()
      return
    }
    const payload = request.postDataJSON()
    if (payload && 'fecha_inicio_cuota' in payload) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'PGRST204',
          message: "Could not find the 'fecha_inicio_cuota' column of 'socios' in the schema cache",
          details: null,
          hint: null,
        }),
      })
      return
    }
    await route.fallback()
  })

  await irASocios(page)
  await expect(page.getByRole('table').getByText('Rocío Funes')).toBeVisible()
  await page.locator('[title="Registrar Pago / Renovar Cuota"]:visible').click()
  await expect(page.getByText('Registrar Pago / Renovar Cuota')).toBeVisible()
  await expect(page.getByLabel('Fecha de inicio')).toBeVisible()

  await page.getByRole('button', { name: 'Confirmar' }).click()

  await expect(
    page.getByText('la fecha de inicio personalizada no se guardó', { exact: false }),
  ).toBeVisible({ timeout: 10_000 })
  expect(huboAlerta, 'el resto del cobro se guardó bien -- esto no debería mostrar un alert() de error').toBe(false)

  // El resto del cobro (columnas que sí existen) quedó guardado igual.
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Rocío Funes/ })
  await expect(filaTabla).toBeVisible()
  expect(tables.socios[0].fecha_vencimiento).not.toBeNull()
  expect(tables.socios[0].dia_corte).not.toBeNull()
  expect(tables.socios[0].estado).toBe('Activo')
  // La columna sin migrar nunca se mandó en el segundo intento -- no quedó
  // ningún valor pisado en el mock.
  expect(tables.socios[0].fecha_inicio_cuota).toBeUndefined()
})

// Mismo criterio UTC que registrar-pago-fechas.spec.js -- evita que un test
// corrido cerca de medianoche en un huso detrás de UTC calcule "hoy" distinto
// de lo que calcula el browser.
function isoUTC(date) {
  return date.toISOString().slice(0, 10)
}
function sumarDiasUTC(iso, dias) {
  const fecha = new Date(`${iso}T00:00:00.000Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return isoUTC(fecha)
}

// "Actividad / Plan de este pago" ya no es la lista fija PLANES_DISPONIBLES:
// sale de `disciplines` (is_active=true). Una disciplina nueva ("Yoga
// Terapéutico", creada acá vía fixture -- el alta real ya la cubre
// disciplinas-horarios.spec.js) tiene que aparecer sola en el modal, y si es
// "por vencimiento" con días configurados, tildarla sugiere la fecha de
// vencimiento automáticamente sin que el admin tenga que calcularla a mano.
const DISCIPLINA_YOGA = { id: 'disc-yoga', name: 'Yoga Terapéutico', kind: 'membership', default_capacity: 45, is_active: true }

const SOCIO_CROSSFIT_SIN_YOGA = {
  id: 'e2e-socio-crossfit-yoga',
  nombre: 'Nadia',
  apellido: 'Solari',
  dni: '25666777',
  email: 'nadia@e2e.test',
  telefono: '2610000004',
  plan: ['CrossFit'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  created_at: '2025-05-01T00:00:00.000Z',
  ultimo_pago: '2026-07-01',
  creditos: 0,
  activo: true,
}

test('Registrar Pago: una disciplina nueva (por vencimiento, con días configurados) aparece en la lista y sugiere el vencimiento sola', async ({
  page,
}) => {
  const tables = {
    ...tablasBase(),
    disciplines: [...tablasBase().disciplines, DISCIPLINA_YOGA],
    socios: [SOCIO_CROSSFIT_SIN_YOGA],
  }

  let huboAlerta = false
  page.on('dialog', async (dialog) => {
    huboAlerta = true
    await dialog.dismiss()
  })

  await loginComoAdmin(page, { tables })

  await irASocios(page)
  await expect(page.getByRole('table').getByText('Nadia Solari')).toBeVisible()
  await page.locator('[title="Registrar Pago / Renovar Cuota"]:visible').click()
  await expect(page.getByText('Registrar Pago / Renovar Cuota')).toBeVisible()

  // Nadia solo tiene CrossFit (créditos) -- todavía no aparecen los
  // datepickers de vencimiento.
  await expect(page.getByLabel('Fecha de inicio')).toHaveCount(0)

  // La disciplina nueva figura en la lista de actividades -- sin tocar
  // código, sale de `disciplines`.
  await expect(page.getByText('Yoga Terapéutico', { exact: true })).toBeVisible()

  const hoy = isoUTC(new Date())
  const vencimientoEsperado = sumarDiasUTC(hoy, 45)

  await page.getByText('Yoga Terapéutico', { exact: true }).click()

  // Al tildarla, aparecen los datepickers Y la fecha de vencimiento sugerida
  // ya viene calculada (hoy + 45 días, sin que el admin tenga que tocar nada).
  await expect(page.getByLabel('Fecha de inicio')).toHaveValue(hoy)
  await expect(page.getByLabel('Fecha de vencimiento')).toHaveValue(vencimientoEsperado)

  // CrossFit sigue tildado (créditos) -- hace falta cargar algo para pasar
  // la validación local.
  await page.getByRole('button', { name: '+8' }).last().click()

  await page.getByRole('button', { name: 'Confirmar' }).click()

  await expect(page.getByText('Pago registrado correctamente')).toBeVisible({ timeout: 10_000 })
  expect(huboAlerta).toBe(false)

  // Impactó de verdad en la ficha del socio.
  expect(tables.socios[0].fecha_vencimiento).toBe(vencimientoEsperado)
  expect(tables.socios[0].plan).toContain('Yoga Terapéutico')
  expect(tables.socios[0].plan).toContain('CrossFit')
})
