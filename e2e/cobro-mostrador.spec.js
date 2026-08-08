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
