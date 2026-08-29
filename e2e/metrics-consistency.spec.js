import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { irASocios } from './support/nav.js'

// Cubre el fix de "Socios Activos"/"Cuotas Vencidas" mostrando números
// DISTINTOS en Home y en Socios para el mismo padrón de socios -- ambas
// pantallas ahora llaman a la misma getSocioMetrics()/estadoOperativoSocio()
// (src/utils/socioMetrics.js), así que este test arma un padrón mixto a
// propósito (activo por fecha, en tolerancia, vencido, sin fecha_vencimiento
// -- plan de créditos -- y dado de baja) y verifica que Home y Socios
// muestren EXACTAMENTE el mismo valor para cada tarjeta.

function fechaOffset(dias) {
  const fecha = new Date()
  fecha.setDate(fecha.getDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

// dias_tolerancia = 5 (mismo default que tablasBase() del resto de la suite).
const DIAS_TOLERANCIA = 5

const SOCIOS_MIXTOS = [
  {
    id: 'socio-activo-fecha',
    nombre: 'Ana',
    apellido: 'Activa',
    dni: '10000001',
    email: 'ana@e2e.test',
    plan: ['Aparatos'],
    estado: 'Activo',
    fecha_vencimiento: fechaOffset(10), // vence en el futuro -> activo
    dia_corte: 10,
    creditos: 0,
    activo: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'socio-tolerancia',
    nombre: 'Tomás',
    apellido: 'Tolerante',
    dni: '10000002',
    email: 'tomas@e2e.test',
    plan: ['Aparatos'],
    estado: 'Vencido', // texto legacy A PROPÓSITO "equivocado" -- si algo
    // todavía leyera este campo en vez del cálculo real, este socio
    // aparecería mal categorizado y el test lo detectaría.
    fecha_vencimiento: fechaOffset(-2), // vencido hace 2 días, dentro de la tolerancia (5)
    dia_corte: 10,
    creditos: 0,
    activo: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'socio-vencido',
    nombre: 'Vicky',
    apellido: 'Vencida',
    dni: '10000003',
    email: 'vicky@e2e.test',
    plan: ['Aparatos'],
    estado: 'Activo', // texto legacy también "equivocado" a propósito.
    fecha_vencimiento: fechaOffset(-20), // vencido hace 20 días, más allá de la tolerancia
    dia_corte: 10,
    creditos: 0,
    activo: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'socio-sin-vencimiento',
    nombre: 'Cristian',
    apellido: 'Créditos',
    dni: '10000004',
    email: 'cristian@e2e.test',
    plan: ['CrossFit'], // plan de créditos -- no tiene fecha_vencimiento.
    estado: 'Vencido', // texto legacy que, sin el fix, lo mandaba a "vencido".
    fecha_vencimiento: null,
    dia_corte: null,
    creditos: 8,
    activo: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'socio-de-baja',
    nombre: 'Bruno',
    apellido: 'Baja',
    dni: '10000005',
    email: 'bruno@e2e.test',
    plan: ['Aparatos'],
    estado: 'Activo',
    fecha_vencimiento: fechaOffset(10),
    dia_corte: 10,
    creditos: 0,
    activo: false, // dado de baja -- no debe contar en ningún bucket de arriba.
    created_at: '2024-01-01T00:00:00.000Z',
  },
]

// Por testId (kpi-activos/kpi-vencidos/kpi-tolerancia), no por texto de la
// etiqueta -- "Cuotas Vencidas" (Home) vs "Cuota Vencida" (Socios) tienen
// distinto texto para el mismo concepto, y la tarjeta de Tolerancia ahora
// suma un subtítulo con el rango de días que rompería un match exacto.
async function leerKpi(page, testId) {
  const texto = await page.getByTestId(testId).locator('p.text-2xl').innerText()
  return Number(texto.trim())
}

test('Home y Socios muestran EXACTAMENTE los mismos números de Activos/Vencidos/Tolerancia', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: {
      socios: SOCIOS_MIXTOS,
      profiles: [],
      xp_events: [],
      disciplines: [],
      configuracion: [{ id: 1, dias_tolerancia: DIAS_TOLERANCIA, limite_cancelacion_minutos: 120, alias_cvu: null, titular_cuenta: null }],
      bookings: [],
      classes: [],
      routines: [],
      pagos_socio: [],
    },
  })

  // Home es la pantalla de aterrizaje tras el login.
  const homeActivos = await leerKpi(page, 'kpi-activos')
  const homeVencidas = await leerKpi(page, 'kpi-vencidos')
  const homeTolerancia = await leerKpi(page, 'kpi-tolerancia')

  // Valores esperados por el padrón armado arriba, con el criterio ÚNICO ya
  // fijado en socioMetrics.js (no el legacy `estado` de cada fixture).
  expect(homeActivos).toBe(2) // Ana (fecha futura) + Cristian (sin vencimiento, plan de créditos)
  expect(homeVencidas).toBe(1) // Vicky
  expect(homeTolerancia).toBe(1) // Tomás

  await irASocios(page)
  // Las tarjetas de KPI de Socios.jsx se renderizan ANTES de que termine el
  // fetch (arrancan en 0 mientras `loading` es true) -- hay que esperar a
  // que la tabla muestre datos reales antes de leer los números, si no se
  // lee el "0" transitorio en vez del valor final. El filtro por defecto de
  // la pantalla es "Activo", así que se espera por un socio que SÍ pase ese
  // filtro (Ana) -- "Vicky" (vencida) no aparecería en la tabla igual.
  await expect(page.getByRole('table').getByText('Ana Activa')).toBeVisible()

  const sociosActivos = await leerKpi(page, 'kpi-activos')
  const sociosVencidas = await leerKpi(page, 'kpi-vencidos')
  const sociosTolerancia = await leerKpi(page, 'kpi-tolerancia')

  expect(sociosActivos).toBe(homeActivos)
  expect(sociosVencidas).toBe(homeVencidas)
  expect(sociosTolerancia).toBe(homeTolerancia)
})
