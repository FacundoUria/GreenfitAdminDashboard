import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import {
  calcularNivel,
  calcularRacha,
  fetchAvataresYNiveles,
  fetchCreditosPorDisciplina,
  fetchHistorialAsistencias,
  fetchHistorialPagos,
  buscarSociosParaCheckin,
  otorgarCheckinMusculacion,
  buscarSociosClaseActiva,
  darPresenteClase,
  fetchActividadReciente,
  revertirXpEvento,
  CHECKIN_OTORGADO,
  CHECKIN_YA_REGISTRADO,
} from '../../utils/fichaSocioPwa'

const mockedFrom = supabase.from
const mockedRpc = supabase.rpc

function makeChain(result) {
  const chain = {}
  const self = () => chain
  ;['select', 'eq', 'in', 'is', 'order'].forEach((metodo) => {
    chain[metodo] = vi.fn(self)
  })
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

describe('calcularNivel (500 XP = 1 nivel -- mismo criterio que la PWA)', () => {
  it('nivel 1 con 0 XP', () => {
    expect(calcularNivel(0)).toBe(1)
  })
  it('sube de nivel cada 500 XP', () => {
    expect(calcularNivel(499)).toBe(1)
    expect(calcularNivel(500)).toBe(2)
    expect(calcularNivel(1000)).toBe(3)
  })
})

describe('calcularRacha (días consecutivos hacia atrás desde hoy)', () => {
  it('corta la racha apenas hay un hueco', () => {
    const hoy = new Date('2026-08-10T12:00:00')
    expect(calcularRacha(['2026-08-10', '2026-08-09', '2026-08-05'], hoy)).toBe(2)
  })
  it('0 si no hay ningún registro', () => {
    expect(calcularRacha([])).toBe(0)
  })
})

describe('fetchAvataresYNiveles (tabla principal -- avatar + badge de nivel en batch)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('mapea avatar_url y nivel calculado por DNI', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'profiles') {
        return makeChain({
          data: [{ id: 'u1', dni: '30111222', avatar_url: 'https://cdn/u1.jpg' }],
          error: null,
        })
      }
      if (tabla === 'xp_events') {
        return makeChain({ data: [{ user_id: 'u1', xp_amount: 700 }, { user_id: 'u1', xp_amount: 450 }], error: null })
      }
      return makeChain({ data: [], error: null })
    })

    const mapa = await fetchAvataresYNiveles(['30111222'])
    expect(mapa.get('30111222')).toEqual({ userId: 'u1', avatarUrl: 'https://cdn/u1.jpg', nivel: 3, totalXp: 1150 })
  })

  it('devuelve nivel null (vía badge oculto) si el socio no tiene ninguna fila de XP', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'profiles') {
        return makeChain({ data: [{ id: 'u2', dni: '30999888', avatar_url: null }], error: null })
      }
      return makeChain({ data: [], error: null })
    })

    const mapa = await fetchAvataresYNiveles(['30999888'])
    expect(mapa.get('30999888')).toEqual({ userId: 'u2', avatarUrl: null, nivel: 1, totalXp: 0 })
  })

  it('sin DNIs, no consulta Supabase y devuelve un mapa vacío', async () => {
    const mapa = await fetchAvataresYNiveles([])
    expect(mapa.size).toBe(0)
    expect(mockedFrom).not.toHaveBeenCalled()
  })
})

