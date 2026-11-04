import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Tanda A -- "Socios activos" daba distinto en Reportes y en Socios (1 de
// diferencia). Las tres pantallas ya usaban estadoOperativoSocio(), pero
// Socios y Home traían `socios` SIN paginar: Supabase corta cada respuesta en
// 1000 filas y en producción hay 1016 socios. Un socio activo de los 16 que
// quedaban afuera contaba en Reportes (que sí paginaba) y no en Socios.
//
// Este test arma una "base" de 1016 socios con el MISMO tope de 1000 filas
// por respuesta que Supabase, y exige que Home, Socios y Reportes muestren
// exactamente el mismo número de activos -- y que sea el correcto.

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  LineChart: ({ children }) => <div>{children}</div>,
  BarChart: ({ children }) => <div>{children}</div>,
  CartesianGrid: () => null,
  Line: () => null,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}))

// La tabla real con 1016 filas no aporta nada acá: solo importa CUÁNTOS
// socios recibe.
vi.mock('../../components/SociosTabla', () => ({
  default: ({ socios }) => <div data-testid="tabla-socios" data-filas={socios.length} />,
}))
vi.mock('../../components/ActividadReciente', () => ({ default: () => null }))
vi.mock('../../context/useAuth', () => ({ useAuth: () => ({ usuario: { id: 'admin-1', nombre: 'Seba' } }) }))

const { base, TOPE_SUPABASE } = vi.hoisted(() => ({ base: { tablas: {}, fallas: {}, compuerta: null }, TOPE_SUPABASE: 1000 }))

vi.mock('../../lib/supabaseClient', () => {
  const crearChain = (tabla) => {
    const q = { in: null }
    const chain = {}
    for (const metodo of ['select', 'eq', 'order', 'contains', 'gte', 'lte', 'is', 'limit', 'ilike', 'or', 'neq']) {
      chain[metodo] = () => chain
    }
    chain.in = (columna, valores) => ((q.in = { columna, valores: new Set(valores) }), chain)
    const responder = async (desde, hasta) => {
      if (base.compuerta && tabla === 'user_credits') await base.compuerta
      if (base.fallas[tabla]) return { data: null, error: { message: base.fallas[tabla] } }
      let filas = base.tablas[tabla] ?? []
      if (q.in) filas = filas.filter((f) => q.in.valores.has(f[q.in.columna]))
      // Igual que Supabase: nunca más de 1000 filas por respuesta.
      return { data: filas.slice(desde, Math.min(hasta, desde + TOPE_SUPABASE - 1) + 1), error: null }
    }
    chain.range = (desde, hasta) => responder(desde, hasta)
    // Consulta sin .range(): Supabase devuelve las primeras 1000, en silencio.
    chain.then = (resolve, reject) => responder(0, TOPE_SUPABASE - 1).then(resolve, reject)
    return chain
  }
  return {
    supabase: {
      from: (tabla) => crearChain(tabla),
      rpc: () => Promise.resolve({ data: [], error: null }),
    },
  }
})

import Home from '../../pages/Home'
import Socios from '../../pages/Socios'
import Reportes from '../../pages/Reportes'

const FUTURO = '2099-01-01'
const PASADO = '2020-01-01'
const ALTA = '2020-01-01T00:00:00.000Z'
const CROSSFIT = { id: 'd-cf', name: 'CrossFit', kind: 'credits', is_active: true }
const APARATOS = { id: 'd-ap', name: 'Aparatos', kind: 'membership', is_active: true }

