import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import {
  calcularNivel,
  calcularRacha,
  fetchAvataresYNiveles,
  fetchHistorialAsistencias,
  fetchHistorialPagos,
} from '../../utils/fichaSocioPwa'

const mockedFrom = supabase.from

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
