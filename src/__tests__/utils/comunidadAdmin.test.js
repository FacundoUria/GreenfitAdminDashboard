import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import { fetchFeedAdmin, fetchDisciplinasGrupalesAdmin, fetchRankingAdmin } from '../../utils/comunidadAdmin'

const mockedFrom = supabase.from
const mockedRpc = supabase.rpc

function makeChain(result) {
  const chain = {}
  const self = () => chain
  ;['select', 'eq', 'in', 'order', 'limit'].forEach((metodo) => {
    chain[metodo] = vi.fn(self)
  })
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

describe('fetchFeedAdmin (espejo de solo lectura del Feed de la PWA)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('arma cada post con nombre/avatar reales (vía RPC), cantidad de reacciones y comentarios', async () => {
    mockedFrom.mockImplementation((table) => {
      if (table === 'community_posts') {
        return makeChain({
          data: [
            {
              id: 'post-1',
              author_id: 'u1',
              body: 'Hoy rompí todo en CrossFit',
              media_url: null,
              author_nivel: 3,
              author_discipline: 'CrossFit',
              created_at: '2026-08-10T12:00:00.000Z',
            },
          ],
          error: null,
        })
      }
      if (table === 'community_reactions') {
        return makeChain({ data: [{ post_id: 'post-1' }, { post_id: 'post-1' }], error: null })
      }
      if (table === 'community_comments') {
        return makeChain({
          data: [{ id: 'c1', post_id: 'post-1', author_id: 'u2', body: '¡Grande!', created_at: '2026-08-10T12:05:00.000Z' }],
          error: null,
        })
      }
      throw new Error(`tabla inesperada en el test: ${table}`)
    })
    mockedRpc.mockImplementation((fn, args) => {
      if (args.p_ids.includes('u1')) {
        return Promise.resolve({ data: [{ id: 'u1', full_name: 'Martina Ríos', avatar_url: 'foto.jpg' }], error: null })
      }
      return Promise.resolve({ data: [{ id: 'u2', full_name: 'Bruno Álvarez', avatar_url: null }], error: null })
    })

    const feed = await fetchFeedAdmin()
    expect(feed).toEqual([
      {
        id: 'post-1',
        authorName: 'Martina Ríos',
        authorAvatarUrl: 'foto.jpg',
        authorNivel: 3,
        authorDiscipline: 'CrossFit',
        body: 'Hoy rompí todo en CrossFit',
        mediaUrl: null,
        createdAt: '2026-08-10T12:00:00.000Z',
        reactionCount: 2,
        comentarios: [{ id: 'c1', authorName: 'Bruno Álvarez', body: '¡Grande!', createdAt: '2026-08-10T12:05:00.000Z' }],
      },
    ])
  })

  it('sin posts, devuelve vacío sin consultar reacciones/comentarios', async () => {
    mockedFrom.mockImplementation((table) => {
      if (table === 'community_posts') return makeChain({ data: [], error: null })
      throw new Error(`no debería consultar ${table} sin posts`)
    })

    expect(await fetchFeedAdmin()).toEqual([])
  })

  it('si community_posts todavía no existe, devuelve vacío en vez de romper', async () => {
    mockedFrom.mockReturnValue(makeChain({ data: null, error: { code: '42P01', message: 'no existe' } }))
    expect(await fetchFeedAdmin()).toEqual([])
  })
})

describe('fetchDisciplinasGrupalesAdmin', () => {
  beforeEach(() => vi.clearAllMocks())

  it('trae solo disciplinas activas de tipo créditos', async () => {
    mockedFrom.mockReturnValue(makeChain({ data: [{ id: 'd1', name: 'Boxeo' }], error: null }))
    expect(await fetchDisciplinasGrupalesAdmin()).toEqual([{ id: 'd1', name: 'Boxeo' }])
  })

  it('si disciplines fallara con relación faltante, cae a vacío', async () => {
    mockedFrom.mockReturnValue(makeChain({ data: null, error: { code: 'PGRST205', message: 'no existe' } }))
    expect(await fetchDisciplinasGrupalesAdmin()).toEqual([])
  })
})

describe('fetchRankingAdmin', () => {
  beforeEach(() => vi.clearAllMocks())

  it('llama a community_ranking_xp con el discipline_id y mapea el resultado', async () => {
    mockedRpc.mockResolvedValue({
      data: [{ user_id: 'u1', full_name: 'Martina Ríos', avatar_url: null, total_xp: 1150 }],
      error: null,
    })

    const ranking = await fetchRankingAdmin('disc-crossfit')
    expect(mockedRpc).toHaveBeenCalledWith('community_ranking_xp', { p_discipline_id: 'disc-crossfit' })
    expect(ranking).toEqual([{ userId: 'u1', fullName: 'Martina Ríos', avatarUrl: null, xp: 1150 }])
  })

  it('sin la función todavía desplegada, cae a vacío en vez de romper', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'no existe' } })
    expect(await fetchRankingAdmin(null)).toEqual([])
  })
})
