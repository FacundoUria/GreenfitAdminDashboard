import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import { sincronizarVencimientoPwa } from '../../utils/creditosPwa'

const mockedFrom = supabase.from

function makeChain(result) {
  const chain = {}
  const self = () => chain
  ;['select', 'eq', 'ilike', 'limit', 'order', 'insert'].forEach((metodo) => {
    chain[metodo] = vi.fn(self)
  })
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

// Cubre el bug real: antes, sincronizarVencimientoPwa agarraba "la primera
// disciplina kind=membership que encontrara" sin importar el nombre del
// plan del socio -- funcionaba de pura casualidad porque hoy solo existe
// una. Ahora resuelve por NOMBRE del plan (igual que sincronizarCreditosPwa
// con los créditos), con el viejo comportamiento como fallback si el
// nombre no matchea ninguna fila real.
describe('sincronizarVencimientoPwa (resolución por nombre de plan, no "cualquier membership")', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resuelve la disciplina por el NOMBRE del plan cuando existe una fila que matchea', async () => {
    mockedFrom.mockImplementation((table) => {
      if (table === 'profiles') return makeChain({ data: { id: 'user-1' }, error: null })
      if (table === 'disciplines') return makeChain({ data: { id: 'disc-aparatos' }, error: null })
      if (table === 'user_credits') return makeChain({ error: null })
      throw new Error(`tabla inesperada en el test: ${table}`)
    })

    const resultado = await sincronizarVencimientoPwa({
      dni: '30111222',
      disciplina: 'Aparatos / Musculación',
      fechaVencimiento: '2026-09-01',
    })

    expect(resultado).toEqual({ synced: true })
  })

  it('si el nombre del plan no matchea ninguna disciplina (ej. "Pase Libre" legado), cae al fallback de "alguna membership"', async () => {
    let llamadasDisciplines = 0
    mockedFrom.mockImplementation((table) => {
      if (table === 'profiles') return makeChain({ data: { id: 'user-1' }, error: null })
      if (table === 'disciplines') {
        llamadasDisciplines += 1
        // 1ra llamada = resolverDisciplinaId por nombre (no matchea).
        // 2da llamada = fallback por kind=membership (sí matchea).
        return makeChain(
          llamadasDisciplines === 1 ? { data: null, error: null } : { data: { id: 'disc-aparatos' }, error: null },
        )
      }
      if (table === 'user_credits') return makeChain({ error: null })
      throw new Error(`tabla inesperada en el test: ${table}`)
    })

    const resultado = await sincronizarVencimientoPwa({
      dni: '30111222',
      disciplina: 'Pase Libre',
      fechaVencimiento: '2026-09-01',
    })

    expect(resultado).toEqual({ synced: true })
    expect(llamadasDisciplines).toBe(2)
  })

  it('si ni el nombre ni el fallback resuelven ninguna disciplina, no sincroniza', async () => {
    mockedFrom.mockImplementation((table) => {
      if (table === 'profiles') return makeChain({ data: { id: 'user-1' }, error: null })
      if (table === 'disciplines') return makeChain({ data: null, error: null })
      throw new Error(`tabla inesperada en el test: ${table}`)
    })

    const resultado = await sincronizarVencimientoPwa({
      dni: '30111222',
      disciplina: 'Yoga',
      fechaVencimiento: '2026-09-01',
    })

    expect(resultado).toEqual({ synced: false, reason: 'disciplina_no_encontrada' })
  })

  it('sin cuenta PWA vinculada al DNI, no intenta sincronizar nada más', async () => {
    mockedFrom.mockImplementation((table) => {
      if (table === 'profiles') return makeChain({ data: null, error: null })
      throw new Error(`no debería consultar ${table} sin userId resuelto`)
    })

    const resultado = await sincronizarVencimientoPwa({
      dni: '00000000',
      disciplina: 'Aparatos / Musculación',
      fechaVencimiento: '2026-09-01',
    })

    expect(resultado).toEqual({ synced: false, reason: 'sin_cuenta_pwa' })
  })
})
