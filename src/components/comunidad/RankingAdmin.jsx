import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react'
import { fetchDisciplinasGrupalesAdmin, fetchRankingAdmin, resetearRankingAdmin } from '../../utils/comunidadAdmin'
import { useConfiguracion } from '../../context/useConfiguracion'
import { formatFecha, hoyISO } from '../../utils/fecha'

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

// Modal de confirmación ESTRICTO para el reseteo de ranking -- acción
// destructiva-sensible que afecta a TODOS los socios a la vez (más grave que
// borrar una sola disciplina/pack, donde el resto del panel usa
// window.confirm), por eso un modal propio en vez del confirm nativo del
// navegador: mismo lenguaje visual (overlay + card) que el resto de los
// modales de esta app, con más superficie para dejar clarísimo lo que va a
// pasar antes de que el admin pueda confirmar.
function ResetearRankingModal({ onClose, onConfirmado }) {
  const [confirmando, setConfirmando] = useState(false)
  const [error, setError] = useState(null)

  const handleConfirmar = async () => {
    setConfirmando(true)
    setError(null)
    try {
      const afectados = await resetearRankingAdmin()
      onConfirmado(afectados)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo resetear el ranking.')
      setConfirmando(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl bg-greenfit-card p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-500/15">
            <AlertTriangle className="h-5 w-5 text-red-400" />
          </div>
          <h2 className="text-lg font-semibold text-white">Resetear Ranking</h2>
        </div>

        <p className="text-sm text-gray-300">
          ¿Estás seguro de que querés reiniciar el ranking? Todos los socios volverán a 0 XP. Esta acción no se
          puede deshacer.
        </p>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={confirmando}
            className="flex min-h-[44px] items-center justify-center rounded-lg border border-white/10 px-4 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirmar}
            disabled={confirmando}
            className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-red-500 px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {confirmando && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmando ? 'Reseteando...' : 'Sí, resetear a 0 XP'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Ranking/leaderboard general de XP -- misma jerarquía visual que la PWA
// (podio de los primeros 3 + lista para el resto), con el mismo filtro por
// disciplina grupal. Solo lectura salvo el reseteo: acá no hay "tocar una
// fila para chatear" (eso es exclusivo de la PWA, y el Admin no tiene
// mensajería 1 a 1).
function RankingAdmin() {
  const { configuracion } = useConfiguracion()
  const [ranking, setRanking] = useState([])
  const [disciplinas, setDisciplinas] = useState([])
  const [disciplinaId, setDisciplinaId] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [mostrarModalReset, setMostrarModalReset] = useState(false)
  const [avisoReset, setAvisoReset] = useState(null)

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

  // El RPC ya dejó a todos en 0 XP -- se refresca la vista actual (respeta el
  // filtro de disciplina que el admin tenía puesto) en vez de solo vaciar el
  // estado a mano, para que quede reflejado tal cual lo va a ver la próxima
  // vez que entre a esta pantalla.
  const handleResetConfirmado = async (afectados) => {
    setMostrarModalReset(false)
    setAvisoReset(
      afectados > 0
        ? `Listo: se reseteó el ranking, ${afectados} socio${afectados === 1 ? '' : 's'} volvieron a 0 XP.`
        : 'Listo: el ranking ya estaba en 0 XP para todos, no había nada para resetear.'
    )
    await handleFiltrar(disciplinaId)
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
  const proximoReseteo = configuracion?.proximo_reseteo_ranking ?? null
  const reseteoVencido = Boolean(proximoReseteo && proximoReseteo <= hoyISO())

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">Ranking de Comunidad</h2>
          {proximoReseteo && (
            <p className={`mt-1 text-xs ${reseteoVencido ? 'font-medium text-amber-400' : 'text-gray-400'}`}>
              ⏰ Reseteo programado para el {formatFecha(proximoReseteo)}
              {reseteoVencido
                ? ' -- ya llegó la fecha. No se hace solo: tocá "Resetear Ranking".'
                : ' (recordatorio visual, hay que tocar "Resetear Ranking" ese día).'}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setMostrarModalReset(true)}
          className="flex min-h-[40px] shrink-0 items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/20"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Resetear Ranking
        </button>
      </div>

      {avisoReset && (
        <div className="rounded-lg border border-greenfit-primary/30 bg-greenfit-primary/10 px-4 py-2.5 text-sm text-greenfit-primary">
          {avisoReset}
        </div>
      )}

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

      {mostrarModalReset && (
        <ResetearRankingModal onClose={() => setMostrarModalReset(false)} onConfirmado={handleResetConfirmado} />
      )}
    </div>
  )
}

export default RankingAdmin
