import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fixes de datos de Reportes (auditoría 2026-10-01):
//  - los `.in(...)` con TODOS los DNIs/ids viajaban en la URL del pedido: con
//    muchos socios podía superar el largo máximo, el pedido fallaba y las
//    funciones devolvían un Map vacío con solo un console.error -> todos los
//    socios pasaban a verse "Inactivo" en silencio. Ahora van en lotes.
//  - la paginación con .range() no tenía .order() (no era determinística).
//  - con `{ lanzarSiFalla: true }` el error se LANZA para que la pantalla avise.

const consultas = []
let responder

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (tabla) => {
      const q = { tabla, in: null, order: null, select: null }
      const chain = {
        select: (cols) => ((q.select = cols), chain),
        in: (col, valores) => ((q.in = { col, valores }), chain),
        order: (col, opciones) => ((q.order = { col, opciones }), chain),
        range: (desde, hasta) => {
          consultas.push({ ...q, rango: [desde, hasta] })
          return Promise.resolve(responder(q, desde, hasta))
        },
      }
      return chain
    },
  },
}))

import {
  TAMANO_LOTE_IDS,
  fetchAparatosVigentePorDni,
  fetchCreditosPorDisciplina,
  fetchMembresiasVigentesPorDni,
  fetchPorLotesDeIds,
  fetchTodosLosSocios,
} from '../../utils/fichaSocioPwa'

const FUTURO = '2099-01-01T12:00:00.000Z'
const CROSSFIT = { id: 'd-cf', name: 'CrossFit', kind: 'credits' }
const APARATOS = { id: 'd-ap', name: 'Aparatos', kind: 'membership' }
const dnis = (n) => Array.from({ length: n }, (_, i) => String(30000000 + i))

// "Base" simulada: cada DNI tiene cuenta (profile-<dni>) y, si es par, 3
// créditos de CrossFit; si es múltiplo de 3, Aparatos vigente.
function baseNormal(q) {
  if (q.tabla === 'profiles') return { data: q.in.valores.map((dni) => ({ id: `profile-${dni}`, dni })), error: null }
  if (q.tabla === 'user_credits') {
    const filas = []
    for (const userId of q.in.valores) {
      const n = Number(userId.replace('profile-', ''))
      if (n % 2 === 0) filas.push({ id: `c-${n}`, user_id: userId, remaining_credits: 3, expires_at: FUTURO, discipline: CROSSFIT })
      if (n % 3 === 0) filas.push({ id: `m-${n}`, user_id: userId, remaining_credits: null, expires_at: FUTURO, discipline: APARATOS })
    }
    return { data: filas, error: null }
  }
  return { data: [], error: null }
}

