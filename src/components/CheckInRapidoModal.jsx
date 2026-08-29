import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Search, X, Zap } from 'lucide-react'
import {
  buscarSociosParaCheckin,
  buscarSociosClaseActiva,
  otorgarCheckinMusculacion,
  darPresenteClase,
  CHECKIN_YA_REGISTRADO,
} from '../utils/fichaSocioPwa'

function iniciales(nombre) {
  const partes = (nombre ?? '?').trim().split(/\s+/)
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase()
  return `${partes[0][0]}${partes[partes.length - 1][0]}`.toUpperCase()
}

// Modal buscador para el botón "Check-in Rápido ⚡" del Navbar. Dos caminos:
//  - Sin escribir nada: sugerencias automáticas de quién está inscripto en
//    una clase en curso o por arrancar (Dar Presente marca esa reserva
//    puntual como asistida -- dispara el trigger de XP con la disciplina
//    correcta, sea CrossFit, Boxeo, etc.).
//  - Escribiendo nombre/DNI: busca cualquier socio con cuenta PWA y le
//    acredita +100 XP de entreno libre de Aparatos (para el
//    socio que vino a hacer pesas, no tiene una reserva de clase que marcar).
function CheckInRapidoModal({ visible, onClose }) {
  const [busqueda, setBusqueda] = useState('')
  const [resultados, setResultados] = useState([])
  const [buscando, setBuscando] = useState(false)
  const [error, setError] = useState(null)
  // Estado por socio ('otorgando' | 'otorgado' | 'ya_registrado' | 'error')
  // -- así cada fila muestra su propio feedback sin bloquear al resto.
  const [estadoPorSocio, setEstadoPorSocio] = useState({})

  // Sugerencias inteligentes: inscriptos de la clase activa/por arrancar.
  const [sugerencias, setSugerencias] = useState([])
  const [cargandoSugerencias, setCargandoSugerencias] = useState(true)
  // Estado por BOOKING (no por socio -- en teoría un socio podría estar
  // anotado en más de un turno superpuesto).
  const [estadoPorBooking, setEstadoPorBooking] = useState({})

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
    setEstadoPorBooking({})
    setCargandoSugerencias(true)
    buscarSociosClaseActiva()
      .then((items) => setSugerencias(items))
      .catch(() => setSugerencias([]))
      .finally(() => setCargandoSugerencias(false))
  }, [visible])

  useEffect(() => {
    if (!visible || !busqueda.trim()) {
      // Sin esto, borrar la búsqueda (o cerrar y reabrir el modal con un
      // término previo todavía en estado) mientras una búsqueda anterior
      // seguía "en vuelo" dejaba `buscando` trabado en true para siempre:
      // esta rama corta ese timer/petición pero nunca limpiaba el spinner.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResultados([])
      setBuscando(false)
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

  const handleDarPresente = async (item) => {
    setEstadoPorBooking((prev) => ({ ...prev, [item.bookingId]: 'otorgando' }))
    try {
      await darPresenteClase(item.bookingId)
      setEstadoPorBooking((prev) => ({ ...prev, [item.bookingId]: 'otorgado' }))
    } catch {
      setEstadoPorBooking((prev) => ({ ...prev, [item.bookingId]: 'error' }))
    }
  }

  if (!visible) return null

  const buscandoAlgo = busqueda.trim().length > 0

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Check-in Rápido"
        className="mx-auto my-6 w-full max-w-md rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6"
      >
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
          Confirmá la asistencia del socio presente para acreditar sus +100 XP diarios de entrenamiento y registrar
          su presente.
        </p>

        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            autoFocus
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre o DNI (Aparatos)..."
            aria-label="Buscar socio"
            className="w-full rounded-lg border border-white/10 bg-greenfit-dark py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-gray-500 outline-none focus:border-greenfit-primary"
          />
        </div>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <div className="max-h-80 overflow-y-auto">
          {buscando ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Buscando...
            </div>
          ) : buscandoAlgo ? (
            resultados.length === 0 ? (
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
                          {estado === 'otorgando' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Zap className="h-3.5 w-3.5" />
                          )}
                          Otorgar
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )
          ) : cargandoSugerencias ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Buscando clases activas...
            </div>
          ) : sugerencias.length === 0 ? (
            <p className="py-6 text-center text-xs text-gray-500">
              No hay ninguna clase en curso ni por arrancar ahora. Si viene a Aparatos, buscalo por
              nombre o DNI arriba.
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Inscriptos en la clase en curso
              </p>
              <ul className="flex flex-col gap-2">
                {sugerencias.map((item) => {
                  const estado = estadoPorBooking[item.bookingId]
                  const yaRegistrado = item.yaRegistrado || estado === 'otorgado'
                  return (
                    <li
                      key={item.bookingId}
                      className="flex items-center gap-3 rounded-lg border border-white/5 bg-greenfit-dark px-3 py-2.5"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-greenfit-primary/15 text-xs font-semibold text-greenfit-primary">
                        {iniciales(item.nombre)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">{item.nombre}</p>
                        <p className="truncate text-xs text-gray-500">{item.turno}</p>
                      </div>
                      {yaRegistrado ? (
                        <span className="flex items-center gap-1 text-xs font-semibold text-greenfit-primary">
                          <CheckCircle2 className="h-4 w-4" /> Presente
                        </span>
                      ) : estado === 'error' ? (
                        <span className="text-xs font-medium text-red-400">Error</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleDarPresente(item)}
                          disabled={estado === 'otorgando'}
                          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-greenfit-primary px-3 py-2 text-xs font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
                        >
                          {estado === 'otorgando' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Zap className="h-3.5 w-3.5" />
                          )}
                          Dar Presente (+100 XP)
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default CheckInRapidoModal
