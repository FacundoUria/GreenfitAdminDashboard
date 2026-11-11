import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, SOCIO_MARTINA } from './support/fixtures.js'
import { irASocios } from './support/nav.js'
import { mockAdminAcreditarCreditosManual } from './support/rpcMocks.js'

// T5 -- el copiador de la app (sync_my_membership) ya no copia la ficha a
// user_credits. Cobrar a un socio SIN cuenta deja el pago solo en la ficha:
// Seba ve un aviso fijo ("Entendido") con lo cobrado, en vez de "Pago
// registrado correctamente". Y "Pendientes de cargar" le lista a los que ya
// tienen cuenta y todavía no tienen nada vigente en la app.

const SOCIO_SIN_CUENTA = {
  id: 'e2e-socio-sin-cuenta',
  nombre: 'Lucía',
  apellido: 'Paz',
  dni: '30222333',
  email: 'lucia@e2e.test',
  telefono: '2610000001',
  plan: ['CrossFit'],
  estado: 'Activo',
  fecha_vencimiento: null,
  fecha_inicio_cuota: null,
  dia_corte: null,
  created_at: '2025-02-01T00:00:00.000Z',
  ultimo_pago: null,
  creditos: 0,
  activo: true,
}

const SOCIO_SIN_DNI = { ...SOCIO_SIN_CUENTA, id: 'e2e-socio-sin-dni', nombre: 'Ana', apellido: 'Sindni', dni: null, email: 'ana@e2e.test' }

function contadorRpc(tables) {
  const llamadas = []
  const acreditar = mockAdminAcreditarCreditosManual(tables)
  return {
    llamadas,
    rpc: {
      admin_acreditar_creditos_manual: async (request) => {
        llamadas.push(request.postDataJSON())
        return acreditar(request)
      },
    },
  }
}

async function cobrarCrossFit8(page, nombre) {
  await irASocios(page)
  await expect(page.getByRole('table').getByText(nombre)).toBeVisible()
  await page
    .getByRole('table')
    .getByRole('row', { name: new RegExp(nombre) })
    .locator('[title="Registrar Pago / Renovar Cuota"]')
    .click()
  await expect(page.getByText('Registrar Pago / Renovar Cuota')).toBeVisible()
  await page.getByRole('button', { name: '+8' }).last().click()
  await page.getByRole('button', { name: 'Confirmar' }).click()
}

test('cobro a un socio con DNI y SIN cuenta: aviso con lo cobrado, sin acreditar nada en la app', async ({ page }) => {
  const tables = { ...tablasBase(), socios: [SOCIO_MARTINA, SOCIO_SIN_CUENTA] }
  const { llamadas, rpc } = contadorRpc(tables)
  await loginComoAdmin(page, { tables, rpc })

  await cobrarCrossFit8(page, 'Lucía Paz')

  const aviso = page.getByRole('alertdialog', { name: 'Pago guardado en la ficha' })
  await expect(aviso).toBeVisible({ timeout: 10_000 })
  await expect(aviso).toContainText(
    'Este socio no tiene cuenta en la app. Cuando se registre, cargale los créditos desde Editar Socio → Créditos.',
  )
  await expect(aviso).toContainText(/Anotá lo cobrado: CrossFit 8 créditos — vence el \d{2}\/\d{2}\/\d{4}\./)
  await expect(page.getByText('Pago registrado correctamente')).toHaveCount(0)

  // No se cerró solo: sigue ahí hasta "Entendido".
  await page.waitForTimeout(3000)
  await expect(aviso).toBeVisible()
  await aviso.getByRole('button', { name: 'Entendido' }).click()
  await expect(aviso).toBeHidden()

  // El pago quedó en la ficha y no se acreditó nada en la app.
  const ficha = tables.socios.find((s) => s.id === SOCIO_SIN_CUENTA.id)
  expect(ficha.creditos).toBe(8)
  expect(ficha.estado).toBe('Activo')
  expect(llamadas).toHaveLength(0)
  expect(tables.user_credits.filter((f) => f.user_id !== tablasBase().profiles[0].id)).toHaveLength(0)
})

