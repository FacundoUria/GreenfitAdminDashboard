import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
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

// Cadena de consulta genérica: cada método (.select/.in/.order/.eq) devuelve
// la misma cadena, que es awaitable y además tiene .range() -- Reportes.jsx
// pagina TODO con fetchTodasLasFilas()/fetchPorLotesDeIds() (socios,
// profiles y user_credits, cada una con su .order() fijo), y el catálogo de
// disciplinas se awaitea directo. Con fixtures chicos, una sola página
// alcanza. `error` opcional para simular que una consulta falla.
function makeChain(data, error = null) {
  const resultado = { data: error ? null : data, error }
  const chain = {}
  ;['select', 'in', 'order', 'eq'].forEach((metodo) => {
    chain[metodo] = vi.fn(() => chain)
  })
  chain.range = vi.fn().mockResolvedValue(resultado)
  chain.then = (resolve) => resolve(resultado)
  return chain
}

const DISCIPLINA_APARATOS_MOCK = { id: 'disc-aparatos', name: 'Aparatos', kind: 'membership', is_active: true }
const DISCIPLINA_CROSSFIT_MOCK = { id: 'disc-crossfit', name: 'CrossFit', kind: 'credits', is_active: true }
const DISCIPLINA_BOXEO_MOCK = { id: 'disc-boxeo', name: 'Boxeo', kind: 'credits', is_active: true }
const CATALOGO_MOCK = [DISCIPLINA_APARATOS_MOCK, DISCIPLINA_BOXEO_MOCK, DISCIPLINA_CROSSFIT_MOCK]

// `profiles`/`userCredits` opcionales -- BUG REAL #2 (Agustina Aguero, ver
// socioMetrics.js): estadoOperativoSocio() ya no confía en
// fecha_vencimiento sola para 'activo', necesita `aparatosVigenteReal`
// resuelto contra una fila real de user_credits. Los tests que representan
// un socio con Aparatos GENUINAMENTE vigente pasan esa fila acá; los que no
// la pasan están representando a propósito "sin nada real detrás".
// `disciplinas` = catálogo (tabla disciplines); `errores` = tabla -> error.
function mockSupabaseTables(socios, { profiles = [], userCredits = [], disciplinas = CATALOGO_MOCK, errores = {} } = {}) {
  const porTabla = { socios, profiles, user_credits: userCredits, disciplines: disciplinas }
  mockedFrom.mockImplementation((tabla) => makeChain(porTabla[tabla] ?? [], errores[tabla] ?? null))
}

// Número grande del héroe "Socios Activos".
const sociosActivos = () => screen.getByTestId('reportes-socios-activos')

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
    await screen.findByText('Socios Activos')
    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^1$/)) // solo el normal -- el dado de baja queda afuera

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

    await screen.findByText('Socios Activos')
    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^1$/))
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

    await screen.findByText('Socios Activos')
    expect(sociosActivos()).toHaveTextContent(/^0$/)
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
    await screen.findByText('Socios Activos')
    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^0$/))
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

// ============================================================
// Rediseño (héroe + barra + tarjetas por disciplina + tabla) y fixes de datos
// ============================================================

const socio = (id, nombre, apellido, dni, extra = {}) => ({
  id,
  nombre,
  apellido,
  dni,
  activo: true,
  estado: 'Activo',
  fecha_vencimiento: null,
  created_at: ALTA_ANTIGUA,
  ...extra,
})
const perfil = (dni) => ({ id: `profile-${dni}`, dni })
const creditos = (dni, disciplina, cantidad, vence = `${VENCIMIENTO_FUTURO}T12:00:00.000Z`) => ({
  id: `uc-${dni}-${disciplina.id}`,
  user_id: `profile-${dni}`,
  remaining_credits: cantidad,
  expires_at: vence,
  discipline: disciplina,
})
const membresia = (dni, disciplina = DISCIPLINA_APARATOS_MOCK, vence = `${VENCIMIENTO_FUTURO}T12:00:00.000Z`) => ({
  id: `uc-${dni}-${disciplina.id}`,
  user_id: `profile-${dni}`,
  remaining_credits: null,
  expires_at: vence,
  discipline: disciplina,
})

// Martina: solo Aparatos. Ana: CrossFit + Aparatos (cuenta en las dos).
// Beto: Boxeo. Lucía: sin cuenta en la app, cobrada por mostrador (activa por
// fecha_vencimiento). Bruno: dado de baja CON créditos vigentes de CrossFit.
// Carla: cuenta en la app, créditos de Boxeo ya vencidos (no está activa).
const MARTINA = socio('s1', 'Martina', 'Ríos', '30111222', { fecha_vencimiento: VENCIMIENTO_FUTURO })
const ANA = socio('s2', 'Ana', 'Gómez', '31000111')
const BETO = socio('s3', 'Beto', 'Luna', '32000222')
const LUCIA = socio('s4', 'Lucía', 'Paz', '33000333', { fecha_vencimiento: VENCIMIENTO_FUTURO, plan: ['Pase Libre'] })
const BRUNO_BAJA = socio('s5', 'Bruno', 'Álvarez', '34000444', { activo: false })
const CARLA_VENCIDA = socio('s6', 'Carla', 'Sosa', '35000555')

