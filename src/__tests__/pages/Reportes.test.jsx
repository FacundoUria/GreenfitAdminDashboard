import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import Reportes from '../../pages/Reportes'

// Bug real (auditoría de Reportes): los KPIs y el gráfico "Socios Activos
// (mensual)" llamaban a calcularEstadoCuota() directo, que no sabe nada de
// `socio.activo` -- un socio dado de baja con fecha_vencimiento todavía
// futura contaba como "Activo" acá, mientras Home.jsx/Socios.jsx (ya
// unificados con estadoOperativoSocio()/getSocioMetrics()) lo excluían
// correctamente. Fix: mismo criterio en los 3 lugares.

vi.mock('../../context/useConfiguracion', () => ({
  useConfiguracion: () => ({ configuracion: { dias_tolerancia: 5 } }),
}))

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

function makeChain(socios) {
  return { select: vi.fn().mockResolvedValue({ data: socios, error: null }) }
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

  it('un socio dado de baja con fecha_vencimiento futura NO cuenta como "Socios Activos", ni como Vencida ni Tolerancia', async () => {
    mockedFrom.mockReturnValue(makeChain([SOCIO_ACTIVO_NORMAL, SOCIO_BAJA_VENCIMIENTO_FUTURO]))
    render(<Reportes />)

    const activos = await screen.findByText('Socios Activos')
    expect(activos.nextElementSibling).toHaveTextContent('1') // solo el normal -- el dado de baja queda afuera

    expect(screen.getByText('Cuota Vencida').nextElementSibling).toHaveTextContent('0')
    expect(screen.getByText('En Tolerancia').nextElementSibling).toHaveTextContent('0')
  })

  it('el gráfico "Socios Activos (mensual)" tampoco cuenta al dado de baja en NINGÚN mes del rango', async () => {
    mockedFrom.mockReturnValue(makeChain([SOCIO_ACTIVO_NORMAL, SOCIO_BAJA_VENCIMIENTO_FUTURO]))
    render(<Reportes />)

    // El primer <LineChart> renderizado es "Socios Activos (mensual)" --
    // "Socios Nuevos (mensual)" es el segundo.
    const [chartSociosActivos] = await screen.findAllByTestId('line-chart')
    const data = JSON.parse(chartSociosActivos.getAttribute('data-chart'))

    expect(data.length).toBeGreaterThan(0)
    expect(data.every((punto) => punto.valor === 1)).toBe(true)
  })

  it('un socio activo normal (sin baja) sigue contando en "Socios Activos" -- sin cambios', async () => {
    mockedFrom.mockReturnValue(makeChain([SOCIO_ACTIVO_NORMAL]))
    render(<Reportes />)

    const activos = await screen.findByText('Socios Activos')
    expect(activos.nextElementSibling).toHaveTextContent('1')
  })

  it('regresión -- "Nuevos del mes" sigue contando altas de este mes sin importar activo/baja (no se tocó ese criterio)', async () => {
    const hoy = new Date()
    const creadoEsteMes = new Date(hoy.getFullYear(), hoy.getMonth(), 5).toISOString()
    const socioBajaNuevo = { ...SOCIO_BAJA_VENCIMIENTO_FUTURO, id: 's3', created_at: creadoEsteMes }

    mockedFrom.mockReturnValue(makeChain([socioBajaNuevo]))
    render(<Reportes />)

    const nuevos = await screen.findByText('Nuevos del mes')
    expect(nuevos.nextElementSibling).toHaveTextContent('1')
  })

  it('regresión -- "Altas de Socios por Día de la Semana" sigue contando sin importar activo/baja (no se tocó ese criterio)', async () => {
    const hoy = new Date()
    const creadoEsteMes = new Date(hoy.getFullYear(), hoy.getMonth(), 5).toISOString()
    const socioBajaNuevo = { ...SOCIO_BAJA_VENCIMIENTO_FUTURO, id: 's3', created_at: creadoEsteMes }

    mockedFrom.mockReturnValue(makeChain([socioBajaNuevo]))
    render(<Reportes />)

    const barChart = await screen.findByTestId('bar-chart')
    const data = JSON.parse(barChart.getAttribute('data-chart'))
    const total = data.reduce((suma, dia) => suma + dia.valor, 0)
    expect(total).toBe(1)
  })
})
