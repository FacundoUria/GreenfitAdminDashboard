import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Check-in rápido: una clase de una sola vez solo sugiere inscriptos el día de
// SU fecha, no todas las semanas de ese día.

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import { buscarSociosClaseActiva } from '../../utils/fichaSocioPwa'

function makeChain(result) {
  const chain = {}
  const self = () => chain
  ;['select', 'eq', 'in', 'order', 'gte', 'lte', 'is'].forEach((m) => {
    chain[m] = vi.fn(self)
  })
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const clase = (fechaUnica) => ({
  id: 'clase-1',
  title: 'Especial',
  start_time: '18:00:00',
  end_time: '19:00:00',
  days_of_week: [1],
  fecha_unica: fechaUnica,
  discipline_id: 'd1',
  discipline: { name: 'CrossFit' },
})

function mockear(filaClase) {
  supabase.from.mockImplementation((tabla) => {
    if (tabla === 'classes') return makeChain({ data: [filaClase], error: null })
    if (tabla === 'bookings') {
      return makeChain({
        data: [{ id: 'b1', user_id: 'u1', class_id: 'clase-1', attended: false, profiles: { full_name: 'Ana', dni: '1' } }],
        error: null,
      })
    }
    throw new Error(`tabla inesperada: ${tabla}`)
  })
  supabase.rpc.mockResolvedValue({ data: true, error: null })
}

describe('buscarSociosClaseActiva -- clases de una sola vez', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Lunes 10/08/2026 18:10 en Argentina.
    vi.setSystemTime(new Date('2026-08-10T18:10:00-03:00'))
  })
  afterEach(() => vi.useRealTimers())

  it('en su fecha la clase está activa y sugiere a sus inscriptos', async () => {
    mockear(clase('2026-08-10'))
    const res = await buscarSociosClaseActiva()
    expect(res.map((r) => r.bookingId)).toEqual(['b1'])
  })

  it('otro lunes (la de una sola vez era la semana pasada) no sugiere nada', async () => {
    mockear(clase('2026-08-03'))
    expect(await buscarSociosClaseActiva()).toEqual([])
    expect(supabase.from).not.toHaveBeenCalledWith('bookings')
  })

  it('pide la columna fecha_unica', async () => {
    mockear(clase(null))
    await buscarSociosClaseActiva()
    const chain = supabase.from.mock.results[0].value
    expect(chain.select.mock.calls[0][0]).toContain('fecha_unica')
  })
})