describe('fetchCreditosPorDisciplina (fix del bug de sincronización: fuente de verdad = user_credits real, no el pozo global socios.creditos)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('un socio con dos disciplinas de créditos (CrossFit + Boxeo) devuelve el balance real de CADA UNA por separado', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'profiles') {
        return makeChain({ data: [{ id: 'u1', dni: '20111222' }], error: null })
      }
      if (tabla === 'user_credits') {
        return makeChain({
          data: [
            { user_id: 'u1', remaining_credits: 6, created_at: '2026-08-07T10:00:00.000Z', discipline: { id: 'd-crossfit', name: 'CrossFit', kind: 'credits' } },
            { user_id: 'u1', remaining_credits: 0, created_at: '2026-08-06T10:00:00.000Z', discipline: { id: 'd-boxeo', name: 'Boxeo', kind: 'credits' } },
          ],
          error: null,
        })
      }
      throw new Error(`tabla inesperada: ${tabla}`)
    })

    const mapa = await fetchCreditosPorDisciplina(['20111222'])
    expect(mapa.get('20111222')).toEqual([
      { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6 },
      { disciplineId: 'd-boxeo', disciplineName: 'Boxeo', remainingCredits: 0 },
    ])
  })

  it('con más de una fila para la MISMA disciplina, gana la más reciente (created_at desc) -- user_credits es un ledger append-only', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'profiles') return makeChain({ data: [{ id: 'u1', dni: '20111222' }], error: null })
      if (tabla === 'user_credits') {
        return makeChain({
          data: [
            { user_id: 'u1', remaining_credits: 6, created_at: '2026-08-07T10:00:00.000Z', discipline: { id: 'd-crossfit', name: 'CrossFit', kind: 'credits' } },
            { user_id: 'u1', remaining_credits: 2, created_at: '2026-08-01T10:00:00.000Z', discipline: { id: 'd-crossfit', name: 'CrossFit', kind: 'credits' } },
          ],
          error: null,
        })
      }
      throw new Error(`tabla inesperada: ${tabla}`)
    })

    const mapa = await fetchCreditosPorDisciplina(['20111222'])
    expect(mapa.get('20111222')).toEqual([{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6 }])
  })

  it('ignora filas de disciplinas kind=membership (Aparatos) -- esta función es solo para créditos', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'profiles') return makeChain({ data: [{ id: 'u1', dni: '20111222' }], error: null })
      if (tabla === 'user_credits') {
        return makeChain({
          data: [{ user_id: 'u1', remaining_credits: null, created_at: '2026-08-07T10:00:00.000Z', discipline: { id: 'd-aparatos', name: 'Aparatos', kind: 'membership' } }],
          error: null,
        })
      }
      throw new Error(`tabla inesperada: ${tabla}`)
    })

    const mapa = await fetchCreditosPorDisciplina(['20111222'])
    expect(mapa.get('20111222')).toBeUndefined()
  })

  it('sin cuenta PWA para ese DNI, devuelve un mapa vacío sin consultar user_credits', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'profiles') return makeChain({ data: [], error: null })
      throw new Error(`no debería consultar ${tabla} sin ninguna cuenta PWA resuelta`)
    })

    const mapa = await fetchCreditosPorDisciplina(['99999999'])
    expect(mapa.size).toBe(0)
  })

  it('si user_credits todavía no existe, cae a mapa vacío en vez de romper', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'profiles') return makeChain({ data: [{ id: 'u1', dni: '20111222' }], error: null })
      if (tabla === 'user_credits') return makeChain({ data: null, error: { code: '42P01', message: 'no existe' } })
      throw new Error(`tabla inesperada: ${tabla}`)
    })

    expect((await fetchCreditosPorDisciplina(['20111222'])).size).toBe(0)
  })

  it('sin DNIs, no consulta Supabase y devuelve un mapa vacío', async () => {
    const mapa = await fetchCreditosPorDisciplina([])
    expect(mapa.size).toBe(0)
    expect(mockedFrom).not.toHaveBeenCalled()
  })
})

describe('fetchHistorialAsistencias (unifica Reservas de Clases + Check-in "¡Hoy entrené!")', () => {
  beforeEach(() => vi.clearAllMocks())

  it('mezcla clases reservadas (bookings.attended) y check-ins autoreportados (xp_events sin reference_id)', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'bookings') {
        return makeChain({
          data: [{ id: 'b1', booking_date: '2026-08-09', classes: { title: 'CrossFit', instructor: 'Seba' } }],
          error: null,
        })
      }
      if (tabla === 'xp_events') {
        return makeChain({ data: [{ id: 'e1', event_date: '2026-08-10' }], error: null })
      }
      return makeChain({ data: [], error: null })
    })

    const historial = await fetchHistorialAsistencias('u1')

    expect(historial).toHaveLength(2)
    // Más reciente primero: el check-in del 10 antes que la clase del 9.
    expect(historial[0]).toMatchObject({ fecha: '2026-08-10', tipo: 'Entrenamiento Libre: ¡Hoy entrené!' })
    expect(historial[1]).toMatchObject({ fecha: '2026-08-09', tipo: 'Clase: CrossFit', detalle: 'Prof. Seba' })
  })
})