test('cobro a un socio SIN DNI: el aviso explica que sin DNI no puede tener cuenta', async ({ page }) => {
  const tables = { ...tablasBase(), socios: [SOCIO_MARTINA, SOCIO_SIN_DNI] }
  const { llamadas, rpc } = contadorRpc(tables)
  await loginComoAdmin(page, { tables, rpc })

  await cobrarCrossFit8(page, 'Ana Sindni')

  const aviso = page.getByRole('alertdialog', { name: 'Pago guardado en la ficha' })
  await expect(aviso).toBeVisible({ timeout: 10_000 })
  await expect(aviso).toContainText('Este socio no tiene DNI cargado, así que no puede tener cuenta en la app.')
  expect(llamadas).toHaveLength(0)
})

test('cobro a un socio CON cuenta: igual que siempre ("Pago registrado correctamente", sin aviso)', async ({ page }) => {
  const tables = tablasBase()
  const { llamadas, rpc } = contadorRpc(tables)
  await loginComoAdmin(page, { tables, rpc })

  await cobrarCrossFit8(page, 'Martina Ríos')

  await expect(page.getByText('Pago registrado correctamente')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(llamadas).toHaveLength(1)
})

test('cobro: si falla la búsqueda de la cuenta, NO dice "no tiene cuenta" (R5)', async ({ page }) => {
  const tables = { ...tablasBase(), socios: [SOCIO_MARTINA, SOCIO_SIN_CUENTA] }
  const { llamadas, rpc } = contadorRpc(tables)
  await loginComoAdmin(page, { tables, rpc })
  await irASocios(page)
  await expect(page.getByRole('table').getByText('Lucía Paz')).toBeVisible()

  // A partir de acá, la consulta de profiles por DNI de Lucía falla (red/RLS).
  await page.route(
    (url) => url.pathname.endsWith('/rest/v1/profiles') && url.searchParams.get('dni') === `eq.${SOCIO_SIN_CUENTA.dni}`,
    (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'falla simulada de red' }) }),
  )

  await cobrarCrossFit8(page, 'Lucía Paz')

  const aviso = page.getByRole('alertdialog', { name: 'Pago guardado en la ficha' })
  await expect(aviso).toBeVisible({ timeout: 10_000 })
  await expect(aviso).toContainText('No se pudo verificar si el socio tiene cuenta en la app (falla simulada de red)')
  await expect(aviso).not.toContainText('Este socio no tiene cuenta en la app.')
  expect(llamadas).toHaveLength(0)
})

test('"Pagos sin cargar en la app": cartel, filtro con lo de la ficha y "Cargar créditos" abre Editar Socio', async ({ page }) => {
  const tables = tablasBase()
  const hoy = new Date().toISOString().slice(0, 10)
  await loginComoAdmin(page, {
    tables,
    rpc: {
      admin_socios_pendientes_de_cargar: [
        {
          socio_id: SOCIO_MARTINA.id,
          nombre: SOCIO_MARTINA.nombre,
          apellido: SOCIO_MARTINA.apellido,
          dni: SOCIO_MARTINA.dni,
          plan: ['CrossFit'],
          creditos_ficha: 8,
          fecha_vencimiento_ficha: '2030-12-02',
          ultimo_pago: hoy,
        },
      ],
    },
  })
  tables.socios.push({ ...SOCIO_MARTINA, id: 'e2e-socio-otro', nombre: 'Bruno', apellido: 'Otro', dni: '30999888', email: 'bruno@e2e.test' })

  await irASocios(page)
  const cartel = page.getByTestId('pendientes-de-cargar')
  await expect(cartel).toContainText('Martina Ríos pagó cuando todavía no tenía cuenta en la app')

  await cartel.getByRole('button', { name: 'Ver quiénes' }).click()
  const lista = page.getByRole('list', { name: 'Pagos sin cargar en la app' })
  await expect(lista).toContainText('Martina Ríos')
  await expect(lista).toContainText('8 créditos · hasta el 02/12/2030')
  // La tabla quedó filtrada: solo los pendientes.
  await expect(page.getByRole('table').getByText('Martina Ríos')).toBeVisible()
  await expect(page.getByRole('table').getByText('Bruno Otro')).toHaveCount(0)

  await lista.getByRole('button', { name: 'Cargar créditos' }).click()
  await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()
})

test('"Pagos sin cargar en la app": si la consulta falla, cartel rojo con el motivo (R5)', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: tablasBase(),
    rpc: {
      admin_socios_pendientes_de_cargar: {
        __e2eError: { status: 404, body: { code: 'PGRST202', message: 'function not found in schema cache' } },
      },
    },
  })
  await irASocios(page)
  await expect(page.getByTestId('pendientes-de-cargar-error')).toContainText(
    'No se pudo calcular "Pagos sin cargar en la app": function not found in schema cache',
  )
})
