import { useCallback, useEffect, useState } from 'react'
import { CalendarPlus, CheckCircle2, CreditCard, Loader2, RefreshCw, RotateCcw, Undo2, Zap } from 'lucide-react'
import { fetchActividadReciente, revertirXpEvento } from '../utils/fichaSocioPwa'
import { supabase } from '../lib/supabaseClient'

const ICONOS_POR_TIPO = {
  reserva: { Icon: CalendarPlus, color: 'text-gray-400' },
  asistencia_clase: { Icon: CheckCircle2, color: 'text-greenfit-primary' },
  checkin_musculacion: { Icon: Zap, color: 'text-greenfit-primary' },
  reversion: { Icon: Undo2, color: 'text-amber-400' },
  pago_mercado_pago: { Icon: CreditCard, color: 'text-greenfit-primary' },
}

// Polling cada 30s (sin websockets) como base -- suficiente para un panel
// de staff que queda abierto en el mostrador durante el día. Sumado a una
// suscripción Realtime sobre pagos_socio (ver más abajo) para que una
// compra por Mercado Pago aparezca al instante mientras Seba ya tiene el
// Dashboard abierto, sin esperar hasta 30s -- exactamente el caso que este
// comentario ya anticipaba en una ronda anterior ("si más adelante hace
// falta verdadero push, esto es candidato a Supabase Realtime").
const INTERVALO_REFRESCO_MS = 30_000

function formatHora(iso) {
  return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
}

function formatRelativo(iso) {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (diffMin < 1) return 'ahora'
  if (diffMin < 60) return `hace ${diffMin} min`
  const diffHoras = Math.floor(diffMin / 60)
  if (diffHoras < 24) return `hace ${diffHoras} h`
  return formatHora(iso)
}

// Panel del Dashboard: stream cronológico de Reservas creadas, Check-ins de
// Musculación y Asistencias confirmadas a clases (+ sus Reversiones), con
// acción de "Revertir" sobre cualquier evento que haya otorgado XP.
function ActividadReciente() {
  const [items, setItems] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [revirtiendoId, setRevirtiendoId] = useState(null)

  const cargar = useCallback(async () => {
    try {
      setItems(await fetchActividadReciente(20))
      setError(null)
    } catch (err) {
      setError(err.message ?? 'No se pudo cargar la actividad reciente.')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    // Patrón estándar de fetch-on-mount + polling (mismo criterio que
    // Socios.jsx/Home.jsx); la regla experimental set-state-in-effect no
    // distingue este caso del anti-patrón que persigue.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar()
    const intervalId = setInterval(cargar, INTERVALO_REFRESCO_MS)
    return () => clearInterval(intervalId)
  }, [cargar])

  // Refresco instantáneo cuando el webhook de Mercado Pago inserta una
  // compra nueva en pagos_socio -- mismo patrón ya probado en el HomeScreen
  // de la PWA (suscripción a user_credits): el evento de Realtime no valida
  // RLS por sí solo, así que no se confía en el payload crudo, se usa solo
  // como disparador para volver a pedir la actividad real vía `cargar()`.
  useEffect(() => {
    const channel = supabase
      .channel('actividad-reciente-pagos-mp')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pagos_socio' }, () => {
        cargar()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [cargar])

  const handleRevertir = async (item) => {
    if (!window.confirm(`¿Revertir "${item.detalle}" de ${item.socioNombre}? Se le van a descontar ${item.xpAmount} XP.`)) {
      return
    }
    setRevirtiendoId(item.xpEventId)
    try {
      await revertirXpEvento(item.xpEventId)
      await cargar()
    } catch (err) {
      window.alert(err.message ?? 'No se pudo revertir el evento.')
    } finally {
      setRevirtiendoId(null)
    }
  }

  return (
    <div className="rounded-xl border border-white/5 bg-greenfit-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">Actividad Reciente</h3>
        <button
          type="button"
          onClick={cargar}
          aria-label="Actualizar actividad reciente"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
        >
          {cargando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      </div>

      {error ? (
        <p className="py-6 text-center text-sm text-red-400">{error}</p>
      ) : cargando && items.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando actividad...
        </div>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400">Todavía no hay actividad registrada.</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {items.map((item) => {
            const { Icon, color } = ICONOS_POR_TIPO[item.tipo] ?? ICONOS_POR_TIPO.reserva
            const puedeRevertir = item.xpEventId && !item.revertido
            return (
              <li key={item.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <Icon className={`h-4 w-4 shrink-0 ${color}`} />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white">
                      <span className="font-medium">{item.socioNombre}</span> — {item.detalle}
                    </p>
                    <p className="text-xs text-gray-500">{formatRelativo(item.fecha)}</p>
                  </div>
                </div>
                {item.revertido ? (
                  <span className="shrink-0 text-xs font-medium text-gray-500">Revertido</span>
                ) : puedeRevertir ? (
                  <button
                    type="button"
                    onClick={() => handleRevertir(item)}
                    disabled={revirtiendoId === item.xpEventId}
                    title="Revertir este evento de XP"
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {revirtiendoId === item.xpEventId ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    Revertir
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default ActividadReciente