describe('fetchHistorialPagos (cae a lista vacía si pagos_socio todavía no existe)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('devuelve [] si la tabla no está desplegada (42P01) en vez de romper', async () => {
    mockedFrom.mockReturnValue(makeChain({ data: null, error: { code: '42P01', message: 'no existe' } }))
    expect(await fetchHistorialPagos('u1')).toEqual([])
  })

  it('mapea los pagos reales cuando la tabla existe', async () => {
    mockedFrom.mockReturnValue(
      makeChain({
        data: [
          {
            id: 'p1',
            fecha: '2026-08-01',
            paquete: 'CrossFit',
            monto: 15000,
            metodo_pago: 'efectivo',
            periodo_desde: '2026-08-01',
            periodo_hasta: '2026-09-01',
            estado: 'pagado',
            origen: 'manual',
          },
        ],
        error: null,
      }),
    )
    const pagos = await fetchHistorialPagos('u1')
    expect(pagos).toEqual([
      {
        id: 'p1',
        fecha: '2026-08-01',
        paquete: 'CrossFit',
        monto: 15000,
        metodoPago: 'efectivo',
        periodoDesde: '2026-08-01',
        periodoHasta: '2026-09-01',
        estado: 'pagado',
        origen: 'manual',
      },
    ])
  })
})

describe('buscarSociosParaCheckin (Check-in Rápido -- buscador del modal)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('busca solo profiles con role=socio y mapea el resultado', async () => {
    const orMock = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue({
        data: [{ id: 'u1', full_name: 'Martina Ríos', dni: '30111222', avatar_url: null }],
        error: null,
      }),
    })
    mockedFrom.mockReturnValue({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ or: orMock }) }) })

    const resultados = await buscarSociosParaCheckin('Martina')
    expect(resultados).toEqual([{ userId: 'u1', nombre: 'Martina Ríos', dni: '30111222', avatarUrl: null }])
  })

  it('con búsqueda vacía, no consulta Supabase', async () => {
    expect(await buscarSociosParaCheckin('   ')).toEqual([])
    expect(mockedFrom).not.toHaveBeenCalled()
  })
})

describe('otorgarCheckinMusculacion (+100 XP de entreno libre, 1 vez por día)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('camino feliz: llama al RPC admin_otorgar_checkin_musculacion y devuelve "otorgado"', async () => {
    mockedRpc.mockResolvedValue({ data: 'xp-1', error: null })
    const resultado = await otorgarCheckinMusculacion('u1')
    expect(mockedRpc).toHaveBeenCalledWith('admin_otorgar_checkin_musculacion', { p_user_id: 'u1' })
    expect(resultado).toBe(CHECKIN_OTORGADO)
  })

  it('si ya tiene un check-in de Musculación hoy (23505), devuelve "ya_registrado_hoy" en vez de romper', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } })
    expect(await otorgarCheckinMusculacion('u1')).toBe(CHECKIN_YA_REGISTRADO)
  })

  it('otro error real sí se propaga', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } })
    await expect(otorgarCheckinMusculacion('u1')).rejects.toThrow('permission denied')
  })
})

