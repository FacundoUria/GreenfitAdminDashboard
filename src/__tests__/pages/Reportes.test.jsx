import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import Reportes from '../../pages/Reportes'

// Bug real (auditoría de Reportes): los KPIs y el gráfico "Socios Activos
// (mensual)" llamaban a calcularEstadoCuota() directo, que no sabe nada de
// `socio.activo` -- un socio dado de baja con fecha_vencimiento todavía
// futura contaba como "Activo" acá, mientras Home.jsx/Socios.jsx (ya
// unificados con estadoOperativoSocio()/getSocioMetrics()) lo excluían
// correctamente. Fix: mismo criterio en los 3 lugares.

// recharts necesita dimensiones reales del DOM (ResponsiveContainer) que
// jsdom no provee -- se mockea a algo simple que expone `data` como
// atributo inspeccionable, en vez de pelear contra el layout real del SVG.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  LineChart: ({ data, children }) => (
    <div data-testid="line-chart" data-chart={JSON.stringify(data)}>
      {children}
    </div>
  ),
  BarChart: ({ data, children }) => (
    <div data-testid="bar-chart" data-chart={JSON.stringify(data)}>
      {children}
    </div>
  ),
  CartesianGrid: () => null,
  Line: () => null,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}))

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'

const mockedFrom = supabase.from

// Thenable CON `.in()` -- Reportes.jsx hace `supabase.from('socios').select('*')`
// (awaited directo), pero desde CAMBIO 3 también llama a
// fetchCreditosPorDisciplina()/fetchAparatosVigentePorDni()
// (utils/fichaSocioPwa.js), que encadenan `.select(...).in(...)` sobre
// `profiles`/`user_credits`. Un solo objeto que sea awaitable Y tenga
// `.in()` (ambos resolviendo al mismo resultado) cubre los dos patrones sin
// duplicar el mock.
function makeChain(data) {
  const resultado = { data, error: null }
  return {
    select: vi.fn().mockReturnValue({
      then: (resolve) => resolve(resultado),
      // .range() incluido -- fetchCreditosPorDisciplina/
      // fetchAparatosVigentePorDni ahora paginan con fetchTodasLasFilas()
      // (bug Fernanda Isgro, DNI 38756811, 1220+ filas de user_credits en
      // producción), que siempre llama a .range() antes de awaitear. Con
      // `data` chico (todos los fixtures de este archivo), una sola vuelta
      // alcanza -- mismo comportamiento de siempre.
      in: vi.fn().mockReturnValue({
        then: (resolve) => resolve(resultado),
        range: vi.fn().mockResolvedValue(resultado),
      }),
    }),
  }
}

// `profiles`/`userCredits` opcionales -- BUG REAL #2 (Agustina Aguero, ver
// socioMetrics.js): estadoOperativoSocio() ya no confía en
// fecha_vencimiento sola para 'activo', necesita `aparatosVigenteReal`
// resuelto contra una fila real de user_credits. Los tests que representan
// un socio con Aparatos GENUINAMENTE vigente pasan esa fila acá; los que no
// la pasan están representando a propósito "sin nada real detrás".
function mockSupabaseTables(socios, { profiles = [], userCredits = [] } = {}) {
  mockedFrom.mockImplementation((tabla) => {
    if (tabla === 'socios') return makeChain(socios)
    if (tabla === 'profiles') return makeChain(profiles)
    if (tabla === 'user_credits') return makeChain(userCredits)
    return makeChain([])
  })
}

// Alta bien antigua -- cae dentro de CUALQUIER mes del rango por defecto (6
// meses) del gráfico "Socios Activos (mensual)", así el caso de prueba
// aparece en todos los puntos, no solo en el más reciente.
const ALTA_ANTIGUA = '2020-01-01T00:00:00.000Z'
// Vencimiento fijo bien a futuro -- siempre "activo" por fecha, sin importar
// cuándo corra el test (nada de fechas relativas a "hoy" acá).
const VENCIMIENTO_FUTURO = '2099-01-01'

const SOCIO_ACTIVO_NORMAL = {
  id: 's1',
  nombre: 'Martina',
  apellido: 'Ríos',
  dni: '30111222',
  activo: true,
  estado: 'Activo',
  fecha_vencimiento: VENCIMIENTO_FUTURO,
  created_at: ALTA_ANTIGUA,
}

