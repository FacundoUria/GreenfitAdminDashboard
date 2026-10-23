import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'
import { mockAdminAcreditarCreditosManual } from './support/rpcMocks.js'

// Bug real: el "hoy" del cobro (RegistrarPagoModal + Socios.jsx) y del alta
// (NuevoSocioModal) salía de hoyISO() (UTC) -- de 21:00 a 23:59 de Argentina
// ya es mañana, así que la cuota arrancaba MAÑANA (inicio, día de corte,
// vencimiento, p_fecha_inicio y ultimo_pago un día corridos) y un socio que
// vencía hoy se trataba como "vencido".
//
// Reloj congelado del navegador (page.clock) con instantes en UTC, y el
// navegador en hora de Argentina y en UTC: el resultado no puede depender
// de la zona de la PC. Jueves 22/10/2026 -> viernes 23/10/2026.

const SOCIO_SIN_PAGOS = {
  id: 'e2e-socio-noche',
  nombre: 'Nora',
  apellido: 'Noche',
  dni: '30777111',
  email: 'nora@e2e.test',
  telefono: '2610000101',
  plan: ['Pase Libre'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  created_at: '2025-03-01T00:00:00.000Z',
  ultimo_pago: null,
  creditos: 0,
  activo: true,
}

// Con cuenta en la app (y sin nada vigente) -> el cobro corre la RPC
// admin_acreditar_creditos_manual y deja un renglón en pagos_socio.
const PROFILE_SIN_PAGOS = {
  id: 'e2e-profile-noche',
  dni: SOCIO_SIN_PAGOS.dni,
  full_name: 'Nora Noche',
  avatar_url: null,
  created_at: '2025-03-01T00:00:00.000Z',
  role: 'socio',
}

// Sin cuenta en la app: su vencimiento es la columna (vence HOY, 22/10).
const SOCIO_VENCE_HOY = {
  ...SOCIO_SIN_PAGOS,
  id: 'e2e-socio-vence-hoy',
  nombre: 'Vera',
  apellido: 'Vence',
  dni: '30777222',
  email: 'vera@e2e.test',
  fecha_vencimiento: '2026-10-22',
  dia_corte: 22,
  ultimo_pago: '2026-09-22',
}

// [hora en Argentina, instante, fecha de inicio esperada, vencimiento esperado, día de corte]
const INSTANTES = {
  '20:59': ['2026-10-22T23:59:00Z', '2026-10-22', '2026-11-22', 22],
  '21:00': ['2026-10-23T00:00:00Z', '2026-10-22', '2026-11-22', 22],
  '21:30': ['2026-10-23T00:30:00Z', '2026-10-22', '2026-11-22', 22],
  '23:59': ['2026-10-23T02:59:00Z', '2026-10-22', '2026-11-22', 22],
  '00:00': ['2026-10-23T03:00:00Z', '2026-10-23', '2026-11-23', 23],
}

function seguirDialogos(page) {
  const dialogos = []
  page.on('dialog', async (dialog) => {
    dialogos.push(dialog.message())
    await dialog.dismiss()
  })
  return dialogos
}

for (const timezoneId of ['America/Argentina/Mendoza', 'UTC']) {
  test.describe(`navegador en ${timezoneId}`, () => {
    test.use({ timezoneId })

    // Los 4 instantes del plan (más 21:30) en hora de Argentina; en UTC alcanza
    // con 21:30, que es el caso del bug.
    const horas = timezoneId === 'UTC' ? ['21:30'] : ['20:59', '21:00', '21:30', '23:59', '00:00']

    for (const hora of horas) {
      const [instante, inicio, vencimiento, diaCorte] = INSTANTES[hora]

      test(`cobro a las ${hora} de Argentina a un socio sin pagos: arranca el ${inicio} y vence el ${vencimiento}`, async ({ page }) => {
        await page.clock.setFixedTime(new Date(instante))
        // Copias propias de este caso: la base simulada modifica la fila del socio al
        // confirmar el cobro, y el objeto de arriba es compartido entre casos del archivo.
        const tables = {
          ...tablasBase(),
          socios: [...tablasBase().socios, structuredClone(SOCIO_SIN_PAGOS)],
          profiles: [...tablasBase().profiles, structuredClone(PROFILE_SIN_PAGOS)],
          pagos_socio: [],
        }
        const dialogos = seguirDialogos(page)
        await loginComoAdmin(page, {
          tables,
          rpc: { admin_acreditar_creditos_manual: mockAdminAcreditarCreditosManual(tables) },
        })

        await irASocios(page)
        const fila = page.getByRole('table').getByRole('row', { name: /Nora Noche/ })
        await expect(fila).toBeVisible()
        await fila.locator('[title="Registrar Pago / Renovar Cuota"]').click()

        await expect(page.getByLabel('Fecha de inicio', { exact: true })).toHaveValue(inicio)
        await expect(page.getByLabel('Fecha de vencimiento', { exact: true })).toHaveValue(vencimiento)
        await expect(page.getByText(/1 mes desde hoy/)).toBeVisible()

        await page.getByRole('button', { name: 'Confirmar' }).click()
        await expect(page.getByText('Pago registrado correctamente')).toBeVisible({ timeout: 10_000 })
        expect(dialogos).toEqual([])

        const socio = tables.socios.find((s) => s.id === SOCIO_SIN_PAGOS.id)
        expect(socio.ultimo_pago).toBe(inicio)
        expect(socio.fecha_inicio_cuota).toBe(inicio)
        expect(socio.dia_corte).toBe(diaCorte)
        expect(socio.fecha_vencimiento).toBe(vencimiento)

        // p_fecha_inicio + p_dias_vigencia -> la fecha que la RPC (simulada)
        // le pone al plan nuevo.
        const aparatos = tables.user_credits.filter((f) => f.user_id === PROFILE_SIN_PAGOS.id)
        expect(aparatos.map((f) => f.expires_at)).toEqual([`${vencimiento}T12:00:00.000Z`])

        expect(tables.pagos_socio).toHaveLength(1)
        expect(tables.pagos_socio[0].periodo_desde).toBe(inicio)
        expect(tables.pagos_socio[0].periodo_hasta).toBe(vencimiento)
      })
    }

    test('cobro a las 21:30 de Argentina a un socio que vence HOY (22/10): no está "vencido", arranca desde su vencimiento', async ({ page }) => {
      await page.clock.setFixedTime(new Date(INSTANTES['21:30'][0]))
      // Copia propia de este caso (ver el comentario del caso de arriba).
      const tables = { ...tablasBase(), socios: [...tablasBase().socios, structuredClone(SOCIO_VENCE_HOY)] }
      const dialogos = seguirDialogos(page)
      await loginComoAdmin(page, { tables })

      await irASocios(page)
      const fila = page.getByRole('table').getByRole('row', { name: /Vera Vence/ })
      await expect(fila).toBeVisible()
      await fila.locator('[title="Registrar Pago / Renovar Cuota"]').click()

      await expect(page.getByText(/desde el vencimiento actual/)).toBeVisible()
      await expect(page.getByText(/El socio está vencido/)).toHaveCount(0)
      await expect(page.getByLabel('Fecha de inicio', { exact: true })).toHaveValue('2026-10-22')
      await expect(page.getByLabel('Fecha de vencimiento', { exact: true })).toHaveValue('2026-11-22')

      await page.getByRole('button', { name: 'Confirmar' }).click()
      await expect(page.getByText('Pago registrado correctamente')).toBeVisible({ timeout: 10_000 })
      expect(dialogos).toEqual([])

      const socio = tables.socios.find((s) => s.id === SOCIO_VENCE_HOY.id)
      expect(socio.ultimo_pago).toBe('2026-10-22')
      expect(socio.fecha_inicio_cuota).toBe('2026-10-22')
      expect(socio.dia_corte).toBe(22)
      expect(socio.fecha_vencimiento).toBe('2026-11-22')
    })

    test('alta a las 21:30 de Argentina: propone el 22/10 y guarda corte 22, vencimiento 22/11 y p_fecha_inicio 22/10', async ({ page }) => {
      await page.clock.setFixedTime(new Date(INSTANTES['21:30'][0]))
      // Cuenta de la app ya creada para ese DNI (lo que hace el trigger
      // on_socio_dni_upsert en producción) -> el alta corre la RPC.
      const profileAlta = { ...PROFILE_SIN_PAGOS, id: 'e2e-profile-alta-noche', dni: '30777333', full_name: 'Alba Alta' }
      const tables = { ...tablasBase(), profiles: [...tablasBase().profiles, profileAlta] }
      const dialogos = seguirDialogos(page)
      await loginComoAdmin(page, {
        tables,
        rpc: { admin_acreditar_creditos_manual: mockAdminAcreditarCreditosManual(tables) },
      })

      await irASocios(page)
      await page.getByRole('button', { name: 'Nuevo Socio' }).click()
      await expect(page.getByLabel('Fecha de Inicio', { exact: true })).toHaveValue('2026-10-22')

      await page.getByLabel('Nombre', { exact: true }).fill('Alba')
      await page.getByLabel('Apellido', { exact: true }).fill('Alta')
      await page.getByLabel('DNI', { exact: true }).fill(profileAlta.dni)
      await page.getByLabel('Email', { exact: true }).fill('alba@e2e.test')
      await page.getByRole('checkbox', { name: 'Pase Libre' }).check()
      await page.getByRole('button', { name: 'Guardar' }).click()

      await expect.poll(() => tables.user_credits.filter((f) => f.user_id === profileAlta.id).length).toBe(1)
      expect(dialogos).toEqual([])

      const socio = tables.socios.find((s) => s.dni === profileAlta.dni)
      expect(socio.ultimo_pago).toBe('2026-10-22')
      expect(socio.dia_corte).toBe(22)
      expect(socio.fecha_vencimiento).toBe('2026-11-22')
      const aparatos = tables.user_credits.find((f) => f.user_id === profileAlta.id)
      expect(aparatos.expires_at).toBe('2026-11-22T12:00:00.000Z')
    })
  })
}
