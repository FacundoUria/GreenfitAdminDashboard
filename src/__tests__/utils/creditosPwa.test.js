import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import * as creditosPwa from '../../utils/creditosPwa'
import {
  resolverDisciplinaId,
  sincronizarEstadoCuentaPwa,
  fijarCreditosDisciplina,
  ajustarCreditoDisciplina,
  editarFechaVencimientoSocio,
} from '../../utils/creditosPwa'

const mockedFrom = supabase.from
const mockedRpc = supabase.rpc

function makeChain(result) {
  const chain = {}
  const self = () => chain
  ;['select', 'eq', 'ilike', 'limit', 'order', 'insert', 'update'].forEach((metodo) => {
    chain[metodo] = vi.fn(self)
  })
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

// T5 -- sincronizarCreditosPwa, sincronizarVencimientoPwa y
// sincronizarVencimientoCreditoPwa escribían user_credits DIRECTO desde el
// navegador (INSERT/UPDATE sueltos, con una segunda fecha por disciplina) y
// nadie las llamaba desde la Fase 2. Se borraron: el Admin ya no escribe
// user_credits por fuera de un RPC. Si alguien las vuelve a agregar, esto falla.
describe('T5 -- el Admin ya no escribe user_credits directo', () => {
  it('creditosPwa.js ya no exporta las 3 funciones que escribían user_credits', () => {
    expect(creditosPwa.sincronizarCreditosPwa).toBeUndefined()
    expect(creditosPwa.sincronizarVencimientoPwa).toBeUndefined()
    expect(creditosPwa.sincronizarVencimientoCreditoPwa).toBeUndefined()
  })

  it('lo que queda de creditosPwa.js nunca toca user_credits (ni siquiera para leer)', async () => {
    const tablas = []
    mockedFrom.mockImplementation((table) => {
      tablas.push(table)
      if (table === 'profiles') return makeChain({ data: { id: 'user-1' }, error: null })
      if (table === 'disciplines') return makeChain({ data: [{ id: 'disc-1', name: 'CrossFit', created_at: '2025-01-01' }], error: null })
      throw new Error(`tabla inesperada: ${table}`)
    })
    mockedRpc.mockResolvedValue({ data: null, error: null })

    await resolverDisciplinaId('CrossFit')
    await sincronizarEstadoCuentaPwa({ dni: '30111222', activo: true })
    await fijarCreditosDisciplina('user-1', 'disc-1', 3)
    await ajustarCreditoDisciplina('user-1', 'disc-1', 1)

    expect(tablas).not.toContain('user_credits')
  })
})

// Bug real (TAREA 1): ~750 socios importados de Crossfy sin DNI cargado
// nunca podían resolverse contra su cuenta de la PWA -- resolverUserId
// dependía EXCLUSIVAMENTE del DNI. Ahora, sin DNI (o si el DNI no matchea),
// cae a buscar por email. (Antes se probaba a través de sincronizarCreditosPwa,
// borrada en T5; hoy la usa sincronizarEstadoCuentaPwa, la baja/reactivación.)
describe('resolución de cuenta PWA con fallback a email (sin DNI cargado), vía sincronizarEstadoCuentaPwa', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sin DNI, resuelve la cuenta PWA por email y actualiza el acceso igual', async () => {
    const consultas = []
    mockedFrom.mockImplementation((table) => {
      const chain = makeChain({ data: { id: 'user-1' }, error: null })
      chain.ilike = vi.fn((columna, valor) => {
        consultas.push(`${columna}~${valor}`)
        return chain
      })
      chain.eq = vi.fn((columna, valor) => {
        consultas.push(`${columna}=${valor}`)
        return chain
      })
      if (table !== 'profiles') throw new Error(`tabla inesperada: ${table}`)
      return chain
    })

    const resultado = await sincronizarEstadoCuentaPwa({ dni: null, email: 'martina@example.com', activo: false })

    expect(resultado).toEqual({ synced: true })
    // No intenta resolver por dni (no vino): solo por email, y después el UPDATE por id.
    expect(consultas).toEqual(['email~martina@example.com', 'id=user-1'])
  })

  it('con DNI que no matchea ninguna cuenta, cae al email como respaldo', async () => {
    let lecturas = 0
    mockedFrom.mockImplementation((table) => {
      if (table !== 'profiles') throw new Error(`tabla inesperada: ${table}`)
      const chain = makeChain({ data: null, error: null })
      chain.maybeSingle = vi.fn(() => {
        lecturas += 1
        // 1ra lectura = por dni (no matchea). 2da = por email (sí matchea).
        return Promise.resolve(lecturas === 1 ? { data: null, error: null } : { data: { id: 'user-2' }, error: null })
      })
      return chain
    })

    const resultado = await sincronizarEstadoCuentaPwa({ dni: '11111111', email: 'bruno@example.com', activo: true })

    expect(resultado).toEqual({ synced: true })
    expect(lecturas).toBe(2)
  })

  it('sin DNI y sin email, no intenta nada -- devuelve sin_cuenta_pwa sin tocar la red', async () => {
    mockedFrom.mockImplementation((table) => {
      throw new Error(`no debería consultar ${table} sin dni ni email`)
    })

    const resultado = await sincronizarEstadoCuentaPwa({ dni: null, email: null, activo: true })
    expect(resultado).toEqual({ synced: false, reason: 'sin_cuenta_pwa' })
  })

  it('una excepción inesperada (no un error de Supabase, un throw real) se atrapa y no se propaga', async () => {
    mockedFrom.mockImplementation(() => {
      throw new Error('Falla de red simulada')
    })

    const resultado = await sincronizarEstadoCuentaPwa({ dni: '30111222', activo: true })
    expect(resultado).toEqual({ synced: false, reason: 'error_supabase' })
  })
})

