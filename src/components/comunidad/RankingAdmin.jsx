import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { fetchDisciplinasGrupalesAdmin, fetchRankingAdmin } from '../../utils/comunidadAdmin'

function iniciales(nombre) {
  const partes = (nombre ?? '?').trim().split(/\s+/)
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase()
  return `${partes[0][0]}${partes[partes.length - 1][0]}`.toUpperCase()
}

function colorAvatar(texto) {
  let hash = 0
  for (const char of texto || '?') hash = char.charCodeAt(0) + ((hash << 5) - hash)
  return `hsl(${hash % 360}, 65%, 55%)`
}

function AvatarRanking({ nombre, avatarUrl, size = 40 }) {
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

const MEDALLAS = ['🥇', '🥈', '🥉']

// Ranking/leaderboard general de XP -- misma jerarquía visual que la PWA
// (podio de los primeros 3 + lista para el resto), con el mismo filtro por
// disciplina grupal. Solo lectura: acá no hay "tocar una fila para chatear"
// (eso es exclusivo de la PWA, y el Admin no tiene mensajería 1 a 1).
function RankingAdmin() {
  const [ranking, setRanking] = useState([])
  const [disciplinas, setDisciplinas] = useState([])
  const [disciplinaId, setDisciplinaId] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let activo = true
    async function cargarInicial() {
      try {
        const [rankingData, disciplinasData] = await Promise.all([
          fetchRankingAdmin(null),
          fetchDisciplinasGrupalesAdmin(),
        ])
        if (!activo) return
        setRanking(rankingData)
        setDisciplinas(disciplinasData)
      } catch (err) {
        if (activo) setError(err instanceof Error ? err.message : 'No se pudo cargar el ranking.')
      } finally {
        if (activo) setCargando(false)
      }
    }
    cargarInicial()
    return () => {
      activo = false
    }
  }, [])

  const handleFiltrar = async (id) => {
    setDisciplinaId(id)
    setCargando(true)
    try {
      setRanking(await fetchRankingAdmin(id))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo filtrar el ranking.')
    } finally {
      setCargando(false)
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center text-sm text-red-400">
        {error}
      </div>
    )
  }

  const podio = ranking.slice(0, 3)
  const resto = ranking.slice(3)

  return (
    <div className="flex flex-col gap-5">
      {disciplinas.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleFiltrar(null)}
            className={`min-h-[36px] rounded-full px-4 text-xs font-semibold transition-colors ${
              disciplinaId === null
                ? 'bg-greenfit-primary text-greenfit-dark'
                : 'border border-white/10 text-gray-300 hover:bg-white/5'
            }`}
          >
            Global
          </button>
          {disciplinas.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => handleFiltrar(d.id)}
              className={`min-h-[36px] rounded-full px-4 text-xs font-semibold transition-colors ${
                disciplinaId === d.id
                  ? 'bg-greenfit-primary text-greenfit-dark'
                  : 'border border-white/10 text-gray-300 hover:bg-white/5'
              }`}
            >
              {d.name}
            </button>
          ))}
        </div>
      )}

      {cargando ? (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-greenfit-card p-10 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Cargando ranking...
        </div>
      ) : ranking.length === 0 ? (
        <div className="rounded-xl border border-white/5 bg-greenfit-card p-10 text-center text-sm text-gray-400">
          Todavía no hay XP registrado{disciplinaId ? ' en esta disciplina' : ''}.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            {podio.map((entry, i) => (
              <div
                key={entry.userId}
                className={`flex flex-col items-center gap-2 rounded-xl border p-4 ${
                  i === 0 ? 'border-greenfit-primary bg-greenfit-primary/10' : 'border-white/5 bg-greenfit-card'
                }`}
              >
                <span className="text-2xl">{MEDALLAS[i]}</span>
                <AvatarRanking nombre={entry.fullName} avatarUrl={entry.avatarUrl} />
                <p className="max-w-full truncate text-xs font-semibold text-white">{entry.fullName}</p>
                <p className="text-xs text-gray-400">{entry.xp} XP</p>
              </div>
            ))}
          </div>

          <ul className="flex flex-col gap-2">
            {resto.map((entry, i) => (
              <li
                key={entry.userId}
                className="flex items-center gap-3 rounded-lg border border-white/5 bg-greenfit-card px-4 py-3"
              >
                <span className="w-6 shrink-0 text-sm font-bold text-gray-500">{i + 4}</span>
                <AvatarRanking nombre={entry.fullName} avatarUrl={entry.avatarUrl} size={32} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">{entry.fullName}</span>
                <span className="text-sm text-gray-400">{entry.xp} XP</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export default RankingAdmin