function mockGimnasio(opciones = {}) {
  mockSupabaseTables([MARTINA, ANA, BETO, LUCIA, BRUNO_BAJA, CARLA_VENCIDA], {
    // Lucía NO tiene perfil: nunca se registró en la app.
    profiles: [MARTINA, ANA, BETO, BRUNO_BAJA, CARLA_VENCIDA].map((s) => perfil(s.dni)),
    userCredits: [
      membresia(MARTINA.dni),
      creditos(ANA.dni, DISCIPLINA_CROSSFIT_MOCK, 5),
      membresia(ANA.dni),
      creditos(BETO.dni, DISCIPLINA_BOXEO_MOCK, 2),
      creditos(BRUNO_BAJA.dni, DISCIPLINA_CROSSFIT_MOCK, 8),
      creditos(CARLA_VENCIDA.dni, DISCIPLINA_BOXEO_MOCK, 3, '2020-01-01T00:00:00.000Z'),
    ],
    ...opciones,
  })
}

const tarjeta = (id) => screen.getByTestId(`reportes-tarjeta-${id}`)
const tabla = () => within(screen.getByTestId('reportes-tabla'))

describe('Reportes -- héroe y desglose por disciplina', () => {
  beforeEach(() => vi.clearAllMocks())

  it('el héroe muestra los Socios Activos con el mismo criterio de siempre (excluye al dado de baja y al vencido)', async () => {
    mockGimnasio()
    render(<Reportes />)

    // Martina, Ana, Beto y Lucía. Bruno (baja) y Carla (vencida) no cuentan.
    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^4$/))
  })

  it('una tarjeta por disciplina: un socio con 2 disciplinas cuenta en las 2, y se aclara que la suma puede superar el total', async () => {
    mockGimnasio()
    render(<Reportes />)
    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^4$/))

    expect(tarjeta('disc-aparatos')).toHaveTextContent('Aparatos')
    expect(tarjeta('disc-aparatos')).toHaveTextContent('50%')
    expect(within(tarjeta('disc-aparatos')).getByText('2')).toBeInTheDocument() // Martina + Ana
    expect(within(tarjeta('disc-crossfit')).getByText('1')).toBeInTheDocument() // Ana (Bruno está de baja)
    expect(within(tarjeta('disc-boxeo')).getByText('1')).toBeInTheDocument() // Beto (Carla está vencida)

    // 2 + 1 + 1 + 1 (sin disciplina) = 5 tarjetas-socio para 4 activos.
    expect(screen.getByText(/la suma de las tarjetas puede superar el total de\s+Socios Activos/)).toBeInTheDocument()
  })

  it('los socios sin cuenta en la app (activos por fecha) van a "Sin disciplina registrada", no a Aparatos', async () => {
    mockGimnasio()
    render(<Reportes />)
    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^4$/))

    expect(tarjeta('sin-disciplina')).toHaveTextContent('Sin disciplina registrada')
    expect(within(tarjeta('sin-disciplina')).getByText('1')).toBeInTheDocument()

    fireEvent.click(tarjeta('sin-disciplina'))
    expect(tabla().getByText('Lucía Paz')).toBeInTheDocument()
    expect(tabla().getByText('33000333')).toBeInTheDocument()

    // Dato secundario: el plan administrativo de socios.plan, con la aclaración.
    expect(tabla().getByText('Aparatos — sin cuenta en la app')).toBeInTheDocument()
    expect(screen.getByTestId('reportes-nota-plan')).toHaveTextContent(/plan administrativo cargado en el panel: no está verificado contra créditos reales/)

    // Y NO aparece en Aparatos.
    // (ni el plan ni la aclaración se muestran en una disciplina real)
    fireEvent.click(tarjeta('disc-aparatos'))
    expect(tabla().queryByText('Lucía Paz')).toBeNull()
    expect(screen.queryByTestId('reportes-nota-plan')).toBeNull()
    expect(tabla().queryByText(/sin cuenta en la app/)).toBeNull()
  })

  it('sin socios de mostrador, la categoría "Sin disciplina registrada" no aparece', async () => {
    mockSupabaseTables([MARTINA], { profiles: [perfil(MARTINA.dni)], userCredits: [membresia(MARTINA.dni)] })
    render(<Reportes />)
    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^1$/))
    expect(screen.queryByTestId('reportes-tarjeta-sin-disciplina')).toBeNull()
  })

  it('las tarjetas salen del CATÁLOGO real: aparece una disciplina nueva (aunque tenga 0) y no una desactivada sin socios', async () => {
    mockGimnasio({
      disciplinas: [
        ...CATALOGO_MOCK,
        { id: 'disc-yoga', name: 'Yoga', kind: 'credits', is_active: true }, // no está en ninguna lista fija
        { id: 'disc-vieja', name: 'Spinning', kind: 'credits', is_active: false },
      ],
    })
    render(<Reportes />)
    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^4$/))

    expect(tarjeta('disc-yoga')).toHaveTextContent('Yoga')
    expect(within(tarjeta('disc-yoga')).getByText('0')).toBeInTheDocument()
    expect(screen.queryByTestId('reportes-tarjeta-disc-vieja')).toBeNull()

    fireEvent.click(tarjeta('disc-yoga'))
    expect(tabla().getByText('Ningún socio activo en esta disciplina.')).toBeInTheDocument()
  })

  it('la tabla muestra SOLO nombre y DNI (sin Plan ni Estado) de la disciplina elegida', async () => {
    mockGimnasio()
    render(<Reportes />)
    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^4$/))

    // Arranca en la disciplina con más socios (Aparatos).
    expect(tabla().getByText('Aparatos')).toBeInTheDocument()
    expect(tabla().getByText('2 socios')).toBeInTheDocument()
    expect(tabla().getByText('Ana Gómez')).toBeInTheDocument()
    expect(tabla().getByText('Martina Ríos')).toBeInTheDocument()
    expect(tabla().getByText('30111222')).toBeInTheDocument()

    const encabezados = tabla().getAllByRole('columnheader').map((th) => th.textContent)
    expect(encabezados).toEqual(['Socio', 'DNI'])
    expect(tabla().queryByText('Plan')).toBeNull()
    expect(tabla().queryByText('Estado')).toBeNull()
    expect(tabla().queryByText(/Al día|Activo/)).toBeNull()
  })

  it('tocar otra disciplina cambia la lista; el dado de baja no aparece aunque tenga créditos vigentes', async () => {
    mockGimnasio()
    render(<Reportes />)
    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^4$/))

    fireEvent.click(tarjeta('disc-crossfit'))
    expect(tarjeta('disc-crossfit')).toHaveAttribute('aria-pressed', 'true')
    expect(tabla().getByText('1 socio')).toBeInTheDocument()
    expect(tabla().getByText('Ana Gómez')).toBeInTheDocument()
    expect(tabla().queryByText('Bruno Álvarez')).toBeNull() // dado de baja, con 8 créditos vigentes
    expect(tabla().queryByText('Martina Ríos')).toBeNull()

    fireEvent.click(tarjeta('disc-boxeo'))
    expect(tabla().getByText('Beto Luna')).toBeInTheDocument()
    expect(tabla().queryByText('Carla Sosa')).toBeNull() // créditos vencidos
  })
})