// 1016 socios. Tipos (por i % 5): 0 créditos vigentes, 1 Aparatos vigente,
// 2 cuenta en la app con fecha "fantasma" futura y nada real, 3 sin cuenta y
// fecha futura (mostrador), 4 sin cuenta y fecha pasada (vencido). Cada 50,
// uno dado de baja (aunque tenga créditos). Los 16 que quedan después de la
// fila 1000 son todos inactivos MENOS el último (Zoe, Aparatos vigente): el
// caso exacto de "difiere en 1".
const TOTAL = 1016
function armarBase() {
  const socios = []
  const profiles = []
  const userCredits = []
  const xpEvents = []
  let activosEsperados = 0
  let vencidosEsperados = 0

  for (let i = 0; i < TOTAL; i += 1) {
    const dni = String(20000000 + i)
    const esZoe = i === TOTAL - 1
    let tipo = i % 5
    if (i >= TOPE_SUPABASE) tipo = esZoe ? 1 : 2
    const baja = !esZoe && i % 50 === 0
    const conCuenta = tipo <= 2
    const userId = `u-${dni}`

    socios.push({
      id: i + 1,
      nombre: esZoe ? 'Zoe' : `Socio ${String(i).padStart(4, '0')}`,
      apellido: esZoe ? 'Última' : 'Prueba',
      dni,
      activo: !baja,
      plan: [],
      creditos: 0,
      fecha_vencimiento: tipo === 2 || tipo === 3 ? FUTURO : tipo === 4 ? PASADO : null,
      created_at: ALTA,
    })
    if (conCuenta) profiles.push({ id: userId, dni, avatar_url: null })
    if (tipo === 0) userCredits.push({ id: `c-${i}`, user_id: userId, remaining_credits: 4, expires_at: `${FUTURO}T12:00:00.000Z`, discipline: CROSSFIT })
    if (tipo === 1) userCredits.push({ id: `m-${i}`, user_id: userId, remaining_credits: null, expires_at: `${FUTURO}T12:00:00.000Z`, discipline: APARATOS })
    if (conCuenta) xpEvents.push({ id: `xp-${i}`, user_id: userId, xp_amount: 50 })

    // Cuenta esperada, escrita aparte (no usa el código de la app).
    if (!baja && (tipo === 0 || tipo === 1 || tipo === 3)) activosEsperados += 1
    if (!baja && tipo === 4) vencidosEsperados += 1
  }

  base.tablas = {
    socios,
    profiles,
    user_credits: userCredits,
    xp_events: xpEvents,
    disciplines: [APARATOS, CROSSFIT],
    classes: [],
    bookings: [],
  }
  return { activosEsperados, vencidosEsperados }
}

const renderEn = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>)
const valorKpi = (testId) => within(screen.getByTestId(testId)).getByText(/^\d+$/).textContent

async function activosEnHome() {
  renderEn(<Home />)
  await waitFor(() => expect(screen.getByTestId('kpi-activos')).toBeInTheDocument(), { timeout: 10000 })
  const resultado = { activos: valorKpi('kpi-activos'), vencidos: valorKpi('kpi-vencidos') }
  cleanup()
  return resultado
}

async function activosEnSocios() {
  renderEn(<Socios />)
  await waitFor(() => expect(screen.getByTestId('tabla-socios')).toBeInTheDocument(), { timeout: 10000 })
  const resultado = { activos: valorKpi('kpi-activos'), filas: screen.getByTestId('tabla-socios').dataset.filas }
  cleanup()
  return resultado
}

async function activosEnReportes() {
  renderEn(<Reportes />)
  await waitFor(() => expect(screen.getByTestId('reportes-socios-activos')).toBeInTheDocument(), { timeout: 10000 })
  const resultado = {
    activos: screen.getByTestId('reportes-socios-activos').textContent,
    vencidos: screen.getByText('Cuota Vencida').nextElementSibling.textContent,
  }
  cleanup()
  return resultado
}

beforeEach(() => {
  base.fallas = {}
  base.compuerta = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  console.error.mockRestore()
})

