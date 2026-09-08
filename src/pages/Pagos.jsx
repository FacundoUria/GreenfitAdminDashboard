import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Receipt, RefreshCw, RotateCcw, X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { formatMoneda } from '../utils/moneda'
import { formatFechaHora } from '../utils/fecha'
import { fetchHistorialComprobantes, revertirComprobante } from '../utils/pagosSocio'

function Toast({ message }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg bg-greenfit-card px-4 py-3 shadow-xl ring-1 ring-white/10">
      <CheckCircle2 className="h-5 w-5 text-greenfit-primary" />
      <span className="text-sm font-medium text-white">{message}</span>
    </div>
  )
}

// Banner de advertencia persistente (NO un toast que desaparece solo) --
// pedido explícito: si la reversión trae aviso de que la fecha de Aparatos
// no se pudo restaurar automática, tiene que verse bien visible, no como un
// detalle chico. Se cierra a mano, no con un timeout.
function BannerAdvertencia({ message, onCerrar }) {
  if (!message) return null
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
      <p className="flex-1">{message}</p>
      <button
        type="button"
        onClick={onCerrar}
        aria-label="Cerrar advertencia"
        className="shrink-0 rounded-lg p-1 text-amber-300 hover:bg-amber-500/10 hover:text-amber-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

function ImagenAmpliada({ url, onCerrar }) {
  if (!url) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Comprobante ampliado"
      onClick={onCerrar}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
    >
      <button
        type="button"
        onClick={onCerrar}
        aria-label="Cerrar"
        className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-lg text-gray-300 hover:bg-white/10 hover:text-white"
      >
        <X className="h-6 w-6" />
      </button>
      <img
        src={url}
        alt="Comprobante de pago ampliado"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
      />
    </div>
  )
}

function EstadoBadge({ estado }) {
  if (estado === 'anulado') {
    return (
      <span className="inline-flex w-fit items-center rounded-full bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-400">
        Anulado
      </span>
    )
  }
  return (
    <span className="inline-flex w-fit items-center rounded-full bg-greenfit-primary/10 px-2.5 py-1 text-[11px] font-semibold text-greenfit-primary">
      Pagado
    </span>
  )
}