describe('Reportes -- fixes de datos', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pagina la tabla socios con orden fijo: con 1200 socios cuenta los 1200 (antes se cortaba en 1000 en silencio)', async () => {
    const muchos = Array.from({ length: 1200 }, (_, i) =>
      socio(`m${String(i).padStart(4, '0')}`, 'Socio', `Nº${i}`, String(40000000 + i), { fecha_vencimiento: VENCIMIENTO_FUTURO }),
    )
    // Cadena de `socios` que pagina de verdad: .range(desde, hasta) corta el arreglo.
    const cadenaSocios = makeChain(muchos)
    cadenaSocios.range = vi.fn((desde, hasta) => Promise.resolve({ data: muchos.slice(desde, hasta + 1), error: null }))
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'socios') return cadenaSocios
      if (tabla === 'disciplines') return makeChain(CATALOGO_MOCK)
      return makeChain([])
    })
    render(<Reportes />)

    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^1200$/))
    expect(cadenaSocios.order).toHaveBeenCalledWith('id', { ascending: true })
    expect(cadenaSocios.range.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
    ])
  })

  it('si falla la consulta de créditos, AVISA con "Reintentar" y no muestra ningún número (antes: todos inactivos en silencio)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGimnasio({ errores: { user_credits: { message: 'URI too long' } } })
    render(<Reportes />)

    expect(await screen.findByText(/No se pudieron cargar todos los datos de los socios/)).toBeInTheDocument()
    expect(screen.getByText('Reintentar')).toBeInTheDocument()
    expect(screen.queryByTestId('reportes-socios-activos')).toBeNull()
    expect(screen.queryByText('Socios Activos')).toBeNull()
    console.error.mockRestore()
  })

  it('si falla la consulta de socios o la del catálogo, también avisa; "Reintentar" vuelve a cargar', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGimnasio({ errores: { disciplines: { message: 'boom' } } })
    render(<Reportes />)
    expect(await screen.findByText(/No se pudieron cargar todos los datos de los socios/)).toBeInTheDocument()

    mockGimnasio() // la conexión volvió
    fireEvent.click(screen.getByText('Reintentar'))
    await waitFor(() => expect(sociosActivos()).toHaveTextContent(/^4$/))
    console.error.mockRestore()
  })
})
