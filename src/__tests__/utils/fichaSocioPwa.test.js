import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import {
  calcularNivel,
  calcularRacha,
  fetchAvataresYNiveles,
  fetchHistorialAsistencias,
  fetchHistorialPagos,
  buscarSociosParaCheckin,
  otorgarCheckinMusculacion,
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
