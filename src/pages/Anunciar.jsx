import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, Megaphone, Send, X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { buscarSociosParaCheckin } from '../utils/fichaSocioPwa'

const AUDIENCIAS = [
  { value: 'all', label: 'Todos los socios' },
  { value: 'debtors', label: 'Deudores (créditos en 0)' },
  { value: 'class', label: 'Anotados en una clase' },
  { value: 'user', label: 'Un socio puntual' },
]

function formatFecha(iso) {
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function iniciales(nombre) {
  const partes = (nombre ?? '?').trim().split(/\s+/)
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase()
  return `${partes[0][0]}${partes[partes.length - 1][0]}`.toUpperCase()
}

function Anunciar() {
  const [titulo, setTitulo] = useState('')
  const [mensaje, setMensaje] = useState('')
  const [audiencia, setAudiencia] = useState('all')
  const [clases, setClases] = useState([])
  const [claseId, setClaseId] = useState('')
  // Autocomplete de socios (reemplaza al viejo input rígido de DNI) --
  // reusa buscarSociosParaCheckin (mismo buscador que ya usa el modal de
  // Check-in Rápido del Navbar) para no duplicar la query de nombre/DNI.
  const [busquedaSocio, setBusquedaSocio] = useState('')
  const [resultadosSocio, setResultadosSocio] = useState([])
  const [buscandoSocio, setBuscandoSocio] = useState(false)
  const [socioSeleccionado, setSocioSeleccionado] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [error, setError] = useState(null)
  const [historial, setHistorial] = useState([])
  const [cargandoHistorial, setCargandoHistorial] = useState(true)

  useEffect(() => {
    supabase
      .from('classes')
      .select('id, title, start_time')
      .order('start_time', { ascending: true })
      .then(({ data }) => setClases(data ?? []))
  }, [])

  const fetchHistorial = async () => {
    setCargandoHistorial(true)
    const { data } = await supabase
      .from('notifications')
      .select('id, title, body, audience_type, created_at')
      .order('created_at', { ascending: false })
      .limit(10)
    setHistorial(data ?? [])
    setCargandoHistorial(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchHistorial()
  }, [])

  // Búsqueda con debounce -- se corta apenas hay un socio seleccionado (no
  // tiene sentido seguir buscando con el dropdown ya resuelto).
  useEffect(() => {
    if (socioSeleccionado || !busquedaSocio.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResultadosSocio([])
      return
    }
    setBuscandoSocio(true)
    const timeoutId = setTimeout(async () => {
      try {
        setResultadosSocio(await buscarSociosParaCheckin(busquedaSocio))
      } catch (err) {
        console.error('Error al buscar socios:', err.message)
        setResultadosSocio([])
      } finally {
        setBuscandoSocio(false)
      }
    }, 350)
    return () => clearTimeout(timeoutId)
  }, [busquedaSocio, socioSeleccionado])

  const handleSeleccionarSocio = (socio) => {
    setSocioSeleccionado(socio)
    setBusquedaSocio('')
    setResultadosSocio([])
  }

  const handleQuitarSocio = () => setSocioSeleccionado(null)

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError(null)
    setResultado(null)

    if (!titulo.trim() || !mensaje.trim()) {
      setError('Completá título y mensaje.')
      return
    }
    if (audiencia === 'class' && !claseId) {
      setError('Elegí una clase.')
      return
    }
    if (audiencia === 'user' && !socioSeleccionado) {
      setError('Buscá y seleccioná un socio.')
      return
    }

    setEnviando(true)
    try {
      const { data, error: fnError } = await supabase.functions.invoke('send-push', {
        body: {
          title: titulo.trim(),
          body: mensaje.trim(),
          audience: audiencia,
          targetClassId: audiencia === 'class' ? claseId : undefined,
          // El autocomplete ya resolvió el user_id exacto al seleccionar --
          // a diferencia del viejo flujo (DNI de texto libre + búsqueda
          // recién al enviar), acá no hay margen para un DNI mal tipeado o
          // ambiguo.
          targetUserId: audiencia === 'user' ? socioSeleccionado.userId : undefined,
        },
      })

      if (fnError) {
        setError(fnError.message ?? 'No se pudo enviar el anuncio.')
        setEnviando(false)
        return
      }

      setResultado({ ...data, audienciaEnviada: audiencia })
      setTitulo('')
      setMensaje('')
      setSocioSeleccionado(null)
      fetchHistorial()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar el anuncio.')
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl bg-greenfit-card p-5 sm:p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-greenfit-primary/15">
            <Megaphone className="h-5 w-5 text-greenfit-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Anunciar</h2>
            <p className="text-sm text-gray-400">Mandá una notificación push a los socios, aunque tengan la app cerrada.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="audiencia" className="text-xs font-medium text-gray-400">
              Audiencia
            </label>
            <select
              id="audiencia"
              value={audiencia}
              onChange={(event) => setAudiencia(event.target.value)}
              className="min-h-[44px] rounded-lg border border-white/10 bg-greenfit-dark px-3 text-sm text-white outline-none focus:border-greenfit-primary"
            >
              {AUDIENCIAS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>

          {audiencia === 'class' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="clase" className="text-xs font-medium text-gray-400">
                Clase
              </label>
              <select
                id="clase"
                value={claseId}
                onChange={(event) => setClaseId(event.target.value)}
                className="min-h-[44px] rounded-lg border border-white/10 bg-greenfit-dark px-3 text-sm text-white outline-none focus:border-greenfit-primary"
              >
                <option value="">Elegí una clase...</option>
                {clases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} · {(c.start_time ?? '').slice(0, 5)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {audiencia === 'user' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-400">Socio</label>
              {socioSeleccionado ? (
                <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-greenfit-primary/15 text-xs font-semibold text-greenfit-primary">
                    {iniciales(socioSeleccionado.nombre)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{socioSeleccionado.nombre}</p>
                    <p className="text-xs text-gray-500">DNI {socioSeleccionado.dni ?? '—'}</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleQuitarSocio}
                    aria-label="Cambiar socio"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <input
                    type="text"
                    value={busquedaSocio}
                    onChange={(event) => setBusquedaSocio(event.target.value)}
                    placeholder="Buscar por nombre, apellido o DNI..."
                    aria-label="Buscar socio"
                    autoComplete="off"
                    className="min-h-[44px] w-full rounded-lg border border-white/10 bg-greenfit-dark px-3 text-sm text-white outline-none focus:border-greenfit-primary"
                  />
                  {busquedaSocio.trim() && (
                    <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-white/10 bg-greenfit-dark shadow-xl">
                      {buscandoSocio ? (
                        <li className="px-3 py-2.5 text-xs text-gray-500">Buscando...</li>
                      ) : resultadosSocio.length === 0 ? (
                        <li className="px-3 py-2.5 text-xs text-gray-500">Sin resultados.</li>
                      ) : (
                        resultadosSocio.map((socio) => (
                          <li key={socio.userId}>
                            <button
                              type="button"
                              onClick={() => handleSeleccionarSocio(socio)}
                              className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-white/5"
                            >
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-greenfit-primary/15 text-xs font-semibold text-greenfit-primary">
                                {iniciales(socio.nombre)}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm text-white">{socio.nombre}</p>
                                <p className="text-xs text-gray-500">DNI {socio.dni ?? '—'}</p>
                              </div>
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-400">Título</label>
            <input
              type="text"
              value={titulo}
              onChange={(event) => setTitulo(event.target.value)}
              placeholder="Ej: ¡Clase de mañana reprogramada!"
              maxLength={80}
              className="min-h-[44px] rounded-lg border border-white/10 bg-greenfit-dark px-3 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-400">Mensaje</label>
            <textarea
              value={mensaje}
              onChange={(event) => setMensaje(event.target.value)}
              placeholder="Escribí el anuncio..."
              rows={4}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          {resultado && resultado.audienciaEnviada === 'user' && resultado.enviados === 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>El socio existe pero aún no ha activado las notificaciones push en su dispositivo.</span>
            </div>
          ) : (
            resultado && (
              <p className="text-sm text-greenfit-primary">
                Anuncio enviado a {resultado.destinatarios} socio(s) · {resultado.enviados} push entregados
                {resultado.expirados > 0 ? ` · ${resultado.expirados} suscripciones vencidas se limpiaron` : ''}
                {resultado.errores?.length > 0 ? ` · ${resultado.errores.length} error(es)` : ''}
              </p>
            )
          )}

          <button
            type="submit"
            disabled={enviando}
            className="flex min-h-[44px] items-center justify-center gap-2 self-start rounded-lg bg-greenfit-primary px-5 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {enviando ? 'Enviando...' : 'Enviar anuncio'}
          </button>
        </form>
      </div>

      <div className="rounded-xl bg-greenfit-card p-5 sm:p-6">
        <h3 className="mb-4 text-base font-semibold text-white">Últimos anuncios</h3>
        {cargandoHistorial ? (
          <div className="flex items-center gap-2 py-6 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando...
          </div>
        ) : historial.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">Todavía no enviaste ningún anuncio.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {historial.map((n) => (
              <li key={n.id} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-white">{n.title}</p>
                  <span className="shrink-0 text-xs text-gray-500">{formatFecha(n.created_at)}</span>
                </div>
                <p className="mt-1 text-sm text-gray-400">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default Anunciar
