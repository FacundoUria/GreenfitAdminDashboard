import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import {
  sincronizarVencimientoPwa,
  sincronizarCreditosPwa,
  sincronizarVencimientoCreditoPwa,
} from '../../utils/creditosPwa'

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

  it('sin cuenta PWA vinculada al DNI NI al email, no intenta sincronizar nada más', async () => {
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

// Bug real (TAREA 1): ~750 socios importados de Crossfy sin DNI cargado
// nunca podían sincronizar créditos con la PWA -- resolverUserId dependía
// EXCLUSIVAMENTE del DNI. Ahora, sin DNI (o si el DNI no matchea), cae a
// buscar por email.
describe('resolución de cuenta PWA con fallback a email (sin DNI cargado)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sin DNI, resuelve la cuenta PWA por email y sincroniza los créditos igual', async () => {
    const llamadas = []
    mockedFrom.mockImplementation((table) => {
      llamadas.push(table)
      if (table === 'profiles') return makeChain({ data: { id: 'user-1' }, error: null })
      if (table === 'disciplines') return makeChain({ data: { id: 'disc-crossfit' }, error: null })
      if (table === 'user_credits') return makeChain({ data: { remaining_credits: 3 }, error: null })
      throw new Error(`tabla inesperada en el test: ${table}`)
    })

    const resultado = await sincronizarCreditosPwa({
      dni: null,
      email: 'martina@example.com',
      disciplina: 'CrossFit',
      delta: 4,
    })

    expect(resultado).toEqual({ synced: true })
    // No debería intentar resolver por dni en absoluto (no vino) -- solo
    // por email.
    expect(llamadas.filter((t) => t === 'profiles')).toHaveLength(1)
  })

  it('con DNI que no matchea ninguna cuenta, cae al email como respaldo', async () => {
    let llamadasProfiles = 0
    mockedFrom.mockImplementation((table) => {
      if (table === 'profiles') {
        llamadasProfiles += 1
        // 1ra llamada = por dni (no matchea). 2da = por email (sí matchea).
        return makeChain(llamadasProfiles === 1 ? { data: null, error: null } : { data: { id: 'user-2' }, error: null })
      }
      if (table === 'disciplines') return makeChain({ data: { id: 'disc-crossfit' }, error: null })
      if (table === 'user_credits') return makeChain({ data: null, error: null })
      throw new Error(`tabla inesperada en el test: ${table}`)
    })

    const resultado = await sincronizarCreditosPwa({
      dni: '11111111',
      email: 'bruno@example.com',
      disciplina: 'CrossFit',
      delta: 1,
    })

    expect(resultado).toEqual({ synced: true })
    expect(llamadasProfiles).toBe(2)
  })

  it('sin DNI y sin email, no intenta nada -- devuelve sin_cuenta_pwa sin tocar la red', async () => {
    mockedFrom.mockImplementation((table) => {
      throw new Error(`no debería consultar ${table} sin dni ni email`)
    })

    const resultado = await sincronizarCreditosPwa({ dni: null, email: null, disciplina: 'CrossFit', delta: 1 })
    expect(resultado).toEqual({ synced: false, reason: 'sin_cuenta_pwa' })
  })

  it('una excepción inesperada (no un error de Supabase, un throw real) se atrapa y no se propaga', async () => {
    mockedFrom.mockImplementation(() => {
      throw new Error('Falla de red simulada')
    })

    const resultado = await sincronizarCreditosPwa({ dni: '30111222', disciplina: 'CrossFit', delta: 1 })
    expect(resultado).toEqual({ synced: false, reason: 'error_supabase' })
  })
})

// TAREA 3: el vencimiento ya no es exclusivo de Aparatos -- para una
// disciplina de CRÉDITOS, sincronizarVencimientoCreditoPwa tiene que
// PRESERVAR el remaining_credits actual (a diferencia de
// sincronizarVencimientoPwa, que lo pisa con null a propósito porque ahí sí
// es correcto para una membresía).
describe('sincronizarVencimientoCreditoPwa (vencimiento de una disciplina de créditos, sin pisar el balance)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inserta la nueva fila con expires_at actualizado Y remaining_credits preservado (no null)', async () => {
    let payloadInsertado = null
    mockedFrom.mockImplementation((table) => {
      if (table === 'profiles') return makeChain({ data: { id: 'user-1' }, error: null })
      if (table === 'disciplines') return makeChain({ data: { id: 'disc-crossfit' }, error: null })
      if (table === 'user_credits') {
        const chain = makeChain({ error: null })
        chain.select = vi.fn(() => chain)
        chain.eq = vi.fn(() => chain)
        chain.order = vi.fn(() => chain)
        chain.limit = vi.fn(() => chain)
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { remaining_credits: 7 }, error: null })
        chain.insert = vi.fn((payload) => {
          payloadInsertado = payload
          return { error: null }
        })
        return chain
      }
      throw new Error(`tabla inesperada en el test: ${table}`)
    })

    const resultado = await sincronizarVencimientoCreditoPwa({
      dni: '30111222',
      disciplina: 'CrossFit',
      fechaVencimiento: '2026-09-01',
    })

    expect(resultado).toEqual({ synced: true })
    expect(payloadInsertado.remaining_credits).toBe(7)
    expect(payloadInsertado.expires_at).toContain('2026-09-01')
  })

  it('sin balance previo, preserva 0 en vez de null', async () => {
    let payloadInsertado = null
    mockedFrom.mockImplementation((table) => {
      if (table === 'profiles') return makeChain({ data: { id: 'user-1' }, error: null })
      if (table === 'disciplines') return makeChain({ data: { id: 'disc-crossfit' }, error: null })
      if (table === 'user_credits') {
        const chain = makeChain({ error: null })
        chain.select = vi.fn(() => chain)
        chain.eq = vi.fn(() => chain)
        chain.order = vi.fn(() => chain)
        chain.limit = vi.fn(() => chain)
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
        chain.insert = vi.fn((payload) => {
          payloadInsertado = payload
          return { error: null }
        })
        return chain
      }
      throw new Error(`tabla inesperada en el test: ${table}`)
    })

    await sincronizarVencimientoCreditoPwa({ dni: '30111222', disciplina: 'CrossFit', fechaVencimiento: '2026-09-01' })

    expect(payloadInsertado.remaining_credits).toBe(0)
  })
})