beforeEach(() => {
  consultas.length = 0
  responder = baseNormal
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('pedidos en lotes (no dependen del largo de la URL)', () => {
  it('fetchCreditosPorDisciplina con 250 socios: ningún .in() lleva más de 100 valores, y están todos', async () => {
    const lista = dnis(250)
    const resultado = await fetchCreditosPorDisciplina(lista)

    expect(TAMANO_LOTE_IDS).toBe(100)
    expect(consultas.every((c) => c.in.valores.length <= TAMANO_LOTE_IDS)).toBe(true)
    const deProfiles = consultas.filter((c) => c.tabla === 'profiles')
    const deCreditos = consultas.filter((c) => c.tabla === 'user_credits')
    expect(deProfiles.map((c) => c.in.valores.length)).toEqual([100, 100, 50])
    expect(deCreditos.map((c) => c.in.valores.length)).toEqual([100, 100, 50])
    // Ningún DNI se pierde ni se repite entre lotes.
    expect(deProfiles.flatMap((c) => c.in.valores).sort()).toEqual([...lista].sort())

    // Los 125 DNIs pares tienen sus 3 créditos.
    expect(resultado.size).toBe(125)
    expect(resultado.get('30000000')).toEqual([
      expect.objectContaining({ disciplineId: 'd-cf', disciplineName: 'CrossFit', remainingCredits: 3 }),
    ])
    expect(resultado.has('30000001')).toBe(false)
  })

  it('todas las consultas paginadas llevan un .order() fijo por id', async () => {
    await fetchCreditosPorDisciplina(dnis(120))
    await fetchMembresiasVigentesPorDni(dnis(120))
    await fetchTodosLosSocios()

    expect(consultas.length).toBeGreaterThan(0)
    for (const c of consultas) expect(c.order).toEqual({ col: 'id', opciones: { ascending: true } })
  })

  it('fetchPorLotesDeIds junta las filas de todos los lotes y corta ante el primer error', async () => {
    const ok = await fetchPorLotesDeIds(dnis(230), (lote) => ({
      range: () => Promise.resolve({ data: lote.map((dni) => ({ dni })), error: null }),
    }))
    expect(ok.error).toBeNull()
    expect(ok.data).toHaveLength(230)

    const mal = await fetchPorLotesDeIds(dnis(230), (lote) => ({
      range: () => Promise.resolve(lote.includes('30000150') ? { data: null, error: { message: 'boom' } } : { data: [], error: null }),
    }))
    expect(mal.data).toBeNull()
    expect(mal.error.message).toBe('boom')
  })
})

describe('fetchTodosLosSocios -- paginado', () => {
  it('trae todas las filas aunque sean más de 1000', async () => {
    const todos = Array.from({ length: 2300 }, (_, i) => ({ id: i }))
    responder = (_q, desde, hasta) => ({ data: todos.slice(desde, hasta + 1), error: null })

    const { data, error } = await fetchTodosLosSocios()
    expect(error).toBeNull()
    expect(data).toHaveLength(2300)
    expect(consultas.map((c) => c.rango)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
  })
})

describe('si una consulta falla: avisar en vez de fallar en silencio', () => {
  const fallaCreditos = (q) => (q.tabla === 'user_credits' ? { data: null, error: { message: 'URI too long' } } : baseNormal(q))

  it('con { lanzarSiFalla: true } se LANZA el error (Reportes lo muestra)', async () => {
    responder = fallaCreditos
    await expect(fetchCreditosPorDisciplina(dnis(5), { lanzarSiFalla: true })).rejects.toThrow('URI too long')
    await expect(fetchMembresiasVigentesPorDni(dnis(5), { lanzarSiFalla: true })).rejects.toThrow('URI too long')
  })

  it('también si falla resolver las cuentas (profiles)', async () => {
    responder = (q) => (q.tabla === 'profiles' ? { data: null, error: { message: 'sin red' } } : baseNormal(q))
    await expect(fetchCreditosPorDisciplina(dnis(5), { lanzarSiFalla: true })).rejects.toThrow('sin red')
    await expect(fetchMembresiasVigentesPorDni(dnis(5), { lanzarSiFalla: true })).rejects.toThrow('sin red')
  })

  it('sin la opción, el contrato de siempre para Home/Socios: Map vacío + error en consola (no rompe la pantalla)', async () => {
    responder = fallaCreditos
    await expect(fetchCreditosPorDisciplina(dnis(5))).resolves.toEqual(new Map())
    const aparatos = await fetchAparatosVigentePorDni(dnis(5))
    // Tienen cuenta confirmada pero no se pudo confirmar nada vigente.
    expect(aparatos.get('30000000')).toBe(false)
    expect(console.error).toHaveBeenCalled()
  })
})

describe('fetchMembresiasVigentesPorDni -- mismo criterio que fetchAparatosVigentePorDni, con el nombre de la disciplina', () => {
  it('devuelve el tri-estado de siempre y además QUÉ membresía tiene cada socio', async () => {
    const lista = ['30000000', '30000001', '30000003']
    responder = (q) => {
      // 30000001 no tiene cuenta en la app.
      if (q.tabla === 'profiles') return { data: q.in.valores.filter((d) => d !== '30000001').map((dni) => ({ id: `profile-${dni}`, dni })), error: null }
      return baseNormal(q)
    }
    const { vigentePorDni, disciplinasPorDni } = await fetchMembresiasVigentesPorDni(lista)

    expect(vigentePorDni.get('30000000')).toBe(true) // múltiplo de 3 -> Aparatos vigente
    expect(vigentePorDni.has('30000001')).toBe(false) // sin cuenta: ausente del Map
    expect(vigentePorDni.get('30000003')).toBe(true)
    expect(disciplinasPorDni.get('30000000')).toEqual([{ disciplineId: 'd-ap', disciplineName: 'Aparatos' }])

    // fetchAparatosVigentePorDni devuelve exactamente ese mismo tri-estado.
    expect(await fetchAparatosVigentePorDni(lista)).toEqual(vigentePorDni)
  })

  it('una membresía vencida no cuenta, y dos filas de la misma disciplina no la repiten', async () => {
    responder = (q) => {
      if (q.tabla === 'profiles') return baseNormal(q)
      return {
        data: [
          { id: 'a', user_id: 'profile-1', expires_at: '2020-01-01T00:00:00.000Z', discipline: APARATOS },
          { id: 'b', user_id: 'profile-2', expires_at: FUTURO, discipline: APARATOS },
          { id: 'c', user_id: 'profile-2', expires_at: FUTURO, discipline: APARATOS },
        ],
        error: null,
      }
    }
    const { vigentePorDni, disciplinasPorDni } = await fetchMembresiasVigentesPorDni(['1', '2'])
    expect(vigentePorDni.get('1')).toBe(false)
    expect(disciplinasPorDni.has('1')).toBe(false)
    expect(disciplinasPorDni.get('2')).toHaveLength(1)
  })
})