// Fase 3: los comprobantes se acreditan AUTOMÁTICO al subirse desde la PWA
// -- ya no hay "pendientes por aprobar". Esto es un HISTORIAL (pagado/
// anulado) con la posibilidad de revertir una acreditación ya hecha.
function Pagos() {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [procesandoId, setProcesandoId] = useState(null)
  const [erroresPorId, setErroresPorId] = useState(new Map())
  const [imagenAmpliada, setImagenAmpliada] = useState(null)
  const [toastMessage, setToastMessage] = useState(null)
  const [advertencia, setAdvertencia] = useState(null)

  const mostrarToast = (mensaje) => {
    setToastMessage(mensaje)
    setTimeout(() => setToastMessage(null), 2500)
  }

  const cargar = useCallback(async () => {
    try {
      setFilas(await fetchHistorialComprobantes())
      setError(null)
    } catch (err) {
      setError(err.message ?? 'No se pudo cargar el historial de comprobantes.')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar()
  }, [cargar])

  // Refresco en vivo -- un socio subiendo un comprobante nuevo (ya se
  // acredita solo), u otro admin revirtiendo uno desde otra pestaña,
  // actualiza esta lista sin recargar la página.
  useEffect(() => {
    const channel = supabase
      .channel('pagos-comprobantes-transferencia')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pagos_socio' }, () => {
        cargar()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [cargar])

  const setErrorFila = (id, mensaje) => {
    setErroresPorId((prev) => {
      const siguiente = new Map(prev)
      if (mensaje) siguiente.set(id, mensaje)
      else siguiente.delete(id)
      return siguiente
    })
  }

  const handleRevertir = async (fila) => {
    const detalle = fila.detalleRevertidoTexto
      ? `Se le va a quitar: ${fila.detalleRevertidoTexto}.`
      : 'No se encontró el detalle de qué se le otorgó -- puede que este pago sea de antes de este cambio y no se pueda revertir automático.'
    const confirmado = window.confirm(
      `¿Revertir la acreditación del comprobante de ${fila.socioNombre}?\n\n${detalle}\n\nLo que el socio ya haya usado (clases reservadas) no se recupera -- solo se quita lo que le queda sin usar. Esta acción no se puede deshacer.`,
    )
    if (!confirmado) return

    setProcesandoId(fila.id)
    setErrorFila(fila.id, null)
    setAdvertencia(null)
    try {
      const { revertido, aparatosAdvertencia } = await revertirComprobante(fila.id)
      if (!revertido) {
        window.alert('Este comprobante ya había sido revertido antes (probablemente desde otra pestaña). La lista se va a actualizar.')
        await cargar()
        return
      }
      if (aparatosAdvertencia) {
        // Bien visible -- banner persistente, no un toast que se va solo.
        setAdvertencia(`${fila.socioNombre}: ${aparatosAdvertencia}`)
      } else {
        mostrarToast(`Acreditación revertida -- se le quitó lo que quedaba sin usar a ${fila.socioNombre}.`)
      }
      await cargar()
    } catch (err) {
      setErrorFila(fila.id, err.message ?? 'No se pudo revertir esta acreditación.')
    } finally {
      setProcesandoId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Pagos</h2>
          <p className="text-sm text-gray-400">
            Historial de comprobantes de transferencia -- se acreditan automático al subirse. Revertí uno si hace
            falta corregirlo.
          </p>
        </div>
        <button
          type="button"
          onClick={cargar}
          aria-label="Actualizar historial de comprobantes"
          className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
        >
          {cargando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Actualizar
        </button>
      </div>

      <BannerAdvertencia message={advertencia} onCerrar={() => setAdvertencia(null)} />

      {error ? (
        <p className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">{error}</p>
      ) : cargando && filas.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-white/5 bg-greenfit-card py-12 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando comprobantes...
        </div>
      ) : filas.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-white/5 bg-greenfit-card py-12 text-center text-sm text-gray-400">
          <Receipt className="h-8 w-8 text-gray-600" />
          Todavía no hay comprobantes en el historial.
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {filas.map((fila) => {
            const procesando = procesandoId === fila.id
            const errorFila = erroresPorId.get(fila.id)
            return (
              <li key={fila.id} className="flex flex-col gap-4 rounded-xl border border-white/5 bg-greenfit-card p-4 sm:flex-row sm:items-start">
                <button
                  type="button"
                  onClick={() => fila.comprobanteUrl && setImagenAmpliada(fila.comprobanteUrl)}
                  disabled={!fila.comprobanteUrl}
                  className="h-28 w-28 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-black/20 disabled:cursor-default"
                >
                  {fila.comprobanteUrl ? (
                    <img src={fila.comprobanteUrl} alt={`Comprobante de ${fila.socioNombre}`} className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-center text-[11px] text-gray-500">
                      Sin imagen disponible
                    </span>
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-white">{fila.socioNombre}</p>
                    <EstadoBadge estado={fila.estado} />
                  </div>
                  <p className="text-sm text-gray-300">
                    {fila.pack?.name ?? fila.paquete} · {formatMoneda(fila.monto)}
                  </p>
                  {fila.creditosTexto && <p className="text-xs text-gray-500">{fila.creditosTexto}</p>}
                  <p className="mt-1 text-xs text-gray-500">
                    {fila.estado === 'anulado' && fila.revertidoEl
                      ? `Revertido ${formatFechaHora(fila.revertidoEl)} · subido ${formatFechaHora(fila.fecha)}`
                      : formatFechaHora(fila.fecha)}
                  </p>
                  {errorFila && <p className="mt-2 text-xs font-medium text-red-400">{errorFila}</p>}
                </div>

                {fila.estado === 'pagado' && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => handleRevertir(fila)}
                      disabled={procesando}
                      className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-gray-300 transition-colors hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {procesando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      Revertir
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <ImagenAmpliada url={imagenAmpliada} onCerrar={() => setImagenAmpliada(null)} />
      {toastMessage && <Toast message={toastMessage} />}
    </div>
  )
}

export default Pagos