// Caso real reportado (segunda vuelta, post-rename Kickboxing -> Kickstrike):
// la grilla del Admin mostraba 0 créditos y sumar/restar tiraba "disciplina
// no encontrada" pese a que la PWA sincronizaba bien. Causa real: la unique
// constraint de disciplines.name es CASE-SENSITIVE -- "Kickstrike" y
// "kickstrike" conviven como filas DISTINTAS y perfectamente "únicas" para
// Postgres, pero ilike (usado para resolver por nombre) las matchea a las
// dos, y antes .maybeSingle() ante 2+ filas devolvía null en silencio (el
// error ni se chequeaba). Ahora se resuelve la ambigüedad a mano. (Antes se
// probaba a través de sincronizarCreditosPwa, borrada en T5: ahora directo.)
describe('resolverDisciplinaId -- ambigüedad por mayúsculas/minúsculas en disciplines.name', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dos filas matchean por ilike ("Kickstrike" y "kickstrike") -- se queda con la que calza EXACTO', async () => {
    mockedFrom.mockImplementation((table) => {
      if (table !== 'disciplines') throw new Error(`tabla inesperada en el test: ${table}`)
      return makeChain({
        data: [
          { id: 'disc-duplicada-vieja', name: 'kickstrike', created_at: '2025-01-01T00:00:00.000Z' },
          { id: 'disc-real', name: 'Kickstrike', created_at: '2026-08-01T00:00:00.000Z' },
        ],
        error: null,
      })
    })

    expect(await resolverDisciplinaId('Kickstrike')).toBe('disc-real')
  })

  it('ninguna de las filas ambiguas calza exacto -- usa la más antigua en vez de fallar', async () => {
    mockedFrom.mockImplementation(() =>
      makeChain({
        data: [
          { id: 'disc-nueva', name: 'crossfit ', created_at: '2026-08-01T00:00:00.000Z' },
          { id: 'disc-vieja', name: 'CROSSFIT', created_at: '2025-01-01T00:00:00.000Z' },
        ],
        error: null,
      }),
    )

    expect(await resolverDisciplinaId('CrossFit')).toBe('disc-vieja')
  })

  it('una sola fila: la devuelve; ninguna o error: null', async () => {
    mockedFrom.mockImplementationOnce(() => makeChain({ data: [{ id: 'disc-unica', name: 'Boxeo' }], error: null }))
    expect(await resolverDisciplinaId('Boxeo')).toBe('disc-unica')

    mockedFrom.mockImplementationOnce(() => makeChain({ data: [], error: null }))
    expect(await resolverDisciplinaId('Pase Libre')).toBeNull()

    mockedFrom.mockImplementationOnce(() => makeChain({ data: null, error: { message: 'falla' } }))
    expect(await resolverDisciplinaId('CrossFit')).toBeNull()

    expect(await resolverDisciplinaId('')).toBeNull()
  })
})

