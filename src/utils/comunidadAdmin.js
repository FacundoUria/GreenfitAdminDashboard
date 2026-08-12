import { supabase } from '../lib/supabaseClient'

// Espejo de SOLO LECTURA del módulo Comunidad de la PWA
// (greenfit-app/src/lib/comunidadApi.ts) -- mismas tablas
// (community_posts/community_reactions/community_comments) y mismos RPCs
// (community_author_names, community_ranking_xp) que ya usa la app de
// socios. El Admin solo VE el Feed y el Ranking (nunca postea, reacciona ni
// comenta desde acá) -- por eso no hace falta el "modo demo" que sí tiene
// la PWA: si las tablas todavía no están desplegadas, esto simplemente
// devuelve vacío en vez de fingir datos de ejemplo.
//
// A propósito NO incluye Mensajes privados (community_dm_*) -- decisión
// explícita de privacidad: el Admin no debe poder leer chats 1 a 1 entre
// socios.

// 42P01 = undefined_table (Postgres). PGRST205/PGRST202 = PostgREST no
// encuentra la tabla/función en su schema cache -- mismo criterio que el
// resto del panel (todavía no se corrió la migración de Comunidad).
function esErrorDeRelacionFaltante(error) {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST202') return true
  const msg = (error.message ?? '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('schema cache') || msg.includes('could not find')
}

// El embed profiles(full_name, avatar_url) corre bajo la RLS del socio que
// mira -- para el Admin hace falta el mismo RPC security definer que ya usa
// la PWA para resolver nombre/avatar de OTRO socio.
async function fetchAuthorInfoMap(ids) {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean)
  if (uniqueIds.length === 0) return new Map()
  const { data, error } = await supabase.rpc('community_author_names', { p_ids: uniqueIds })
  if (error) return new Map()
  return new Map((data ?? []).map((row) => [row.id, { fullName: row.full_name, avatarUrl: row.avatar_url ?? null }]))
}

// Feed público -- posts + cantidad de reacciones + comentarios reales
// (con quién los escribió), más recientes primero.
export async function fetchFeedAdmin() {
  const { data: posts, error } = await supabase
    .from('community_posts')
    .select('id, author_id, body, media_url, author_nivel, author_discipline, created_at')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) {
    if (esErrorDeRelacionFaltante(error)) return []
    throw new Error(error.message)
  }

  const postIds = (posts ?? []).map((p) => p.id)
  if (postIds.length === 0) return []

  const [{ data: reactions, error: reactionsError }, { data: comments, error: commentsError }, authorInfo] =
    await Promise.all([
      supabase.from('community_reactions').select('post_id').in('post_id', postIds),
      supabase.from('community_comments').select('id, post_id, author_id, body, created_at').in('post_id', postIds),
      fetchAuthorInfoMap((posts ?? []).map((p) => p.author_id)),
    ])
  if (reactionsError) throw new Error(reactionsError.message)
  if (commentsError) throw new Error(commentsError.message)

  const reactionCountByPost = new Map()
  for (const r of reactions ?? []) {
    reactionCountByPost.set(r.post_id, (reactionCountByPost.get(r.post_id) ?? 0) + 1)
  }

  const commentsByPost = new Map()
  for (const c of comments ?? []) {
    const lista = commentsByPost.get(c.post_id) ?? []
    lista.push(c)
    commentsByPost.set(c.post_id, lista)
  }
  const commentAuthorInfo = await fetchAuthorInfoMap((comments ?? []).map((c) => c.author_id))

  return (posts ?? []).map((p) => {
    const info = authorInfo.get(p.author_id)
    const comentarios = (commentsByPost.get(p.id) ?? [])
      .slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map((c) => ({
        id: c.id,
        authorName: commentAuthorInfo.get(c.author_id)?.fullName ?? 'Socio GreenFit',
        body: c.body,
        createdAt: c.created_at,
      }))
    return {
      id: p.id,
      authorName: info?.fullName ?? 'Socio GreenFit',
      authorAvatarUrl: info?.avatarUrl ?? null,
      authorNivel: p.author_nivel,
      authorDiscipline: p.author_discipline,
      body: p.body,
      mediaUrl: p.media_url,
      createdAt: p.created_at,
      reactionCount: reactionCountByPost.get(p.id) ?? 0,
      comentarios,
    }
  })
}

// Disciplinas grupales (por créditos) para el filtro del Ranking -- mismo
// criterio que fetchDisciplinasGrupales() de la PWA.
export async function fetchDisciplinasGrupalesAdmin() {
  const { data, error } = await supabase
    .from('disciplines')
    .select('id, name')
    .eq('kind', 'credits')
    .eq('is_active', true)
    .order('name', { ascending: true })
  if (error) {
    if (esErrorDeRelacionFaltante(error)) return []
    throw new Error(error.message)
  }
  return data ?? []
}

// Ranking general de XP (o filtrado por disciplina) -- mismo RPC que ya usa
// la PWA, misma jerarquía visual (podio + lista) del lado del componente.
export async function fetchRankingAdmin(disciplineId = null) {
  const { data, error } = await supabase.rpc('community_ranking_xp', { p_discipline_id: disciplineId })
  if (error) {
    if (esErrorDeRelacionFaltante(error)) return []
    throw new Error(error.message)
  }
  return (data ?? []).map((r) => ({
    userId: r.user_id,
    fullName: r.full_name,
    avatarUrl: r.avatar_url ?? null,
    xp: r.total_xp,
  }))
}

// Resetea el Ranking de Comunidad a 0 XP para TODOS los socios -- NO borra
// `xp_events` (auditoría completa): por cada socio con XP positivo, el RPC
// inserta una fila de compensación NEGATIVA que neutraliza su suma actual
// (mismo criterio que "revertir" un evento puntual desde la Actividad
// Reciente, ver supabase_migration_resetear_ranking.sql). Devuelve la
// cantidad de socios afectados, para poder confirmarlo en el toast.
export async function resetearRankingAdmin() {
  const { data, error } = await supabase.rpc('admin_resetear_ranking')
  if (error) {
    if (esErrorDeRelacionFaltante(error)) {
      throw new Error('Todavía no se corrió la migración de reseteo de ranking (supabase_migration_resetear_ranking.sql).')
    }
    throw new Error(error.message)
  }
  return data ?? 0
}