describe('"Socios activos" -- Home, Socios y Reportes dan el MISMO número (1016 socios, tope de 1000)', () => {
  it('las tres pantallas coinciden entre sí y con la cuenta esperada (Zoe, la fila 1016, incluida)', async () => {
    const { activosEsperados, vencidosEsperados } = armarBase()

    const home = await activosEnHome()
    const socios = await activosEnSocios()
    const reportes = await activosEnReportes()

    expect(home.activos).toBe(String(activosEsperados))
    expect(socios.activos).toBe(String(activosEsperados))
    expect(reportes.activos).toBe(String(activosEsperados))
    // "Cuotas vencidas" de Home y "Cuota Vencida" de Reportes, también.
    expect(home.vencidos).toBe(String(vencidosEsperados))
    expect(reportes.vencidos).toBe(String(vencidosEsperados))
    // La tabla de Socios recibe los 1016, no 1000.
    expect(socios.filas).toBe(String(TOTAL))
  }, 30000)

  it('sin Zoe (activa, fila 1016) el número baja en 1 en las TRES pantallas por igual', async () => {
    const { activosEsperados } = armarBase()
    base.tablas.user_credits = base.tablas.user_credits.filter((f) => f.user_id !== `u-${20000000 + TOTAL - 1}`)

    const valores = [(await activosEnHome()).activos, (await activosEnSocios()).activos, (await activosEnReportes()).activos]
    expect(valores).toEqual(Array(3).fill(String(activosEsperados - 1)))
  }, 30000)
})

describe('Socios y Home -- nunca un número parcial', () => {
  it('Socios: mientras no llegaron créditos/Aparatos, los KPIs dicen "Cargando…" y no hay tabla; después, el número final', async () => {
    const { activosEsperados } = armarBase()
    let liberar
    base.compuerta = new Promise((resolve) => (liberar = resolve))

    renderEn(<Socios />)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(within(screen.getByTestId('kpi-activos')).getByText('Cargando…')).toBeInTheDocument()
    expect(within(screen.getByTestId('kpi-activos')).queryByText(/^\d+$/)).toBeNull()
    expect(screen.queryByTestId('tabla-socios')).toBeNull()

    liberar()
    await waitFor(() => expect(screen.getByTestId('tabla-socios')).toBeInTheDocument(), { timeout: 10000 })
    expect(valorKpi('kpi-activos')).toBe(String(activosEsperados))
  }, 30000)

  it('Home: mientras no llegaron créditos/Aparatos no se muestra ningún KPI', async () => {
    armarBase()
    let liberar
    base.compuerta = new Promise((resolve) => (liberar = resolve))

    renderEn(<Home />)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.getByText('Cargando métricas...')).toBeInTheDocument()
    expect(screen.queryByTestId('kpi-activos')).toBeNull()

    liberar()
    await waitFor(() => expect(screen.getByTestId('kpi-activos')).toBeInTheDocument(), { timeout: 10000 })
  }, 30000)

  it.each([['user_credits'], ['profiles'], ['xp_events']])(
    'Socios: si falla %s, aviso en rojo y KPIs en "—" (nunca un número parcial)',
    async (tabla) => {
      armarBase()
      base.fallas[tabla] = 'timeout'

      renderEn(<Socios />)
      expect(await screen.findByText(/No se pudieron cargar los créditos, Aparatos o niveles de la app/, {}, { timeout: 10000 })).toBeInTheDocument()
      expect(screen.getByText('Reintentar')).toBeInTheDocument()
      expect(within(screen.getByTestId('kpi-activos')).getByText('—')).toBeInTheDocument()
      expect(screen.queryByTestId('tabla-socios')).toBeNull()
    },
    30000,
  )

  it.each([['user_credits'], ['profiles'], ['socios']])('Home: si falla %s, aviso en rojo y ningún KPI', async (tabla) => {
    armarBase()
    base.fallas[tabla] = 'timeout'

    renderEn(<Home />)
    expect(await screen.findByText(/No se pudieron cargar (todas )?las métricas/, {}, { timeout: 10000 })).toBeInTheDocument()
    expect(screen.getByText('Reintentar')).toBeInTheDocument()
    expect(screen.queryByTestId('kpi-activos')).toBeNull()
  }, 30000)
})