describe('fijarCreditosDisciplina (wrapper de admin_fijar_creditos_disciplina)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fijar un número MAYOR al actual -- llama al RPC con el total exacto pedido', async () => {
    mockedRpc.mockResolvedValue({ error: null })
    await fijarCreditosDisciplina('user-1', 'disc-crossfit', 20)
    expect(mockedRpc).toHaveBeenCalledWith('admin_fijar_creditos_disciplina', {
      p_user_id: 'user-1',
      p_discipline_id: 'disc-crossfit',
      p_creditos: 20,
    })
  })

  it('fijar un número MENOR al actual -- mismo contrato, sin importar la dirección del cambio', async () => {
    mockedRpc.mockResolvedValue({ error: null })
    await fijarCreditosDisciplina('user-1', 'disc-crossfit', 4)
    expect(mockedRpc).toHaveBeenCalledWith('admin_fijar_creditos_disciplina', {
      p_user_id: 'user-1',
      p_discipline_id: 'disc-crossfit',
      p_creditos: 4,
    })
  })

  it('fijar en 0 -- se manda tal cual, no se convierte en null ni se omite', async () => {
    mockedRpc.mockResolvedValue({ error: null })
    await fijarCreditosDisciplina('user-1', 'disc-crossfit', 0)
    expect(mockedRpc).toHaveBeenCalledWith('admin_fijar_creditos_disciplina', {
      p_user_id: 'user-1',
      p_discipline_id: 'disc-crossfit',
      p_creditos: 0,
    })
  })

  it('relanza el error del RPC (ej. socio sin habilitación, guarda de disciplina no-credits) en vez de tragárselo', async () => {
    const errorRpc = { message: 'admin_fijar_creditos_disciplina() es solo para disciplinas de créditos...' }
    mockedRpc.mockResolvedValue({ error: errorRpc })
    await expect(fijarCreditosDisciplina('user-1', 'disc-aparatos', 5)).rejects.toBe(errorRpc)
  })
})

describe('ajustarCreditoDisciplina (wrapper de admin_ajustar_credito_disciplina)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('+1 -- llama al RPC con delta positivo (la fusión/creación de lote es 100% server-side)', async () => {
    mockedRpc.mockResolvedValue({ error: null })
    await ajustarCreditoDisciplina('user-1', 'disc-crossfit', 1)
    expect(mockedRpc).toHaveBeenCalledWith('admin_ajustar_credito_disciplina', {
      p_user_id: 'user-1',
      p_discipline_id: 'disc-crossfit',
      p_delta: 1,
    })
  })

  it('-1 -- llama al RPC con delta negativo (el FIFO por expires_at asc es 100% server-side)', async () => {
    mockedRpc.mockResolvedValue({ error: null })
    await ajustarCreditoDisciplina('user-1', 'disc-crossfit', -1)
    expect(mockedRpc).toHaveBeenCalledWith('admin_ajustar_credito_disciplina', {
      p_user_id: 'user-1',
      p_discipline_id: 'disc-crossfit',
      p_delta: -1,
    })
  })

  it('relanza el error del RPC en vez de tragárselo', async () => {
    const errorRpc = { message: 'boom' }
    mockedRpc.mockResolvedValue({ error: errorRpc })
    await expect(ajustarCreditoDisciplina('user-1', 'disc-crossfit', -1)).rejects.toBe(errorRpc)
  })
})

// CAMBIO 3 ("editar la fecha del plan") -- wrapper de
// admin_editar_fecha_vencimiento_socio. ADITIVO: no toca fijarCreditosDisciplina
// ni ajustarCreditoDisciplina (ver los describe de arriba, sin ningún cambio).
describe('editarFechaVencimientoSocio (wrapper de admin_editar_fecha_vencimiento_socio)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('llama al RPC con userId y la nueva fecha, y devuelve la cantidad de filas actualizadas', async () => {
    mockedRpc.mockResolvedValue({ data: 3, error: null })
    const resultado = await editarFechaVencimientoSocio('user-1', '2027-01-15')
    expect(mockedRpc).toHaveBeenCalledWith('admin_editar_fecha_vencimiento_socio', {
      p_user_id: 'user-1',
      p_nueva_fecha: '2027-01-15',
    })
    expect(resultado).toBe(3)
  })

  it('relanza el error del RPC (ej. socio sin ningún plan activo) en vez de tragárselo', async () => {
    const errorRpc = {
      message: 'Este socio no tiene ningún plan activo -- para asignarle una fecha nueva, hay que usar Cobrar, no editar la fecha.',
    }
    mockedRpc.mockResolvedValue({ error: errorRpc })
    await expect(editarFechaVencimientoSocio('user-1', '2027-01-15')).rejects.toBe(errorRpc)
  })
})