// Fila real de Aparatos que respalda la fecha_vencimiento de Martina --
// sin esto, BUG REAL #2 la contaría "Inactivo" (fecha sin nada real
// detrás), exactamente el bug que motivó ese fix.
const PROFILE_ACTIVO_NORMAL = { id: 'profile-s1', dni: SOCIO_ACTIVO_NORMAL.dni }
const DISCIPLINA_APARATOS_MOCK = { id: 'disc-aparatos', name: 'Aparatos', kind: 'membership' }
const USER_CREDITS_ACTIVO_NORMAL = [
  {
    user_id: PROFILE_ACTIVO_NORMAL.id,
    discipline_id: DISCIPLINA_APARATOS_MOCK.id,
    remaining_credits: null,
    expires_at: `${VENCIMIENTO_FUTURO}T12:00:00.000Z`,
    discipline: DISCIPLINA_APARATOS_MOCK,
  },
]

// El caso del ticket: dado de baja, con fecha_vencimiento todavía futura --
// `estado` legacy también dice "Activo" a propósito (si algo cayera al
// fallback de texto libre en vez de al chequeo real de `activo`, seguiría
// contando mal igual).
const SOCIO_BAJA_VENCIMIENTO_FUTURO = {
  id: 's2',
  nombre: 'Bruno',
  apellido: 'Álvarez',
  dni: '30999888',
  activo: false,
  estado: 'Activo',
  fecha_vencimiento: VENCIMIENTO_FUTURO,
  created_at: ALTA_ANTIGUA,
}