describe('buscarSociosClaseActiva (sugerencias inteligentes del Check-in Rápido)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('trae los inscriptos de una clase EN CURSO ahora mismo', async () => {
    // Lunes 18:10 -- una clase de Lunes 18 a 19 está en curso.
    vi.setSystemTime(new Date('2026-08-10T18:10:00'))
    mockedFrom.mockImplementation((table) => {
      if (table === 'classes') {
        return makeChain({
          data: [
            {
              id: 'clase-1',
              title: 'CrossFit 18hs',
              start_time: '18:00:00',
              end_time: '19:00:00',
              days_of_week: [1],
              discipline: { name: 'CrossFit' },
            },
          ],
          error: null,
        })
      }
      if (table === 'bookings') {
        return makeChain({
          data: [
            {
              id: 'booking-1',
              user_id: 'u2',
              class_id: 'clase-1',
              attended: false,
              profiles: { full_name: 'Bruno Álvarez', dni: '30999888' },
            },
          ],
          error: null,
        })
      }
      throw new Error(`tabla inesperada en el test: ${table}`)
    })

    expect(await buscarSociosClaseActiva()).toEqual([
      {
        bookingId: 'booking-1',
        userId: 'u2',
        nombre: 'Bruno Álvarez',
        dni: '30999888',
        turno: 'CrossFit · 18:00 a 19:00',
        yaRegistrado: false,
      },
    ])
  })

  it('también incluye una clase que arranca dentro de los próximos 30 minutos', async () => {
    // 17:45 -- una clase de 18:00 arranca en 15 minutos, dentro de la ventana.
    vi.setSystemTime(new Date('2026-08-10T17:45:00'))
    mockedFrom.mockImplementation((table) => {
      if (table === 'classes') {
        return makeChain({
          data: [
            { id: 'clase-1', title: 'Boxeo', start_time: '18:00:00', end_time: '19:00:00', days_of_week: [1], discipline: { name: 'Boxeo' } },
          ],
          error: null,
        })
      }
      if (table === 'bookings') return makeChain({ data: [], error: null })
      throw new Error(`tabla inesperada en el test: ${table}`)
    })

    await buscarSociosClaseActiva()
    expect(mockedFrom).toHaveBeenCalledWith('bookings')
  })

  it('no trae nada si ninguna clase está en curso ni por arrancar (fuera de la ventana de 30 min)', async () => {
    vi.setSystemTime(new Date('2026-08-10T08:00:00'))
    mockedFrom.mockImplementation((table) => {
      if (table === 'classes') {
        return makeChain({
          data: [
            { id: 'clase-1', title: 'CrossFit', start_time: '18:00:00', end_time: '19:00:00', days_of_week: [1], discipline: { name: 'CrossFit' } },
          ],
          error: null,
        })
      }
      throw new Error(`no debería consultar ${table} sin ninguna clase activa`)
    })

    expect(await buscarSociosClaseActiva()).toEqual([])
  })

  it('ignora clases de otro día de la semana', async () => {
    vi.setSystemTime(new Date('2026-08-10T18:10:00')) // lunes
    mockedFrom.mockImplementation((table) => {
      if (table === 'classes') {
        return makeChain({
          data: [
            { id: 'clase-1', title: 'CrossFit', start_time: '18:00:00', end_time: '19:00:00', days_of_week: [2], discipline: { name: 'CrossFit' } }, // martes
          ],
          error: null,
        })
      }
      throw new Error(`no debería consultar ${table}`)
    })

    expect(await buscarSociosClaseActiva()).toEqual([])
  })

  it('un inscripto con attended=true ya viene marcado con yaRegistrado', async () => {
    vi.setSystemTime(new Date('2026-08-10T18:10:00'))
    mockedFrom.mockImplementation((table) => {
      if (table === 'classes') {
        return makeChain({
          data: [
            { id: 'clase-1', title: 'CrossFit', start_time: '18:00:00', end_time: '19:00:00', days_of_week: [1], discipline: { name: 'CrossFit' } },
          ],
          error: null,
        })
      }
      if (table === 'bookings') {
        return makeChain({
          data: [
            {
              id: 'booking-1',
              user_id: 'u2',
              class_id: 'clase-1',
              attended: true,
              profiles: { full_name: 'Bruno Álvarez', dni: '30999888' },
            },
          ],
          error: null,
        })
      }
      throw new Error(`tabla inesperada en el test: ${table}`)
    })

    const [item] = await buscarSociosClaseActiva()
    expect(item.yaRegistrado).toBe(true)
  })
})

describe('darPresenteClase (marca una reserva de clase como asistida -- dispara el trigger de XP)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('actualiza bookings.attended=true por id', async () => {
    const eqMock = vi.fn().mockResolvedValue({ error: null })
    mockedFrom.mockReturnValue({ update: vi.fn().mockReturnValue({ eq: eqMock }) })

    await darPresenteClase('booking-1')
    expect(mockedFrom).toHaveBeenCalledWith('bookings')
    expect(eqMock).toHaveBeenCalledWith('id', 'booking-1')
  })

  it('un error real se propaga', async () => {
    mockedFrom.mockReturnValue({ update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: { message: 'boom' } }) }) })
    await expect(darPresenteClase('booking-1')).rejects.toThrow('boom')
  })
})

