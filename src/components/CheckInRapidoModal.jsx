import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Search, X, Zap } from 'lucide-react'
import { buscarSociosParaCheckin, otorgarCheckinMusculacion, CHECKIN_YA_REGISTRADO } from '../utils/fichaSocioPwa'

function iniciales(nombre) {
  const partes = (nombre ?? '?').trim().split(/\s+/)
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase()
  return `${partes[0][0]}${partes[partes.length - 1][0]}`.toUpperCase()
}

// Modal buscador para el botón "Check-in Rápido ⚡" del Navbar -- filtra
// socios (con cuenta PWA, `profiles.role='socio'`) por nombre/DNI y otorga
// +100 XP de entreno libre de Musculación con un clic, sin tener que ir a
// buscar al socio en la tabla de Socios ni abrir su ficha.
function CheckInRapidoModal({ visible, onClose }) {
  const [busqueda, setBusqueda] = useState('')
  const [resultados, setResultados] = useState([])
  const [buscando, setBuscando] = useState(false)
  const [error, setError] = useState(null)
  // Estado por socio ('otorgando' | 'otorgado' | 'ya_registrado' | 'error')
  // -- así cada fila muestra su propio feedback sin bloquear al resto.
  const [estadoPorSocio, setEstadoPorSocio] = useState({})

  useEffect(() => {
    if (!visible) return
    // Resetea el estado local cada vez que el modal se vuelve a abrir --
    // la regla experimental set-state-in-effect no distingue este caso
    // (sincronizar UI con la prop `visible`) del anti-patrón que persigue.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBusqueda('')
    setResultados([])
    setError(null)
    setEstadoPorSocio({})
  }, [visible])

  useEffect(() => {
    if (!visible || !busqueda.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResultados([])
      return
    }
    setBuscando(true)
    const timeoutId = setTimeout(async () => {
      try {
        setResultados(await buscarSociosParaCheckin(busqueda))
        setError(null)
      } catch (err) {
        setError(err.message ?? 'No se pudo buscar socios.')
      } finally {
        setBuscando(false)
      }
    }, 350)
    return () => clearTimeout(timeoutId)
  }, [busqueda, visible])

  const handleOtorgar = async (socio) => {
    setEstadoPorSocio((prev) => ({ ...prev, [socio.userId]: 'otorgando' }))
    try {
      const resultado = await otorgarCheckinMusculacion(socio.userId)
      setEstadoPorSocio((prev) => ({
        ...prev,
        [socio.userId]: resultado === CHECKIN_YA_REGISTRADO ? 'ya_registrado' : 'otorgado',
      }))
    } catch {
      setEstadoPorSocio((prev) => ({ ...prev, [socio.userId]: 'error' }))
    }
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto my-6 w-full max-w-md rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Zap className="h-5 w-5 text-greenfit-primary" />
            Check-in Rápido
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-4 text-xs text-gray-400">
          Buscá un socio y otorgale +100 XP de entreno libre de Musculación con un clic (máx. 1 vez por día).
        </p>

        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            autoFocus
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre o DNI..."
            aria-label="Buscar socio"
            className="w-full rounded-lg border border-white/10 bg-greenfit-dark py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-gray-500 outline-none focus:border-greenfit-primary"
          />
        </div>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <div className="max-h-72 overflow-y-auto">
          {buscando ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Buscando...
            </div>
          ) : !busqueda.trim() ? (
            <p className="py-6 text-center text-xs text-gray-500">Empezá a escribir para buscar un socio.</p>
          ) : resultados.length === 0 ? (
            <p className="py-6 text-center text-xs text-gray-500">Sin resultados.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {resultados.map((socio) => {
                const estado = estadoPorSocio[socio.userId]
                return (
                  <li
                    key={socio.userId}
                    className="flex items-center gap-3 rounded-lg border border-white/5 bg-greenfit-dark px-3 py-2.5"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-greenfit-primary/15 text-xs font-semibold text-greenfit-primary">
                      {iniciales(socio.nombre)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">{socio.nombre}</p>
                      <p className="text-xs text-gray-500">DNI {socio.dni ?? '—'}</p>
                    </div>
                    {estado === 'otorgado' ? (
                      <span className="flex items-center gap-1 text-xs font-semibold text-greenfit-primary">
                        <CheckCircle2 className="h-4 w-4" /> +100 XP
                      </span>
                    ) : estado === 'ya_registrado' ? (
                      <span className="text-xs font-medium text-amber-400">Ya registrado hoy</span>
                    ) : estado === 'error' ? (
                      <span className="text-xs font-medium text-red-400">Error</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleOtorgar(socio)}
                        disabled={estado === 'otorgando'}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-greenfit-primary px-3 py-2 text-xs font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
                      >
                        {estado === 'otorgando' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                        Otorgar
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

export default CheckInRapidoModal