describe('Reportes -- KPIs y "Socios Activos (mensual)" excluyen a los dados de baja (mismo criterio que Home/Socios)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('un socio dado de baja con fecha_vencimiento futura NO cuenta como "Socios Activos", ni como Cuota Vencida', async () => {
    mockSupabaseTables([SOCIO_ACTIVO_NORMAL, SOCIO_BAJA_VENCIMIENTO_FUTURO], {
      profiles: [PROFILE_ACTIVO_NORMAL],
      userCredits: USER_CREDITS_ACTIVO_NORMAL,
    })
    render(<Reportes />)

    // Créditos/Aparatos reales resuelven en un fetch APARTE, disparado
    // recién después de que `loading` ya bajó (ver Reportes.jsx) -- esperar
    // a que aparezca el texto "Socios Activos" no alcanza para que ese
    // segundo fetch haya asentado, `waitFor` reintenta hasta que sí.
    const activos = await screen.findByText('Socios Activos')
    await waitFor(() => expect(activos.nextElementSibling).toHaveTextContent('1')) // solo el normal -- el dado de baja queda afuera

    expect(screen.getByText('Cuota Vencida').nextElementSibling).toHaveTextContent('0')
  })

  // CAMBIO 1 -- la tarjeta "En Tolerancia" se sacó del todo.
  it('CAMBIO 1 -- ya no muestra ninguna tarjeta "En Tolerancia"', async () => {
    mockSupabaseTables([SOCIO_ACTIVO_NORMAL], {
      profiles: [PROFILE_ACTIVO_NORMAL],
      userCredits: USER_CREDITS_ACTIVO_NORMAL,
    })
    render(<Reportes />)

    await screen.findByText('Socios Activos')
    expect(screen.queryByText('En Tolerancia')).toBeNull()
  })

  it('el gráfico "Socios Activos (mensual)" tampoco cuenta al dado de baja en NINGÚN mes del rango', async () => {
    mockSupabaseTables([SOCIO_ACTIVO_NORMAL, SOCIO_BAJA_VENCIMIENTO_FUTURO], {
      profiles: [PROFILE_ACTIVO_NORMAL],
      userCredits: USER_CREDITS_ACTIVO_NORMAL,
    })
    render(<Reportes />)

    // El primer <LineChart> renderizado es "Socios Activos (mensual)" --
    // "Socios Nuevos (mensual)" es el segundo. Mismo motivo que arriba --
    // créditos/Aparatos reales resuelven después, `waitFor` reintenta hasta
    // que el gráfico ya está pintado con ese dato asentado.
    const [chartSociosActivos] = await screen.findAllByTestId('line-chart')
    await waitFor(() => {
      const data = JSON.parse(chartSociosActivos.getAttribute('data-chart'))
      expect(data.length).toBeGreaterThan(0)
      expect(data.every((punto) => punto.valor === 1)).toBe(true)
    })
  })

  it('un socio activo normal (sin baja) sigue contando en "Socios Activos" -- sin cambios', async () => {
    mockSupabaseTables([SOCIO_ACTIVO_NORMAL], {
      profiles: [PROFILE_ACTIVO_NORMAL],
      userCredits: USER_CREDITS_ACTIVO_NORMAL,
    })
    render(<Reportes />)

    const activos = await screen.findByText('Socios Activos')
    await waitFor(() => expect(activos.nextElementSibling).toHaveTextContent('1'))
  })

  // CAMBIO 3 (bug real: "Activo" sin nada real) -- un socio 100% créditos
  // (sin fecha_vencimiento) que ya gastó todo NO debe contar como "Socios
  // Activos" en Reportes, mismo criterio que Home/Socios.
  it('CAMBIO 3 -- socio de créditos sin fecha_vencimiento y sin ningún crédito real vigente NO cuenta como "Socios Activos"', async () => {
    const socioSinNadaReal = {
      id: 's4',
      nombre: 'Cristian',
      apellido: 'Créditos',
      dni: '30444555',
      activo: true,
      estado: 'Vencido',
      fecha_vencimiento: null,
      created_at: ALTA_ANTIGUA,
    }
    mockSupabaseTables([socioSinNadaReal])
    render(<Reportes />)

    const activos = await screen.findByText('Socios Activos')
    expect(activos.nextElementSibling).toHaveTextContent('0')
  })

  // BUG REAL #2, URGENTE (filtro "Activo" mostrando socios con badge
  // "Inactivo", caso real Agustina Aguero DNI 43418750) -- un socio con
  // fecha_vencimiento futura pero SIN ninguna fila real de Aparatos detrás
  // (fecha fantasma -- import de CrossFy, campo viejo ya eliminado) NO debe
  // contar como "Socios Activos" en Reportes tampoco.
  //
  // CON cuenta PWA a propósito (profile presente, sin user_credits) -- es
  // el caso REAL de Agustina: tiene cuenta en la app, simplemente sin
  // ninguna fila de Aparatos. Distinto de "sin cuenta PWA" (Lucía Paz, ver
  // registrar-pago-fechas.spec.js), donde fecha_vencimiento SÍ es la única
  // fuente de verdad posible y debe confiarse en ella completa.
  it('BUG REAL #2 -- socio CON cuenta PWA pero fecha_vencimiento futura SIN fila real de Aparatos NO cuenta como "Socios Activos" (caso Agustina Aguero)', async () => {
    const socioFantasma = {
      id: 's5',
      nombre: 'Agustina',
      apellido: 'Aguero',
      dni: '43418750',
      activo: true,
      estado: 'Activo',
      fecha_vencimiento: VENCIMIENTO_FUTURO, // fantasma -- sin fila real
      created_at: ALTA_ANTIGUA,
    }
    mockSupabaseTables([socioFantasma], {
      profiles: [{ id: 'profile-agustina', dni: '43418750' }],
      userCredits: [], // cuenta PWA confirmada, pero sin ninguna fila real
    })
    render(<Reportes />)

    // Con cuenta PWA confirmada, ANTES de que fetchAparatosVigentePorDni
    // resuelva, `aparatosVigenteReal` transitoriamente es `undefined` (el
    // Map todavía está vacío) -- mismo valor que "sin cuenta PWA", que
    // confía en la fecha completa. Sin `waitFor`, se podría leer un "1"
    // transitorio en vez del "0" final ya asentado.
    const activos = await screen.findByText('Socios Activos')
    await waitFor(() => expect(activos.nextElementSibling).toHaveTextContent('0'))
  })

  it('regresión -- "Nuevos del mes" sigue contando altas de este mes sin importar activo/baja (no se tocó ese criterio)', async () => {
    const hoy = new Date()
    const creadoEsteMes = new Date(hoy.getFullYear(), hoy.getMonth(), 5).toISOString()
    const socioBajaNuevo = { ...SOCIO_BAJA_VENCIMIENTO_FUTURO, id: 's3', created_at: creadoEsteMes }

    mockSupabaseTables([socioBajaNuevo])
    render(<Reportes />)

    const nuevos = await screen.findByText('Nuevos del mes')
    expect(nuevos.nextElementSibling).toHaveTextContent('1')
  })

  it('regresión -- "Altas de Socios por Día de la Semana" sigue contando sin importar activo/baja (no se tocó ese criterio)', async () => {
    const hoy = new Date()
    const creadoEsteMes = new Date(hoy.getFullYear(), hoy.getMonth(), 5).toISOString()
    const socioBajaNuevo = { ...SOCIO_BAJA_VENCIMIENTO_FUTURO, id: 's3', created_at: creadoEsteMes }

    mockSupabaseTables([socioBajaNuevo])
    render(<Reportes />)

    const barChart = await screen.findByTestId('bar-chart')
    const data = JSON.parse(barChart.getAttribute('data-chart'))
    const total = data.reduce((suma, dia) => suma + dia.valor, 0)
    expect(total).toBe(1)
  })
})
