import { useEffect, useState } from 'react'
import { Loader2, Megaphone, Send } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'

const AUDIENCIAS = [
  { value: 'all', label: 'Todos los socios' },
  { value: 'debtors', label: 'Deudores (créditos en 0)' },
  { value: 'class', label: 'Anotados en una clase' },
  { value: 'user', label: 'Un socio puntual (por DNI)' },
]

function formatFecha(iso) {
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function Anunciar() {
  const [titulo, setTitulo] = useState('')
  const [mensaje, setMensaje] = useState('')
  const [audiencia, setAudiencia] = useState('all')
  const [clases, setClases] = useState([])
  const [claseId, setClaseId] = useState('')
  const [dni, setDni] = useState('')
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
    if (audiencia === 'user' && !dni.trim()) {
      setError('Ingresá el DNI del socio.')
      return
    }

    setEnviando(true)
    try {
      let targetUserId = null
      if (audiencia === 'user') {
        const { data: candidatos, error: buscarError } = await supabase
          .from('profiles')
          .select('id')
          .eq('role', 'socio')
          .eq('dni', dni.trim())
          .limit(1)
        if (buscarError || !candidatos || candidatos.length === 0) {
          setError('No se encontró ningún socio con ese DNI (o todavía no tiene cuenta creada en la app).')
          setEnviando(false)
          return
        }
        targetUserId = candidatos[0].id
      }

      const { data, error: fnError } = await supabase.functions.invoke('send-push', {
        body: {
          title: titulo.trim(),
          body: mensaje.trim(),
          audience: audiencia,
          targetClassId: audiencia === 'class' ? claseId : undefined,
          targetUserId: audiencia === 'user' ? targetUserId : undefined,
        },
      })

      if (fnError) {
        setError(fnError.message ?? 'No se pudo enviar el anuncio.')
        setEnviando(false)
        return
      }

      setResultado(data)
      setTitulo('')
      setMensaje('')
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
            <label className="text-xs font-medium text-gray-400">Audiencia</label>
            <select
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
              <label className="text-xs font-medium text-gray-400">Clase</label>
              <select
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
              <label className="text-xs font-medium text-gray-400">DNI del socio</label>
              <input
                type="text"
                value={dni}
                onChange={(event) => setDni(event.target.value)}
                placeholder="Ej: 40123456"
                className="min-h-[44px] rounded-lg border border-white/10 bg-greenfit-dark px-3 text-sm text-white outline-none focus:border-greenfit-primary"
              />
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

          {resultado && (
            <p className="text-sm text-greenfit-primary">
              Anuncio enviado a {resultado.destinatarios} socio(s) · {resultado.enviados} push entregados
              {resultado.expirados > 0 ? ` · ${resultado.expirados} suscripciones vencidas se limpiaron` : ''}
              {resultado.errores?.length > 0 ? ` · ${resultado.errores.length} error(es)` : ''}
            </p>
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
