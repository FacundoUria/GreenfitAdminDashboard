import { useEffect, useState } from 'react'
import { Loader2, MessageCircle, ThumbsUp } from 'lucide-react'
import { fetchFeedAdmin } from '../../utils/comunidadAdmin'

function iniciales(nombre) {
  const partes = (nombre ?? '?').trim().split(/\s+/)
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase()
  return `${partes[0][0]}${partes[partes.length - 1][0]}`.toUpperCase()
}

// Mismo criterio de color por texto que ya usa SociosTabla.jsx (AvatarSocio)
// -- un hash simple sobre el nombre, no depende de ninguna paleta importada.
function colorAvatar(texto) {
  let hash = 0
  for (const char of texto || '?') hash = char.charCodeAt(0) + ((hash << 5) - hash)
  return `hsl(${hash % 360}, 65%, 55%)`
}

function AvatarAutor({ nombre, avatarUrl, size = 40 }) {
  const dimension = `${size}px`
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={`Foto de ${nombre}`}
        style={{ width: dimension, height: dimension }}
        className="shrink-0 rounded-full object-cover"
      />
    )
  }
  const color = colorAvatar(nombre)
  return (
    <div
      style={{ width: dimension, height: dimension, backgroundColor: `${color}26`, color, borderColor: color }}
      className="flex shrink-0 items-center justify-center rounded-full border text-sm font-semibold"
    >
      {iniciales(nombre)}
    </div>
  )
}

function formatRelativo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'ahora'
  if (diffMin < 60) return `hace ${diffMin} min`
  const diffHoras = Math.floor(diffMin / 60)
  if (diffHoras < 24) return `hace ${diffHoras} h`
  const diffDias = Math.floor(diffHoras / 24)
  return `hace ${diffDias} d`
}

// Vista de SOLO LECTURA del Feed de Comunidad -- el Admin ve exactamente lo
// mismo que comparten los socios (fotos, texto, comentarios), sin poder
// reaccionar/comentar/publicar desde acá (esto es moderación/supervisión,
// no otra cuenta más en el feed).
function FeedAdmin() {
  const [posts, setPosts] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let activo = true
    async function cargar() {
      try {
        const data = await fetchFeedAdmin()
        if (activo) setPosts(data)
      } catch (err) {
        if (activo) setError(err instanceof Error ? err.message : 'No se pudo cargar el feed.')
      } finally {
        if (activo) setCargando(false)
      }
    }
    cargar()
    return () => {
      activo = false
    }
  }, [])

  if (cargando) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-greenfit-card p-10 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Cargando publicaciones...
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center text-sm text-red-400">
        {error}
      </div>
    )
  }

  if (posts.length === 0) {
    return (
      <div className="rounded-xl border border-white/5 bg-greenfit-card p-10 text-center text-sm text-gray-400">
        Todavía no hay publicaciones en la Comunidad.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {posts.map((post) => (
        <div key={post.id} className="flex flex-col gap-3 rounded-xl border border-white/5 bg-greenfit-card p-5">
          <div className="flex items-center gap-3">
            <AvatarAutor nombre={post.authorName} avatarUrl={post.authorAvatarUrl} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-semibold text-white">{post.authorName}</p>
                {post.authorNivel != null && (
                  <span className="rounded-full bg-greenfit-primary px-1.5 py-0.5 text-[10px] font-bold text-greenfit-dark">
                    N{post.authorNivel}
                  </span>
                )}
                {post.authorDiscipline && (
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-gray-300">
                    {post.authorDiscipline}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500">{formatRelativo(post.createdAt)}</p>
            </div>
          </div>

          <p className="whitespace-pre-wrap text-sm text-gray-200">{post.body}</p>

          {post.mediaUrl && (
            <img src={post.mediaUrl} alt="Foto de la publicación" className="max-h-80 w-full rounded-lg object-cover" />
          )}

          <div className="flex items-center gap-4 border-t border-white/5 pt-3 text-xs text-gray-400">
            <span className="flex items-center gap-1.5">
              <ThumbsUp className="h-3.5 w-3.5" />
              {post.reactionCount} {post.reactionCount === 1 ? 'reacción' : 'reacciones'}
            </span>
            <span className="flex items-center gap-1.5">
              <MessageCircle className="h-3.5 w-3.5" />
              {post.comentarios.length} {post.comentarios.length === 1 ? 'comentario' : 'comentarios'}
            </span>
          </div>

          {post.comentarios.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg bg-white/[0.03] p-3">
              {post.comentarios.map((c) => (
                <div key={c.id} className="text-xs text-gray-300">
                  <span className="font-semibold text-white">{c.authorName}: </span>
                  {c.body}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export default FeedAdmin
