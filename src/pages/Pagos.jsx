import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Receipt, RefreshCw, X, XCircle } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { formatMoneda } from '../utils/moneda'
import { aprobarComprobante, fetchComprobantesPendientes, rechazarComprobante } from '../utils/pagosSocio'

function formatFechaHora(iso) {
  const fecha = new Date(iso)
  if (Number.isNaN(fecha.getTime())) return '-'
  return fecha.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
}

function Toast({ message }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg bg-greenfit-card px-4 py-3 shadow-xl ring-1 ring-white/10">
      <CheckCircle2 className="h-5 w-5 text-greenfit-primary" />
      <span className="text-sm font-medium text-white">{message}</span>
    </div>
  )
}

// Overlay simple de imagen ampliada -- no había ningún lightbox en el
// proyecto todavía, mismo criterio visual (fixed inset-0 z-50 bg-black/60)
// que ya usan los modales existentes (CheckInRapidoModal, etc.).
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

// Fase 3: revisión manual de comprobantes de transferencia -- lista lo que
// el socio sube desde la PWA (Fase 2, estado='pendiente' en pagos_socio) y
// deja aprobar (acredita créditos reales vía admin_aprobar_comprobante) o
// descartar (admin_rechazar_comprobante, no acredita ni notifica).
function Pagos() {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [procesandoId, setProcesandoId] = useState(null)
  const [erroresPorId, setErroresPorId] = useState(new Map())
  const [imagenAmpliada, setImagenAmpliada] = useState(null)
  const [toastMessage, setToastMessage] = useState(null)

  const mostrarToast = (mensaje) => {
    setToastMessage(mensaje)
    setTimeout(() => setToastMessage(null), 2500)
  }

  const cargar = useCallback(async () => {
    try {
      setFilas(await fetchComprobantesPendientes())
      setError(null)
    } catch (err) {
      setError(err.message ?? 'No se pudieron cargar los comprobantes pendientes.')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar()
  }, [cargar])

  // Refresco en vivo -- mismo patrón que ActividadReciente.jsx: un socio
  // subiendo un comprobante nuevo (INSERT), u otra pestaña de Seba
  // aprobando/rechazando uno (UPDATE de estado), actualiza esta lista sin
  // que haga falta recargar la página. El payload crudo del evento no se
  // usa directo (no valida RLS por sí solo) -- solo dispara `cargar()`.
  useEffect(() => {
    const channel = supabase
      .channel('pagos-pendientes-transferencia')
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

  const handleAprobar = async (fila) => {
    const detalleCreditos = fila.creditosTexto
      ? `Se le van a otorgar los créditos de "${fila.pack?.name ?? fila.paquete}": ${fila.creditosTexto}.`
      : `Se le va a otorgar el pack "${fila.pack?.name ?? fila.paquete}".`
    const confirmado = window.confirm(
      `¿Aprobar el comprobante de ${fila.socioNombre}?\n\n${detalleCreditos}\nMonto: ${formatMoneda(fila.monto)}.`,
    )
    if (!confirmado) return

    setProcesandoId(fila.id)
    setErrorFila(fila.id, null)
    try {
      const { creditoOtorgado } = await aprobarComprobante(fila.id)
      if (!creditoOtorgado) {
        // Ya estaba revisado (reviewed_at no es null) -- otra pestaña/otro
        // admin se adelantó. No es un error de verdad, pero tampoco hay
        // nada para festejar -- se avisa y se refresca la lista real.
        window.alert('Este comprobante ya había sido revisado antes (probablemente desde otra pestaña). La lista se va a actualizar.')
        await cargar()
        return
      }
      setFilas((prev) => prev.filter((f) => f.id !== fila.id))
      mostrarToast(`Comprobante aprobado -- créditos acreditados a ${fila.socioNombre}.`)
    } catch (err) {
      setErrorFila(fila.id, err.message ?? 'No se pudo aprobar el comprobante.')
    } finally {
      setProcesandoId(null)
    }
  }

  const handleRechazar = async (fila) => {
    const confirmado = window.confirm(
      `¿Descartar el comprobante de ${fila.socioNombre}?\n\nNo se le va a acreditar nada y esta acción no notifica al socio -- si hace falta avisarle, hacelo aparte (WhatsApp/Anunciar).`,
    )
    if (!confirmado) return

    setProcesandoId(fila.id)
    setErrorFila(fila.id, null)
    try {
      await rechazarComprobante(fila.id)
      setFilas((prev) => prev.filter((f) => f.id !== fila.id))
      mostrarToast(`Comprobante de ${fila.socioNombre} descartado.`)
    } catch (err) {
      setErrorFila(fila.id, err.message ?? 'No se pudo descartar el comprobante.')
    } finally {
      setProcesandoId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Pagos</h2>
          <p className="text-sm text-gray-400">Comprobantes de transferencia pendientes de revisión.</p>
        </div>
        <button
          type="button"
          onClick={cargar}
          aria-label="Actualizar comprobantes pendientes"
          className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
        >
          {cargando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Actualizar
        </button>
      </div>

      {error ? (
        <p className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">{error}</p>
      ) : cargando && filas.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-white/5 bg-greenfit-card py-12 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando comprobantes...
        </div>
      ) : filas.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-white/5 bg-greenfit-card py-12 text-center text-sm text-gray-400">
          <Receipt className="h-8 w-8 text-gray-600" />
          No hay comprobantes pendientes de revisión.
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
                  <p className="font-semibold text-white">{fila.socioNombre}</p>
                  <p className="text-sm text-gray-300">
                    {fila.pack?.name ?? fila.paquete} · {formatMoneda(fila.monto)}
                  </p>
                  {fila.creditosTexto && <p className="text-xs text-gray-500">{fila.creditosTexto}</p>}
                  <p className="mt-1 text-xs text-gray-500">{formatFechaHora(fila.fecha)}</p>
                  {errorFila && <p className="mt-2 text-xs font-medium text-red-400">{errorFila}</p>}
                </div>

                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => handleRechazar(fila)}
                    disabled={procesando}
                    className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-gray-300 transition-colors hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {procesando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                    Descartar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAprobar(fila)}
                    disabled={procesando}
                    className="flex min-h-[40px] items-center gap-1.5 rounded-lg bg-greenfit-primary px-3 py-2 text-xs font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {procesando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    Aprobar
                  </button>
                </div>
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