describe('fetchActividadReciente (unifica Reservas, Check-ins de Musculación, Asistencias a clase y Reversiones)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('suma XP de dos disciplinas distintas el mismo día como dos eventos separados (doble turno legítimo)', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'bookings') {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) }),
          }),
        }
      }
      if (tabla === 'xp_events') {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: 'e1',
                      event_type: 'asistencia',
                      xp_amount: 100,
                      reference_id: 'booking-1',
                      created_at: '2026-08-10T09:00:00.000Z',
                      profiles: { full_name: 'Martina Ríos' },
                      disciplines: { name: 'CrossFit' },
                    },
                    {
                      id: 'e2',
                      event_type: 'asistencia',
                      xp_amount: 100,
                      reference_id: 'booking-2',
                      created_at: '2026-08-10T18:00:00.000Z',
                      profiles: { full_name: 'Martina Ríos' },
                      disciplines: { name: 'Boxeo' },
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      return { select: vi.fn() }
    })

    const items = await fetchActividadReciente()
    const deMartina = items.filter((i) => i.socioNombre === 'Martina Ríos')
    expect(deMartina).toHaveLength(2)
    expect(deMartina.map((i) => i.detalle)).toEqual([
      'Asistencia confirmada: Boxeo', // más reciente (18hs) primero
      'Asistencia confirmada: CrossFit',
    ])
    expect(deMartina.every((i) => i.xpAmount === 100 && !i.revertido)).toBe(true)
  })

  it('marca "revertido" un evento que ya tiene una fila de reversión asociada, y NO ofrece revertir la reversión en sí', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'bookings') {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) }),
          }),
        }
      }
      return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'e1',
                    event_type: 'asistencia',
                    xp_amount: 100,
                    reference_id: null,
                    created_at: '2026-08-10T09:00:00.000Z',
                    profiles: { full_name: 'Bruno Álvarez' },
                    disciplines: { name: 'Aparatos' },
                  },
                  {
                    id: 'e2',
                    event_type: 'reversion',
                    xp_amount: -100,
                    reference_id: 'e1',
                    created_at: '2026-08-10T10:00:00.000Z',
                    profiles: { full_name: 'Bruno Álvarez' },
                    disciplines: { name: 'Aparatos' },
                  },
                ],
                error: null,
              }),
            }),
          }),
        }),
      }
    })

    const items = await fetchActividadReciente()
    const checkin = items.find((i) => i.id === 'xp-e1')
    const reversion = items.find((i) => i.id === 'xp-e2')

    expect(checkin.revertido).toBe(true)
    expect(checkin.xpEventId).toBe('e1')
    expect(reversion.tipo).toBe('reversion')
    expect(reversion.xpEventId).toBeNull()
  })

  it('desambigua la FK a profiles en xp_events (user_id, no created_by) -- sin esto, PostgREST tira "Could not embed because more than one relationship was found for xp_events and profiles"', async () => {
    const selectXpEvents = vi.fn().mockReturnValue({
      in: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) }),
      }),
    })
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'bookings') {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) }),
          }),
        }
      }
      return { select: selectXpEvents }
    })

    await fetchActividadReciente()

    expect(selectXpEvents).toHaveBeenCalledWith(expect.stringContaining('profiles!xp_events_user_id_fkey'))
  })
})

describe('revertirXpEvento', () => {
  beforeEach(() => vi.clearAllMocks())

  it('llama al RPC admin_revertir_xp_evento con el id del evento', async () => {
    mockedRpc.mockResolvedValue({ data: 'rev-1', error: null })
    await revertirXpEvento('e1')
    expect(mockedRpc).toHaveBeenCalledWith('admin_revertir_xp_evento', { p_xp_event_id: 'e1' })
  })

  it('propaga el error si el servidor rechaza la reversión (ej: ya estaba revertido)', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { message: 'Este evento ya fue revertido anteriormente.' } })
    await expect(revertirXpEvento('e1')).rejects.toThrow('ya fue revertido')
  })
})
