import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import { buscarCuentaPwaPorDni, esperarCuentaPwa, fetchPendientesDeCargar, resolverUserIdPorDni } from '../../utils/fichaSocioPwa'

function profilesQueDevuelve(...resultados) {
  let i = 0
  supabase.from.mockImplementation((tabla) => {
    if (tabla !== 'profiles') throw new Error(`tabla inesperada: ${tabla}`)
    const resultado = resultados[Math.min(i, resultados.length - 1)]
    i += 1
    return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(resultado) }) }) }
  })
}

beforeEach(() => vi.clearAllMocks())

// R5 -- en el cobro, un error de red/RLS al buscar la cuenta NO se puede
// confundir con "no tiene cuenta" (cambia lo que se le dice a Seba).
describe('buscarCuentaPwaPorDni (T5, R5)', () => {
  it('con cuenta devuelve el id; sin cuenta, null', async () => {
    profilesQueDevuelve({ data: { id: 'user-1' }, error: null }, { data: null, error: null })
    expect(await buscarCuentaPwaPorDni('30111222')).toBe('user-1')
    expect(await buscarCuentaPwaPorDni('30111222')).toBeNull()
  })

  it('si la consulta falla, LANZA (la de siempre, resolverUserIdPorDni, lo tomaba como "sin cuenta")', async () => {
    profilesQueDevuelve({ data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } })
    await expect(buscarCuentaPwaPorDni('30111222')).rejects.toThrow('multiple (or no) rows returned')
    expect(await resolverUserIdPorDni('30111222')).toBeNull()
  })

  it('sin DNI no consulta nada', async () => {
    expect(await buscarCuentaPwaPorDni(null)).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('esperarCuentaPwa (T5, D-T5d)', () => {
  it('reintenta hasta que aparece la cuenta (la crea el trigger de forma asíncrona)', async () => {
    profilesQueDevuelve({ data: null, error: null }, { data: null, error: null }, { data: { id: 'user-tarde' }, error: null })
    expect(await esperarCuentaPwa('30111222', { intentos: 5, esperaMs: 1 })).toBe('user-tarde')
    expect(supabase.from).toHaveBeenCalledTimes(3)
  })

  it('si nunca aparece, null después de los intentos', async () => {
    profilesQueDevuelve({ data: null, error: null })
    expect(await esperarCuentaPwa('30111222', { intentos: 3, esperaMs: 1 })).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(3)
  })

  it('con la búsqueda estricta, un error corta los reintentos y se propaga', async () => {
    profilesQueDevuelve({ data: null, error: { message: 'Failed to fetch' } })
    await expect(esperarCuentaPwa('30111222', { intentos: 3, esperaMs: 1, buscar: buscarCuentaPwaPorDni })).rejects.toThrow('Failed to fetch')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })
})

describe('fetchPendientesDeCargar (T5)', () => {
  it('llama al RPC de solo lectura y mapea las filas', async () => {
    supabase.rpc.mockResolvedValue({
      data: [
        {
          socio_id: 153,
          nombre: 'Luna',
          apellido: 'Alvino',
          dni: '44986863',
          plan: ['CrossFit'],
          creditos_ficha: 8,
          fecha_vencimiento_ficha: '2026-12-02',
          ultimo_pago: '2026-11-02',
        },
      ],
      error: null,
    })
    const lista = await fetchPendientesDeCargar()
    expect(supabase.rpc).toHaveBeenCalledWith('admin_socios_pendientes_de_cargar')
    expect(lista).toEqual([
      {
        socioId: 153,
        nombre: 'Luna',
        apellido: 'Alvino',
        dni: '44986863',
        plan: ['CrossFit'],
        creditosFicha: 8,
        fechaVencimientoFicha: '2026-12-02',
        ultimoPago: '2026-11-02',
      },
    ])
  })

  it('R5: si el RPC falla, LANZA con el motivo (nunca una lista vacía en silencio)', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found in schema cache' } })
    await expect(fetchPendientesDeCargar()).rejects.toThrow('function not found in schema cache')
  })

  it('sin pendientes: lista vacía', async () => {
    supabase.rpc.mockResolvedValue({ data: [], error: null })
    expect(await fetchPendientesDeCargar()).toEqual([])
  })
})
