import { useEffect, useState } from 'react'
import { Loader2, Printer } from 'lucide-react'
import { formatFecha } from '../utils/fecha'
import {
  resolverUserIdPorDni,
  fetchHistorialAsistencias,
  fetchHistorialRutinas,
  fetchMetricasGamificacion,
  fetchHistorialPagos,
} from '../utils/fichaSocioPwa'

// Sección "Historial y Actividad del Socio" de la Ficha 360° -- vive abajo
// de los datos editables en NuevoSocioModal.jsx (solo en modo edición, un
// socio recién creado todavía no tiene nada que mostrar acá). Todo lo que
// muestra sale del schema REAL de la PWA (profiles/bookings/xp_events/
// routines + la nueva pagos_socio), resuelto por DNI -- ver fichaSocioPwa.js.

const SECCIONES = [
  { key: 'pagos', label: '💳 Pagos' },
  { key: 'asistencias', label: '📅 Asistencias' },
  { key: 'rutinas', label: '🏋️ Rutinas' },
  { key: 'metricas', label: '⚡ Métricas' },
]

const ESTADO_PAGO_STYLES = {
  pagado: 'bg-greenfit-primary/15 text-greenfit-primary',
  pendiente: 'bg-amber-500/15 text-amber-400',
  anulado: 'bg-red-500/15 text-red-400',
}

const METODO_PAGO_LABELS = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  tarjeta: 'Tarjeta',
  mercado_pago: 'Mercado Pago',
  otro: 'Otro',
}

function formatMonto(monto) {
  if (monto == null) return '—'
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(monto)
}

// Abre una ventana aparte con una tabla simple e imprimible -- self-contained
// (no depende de CSS de impresión global tocando el resto del panel). Sin
// `export`: react-refresh exige que un archivo de componente solo exporte
// componentes, así que queda como función interna del módulo.
function imprimirHistorialPagos(socio, pagos) {
  const filas = pagos
    .map(
      (p) => `<tr>
        <td>${formatFecha(p.fecha)}</td>
        <td>${p.paquete}</td>
        <td>${formatMonto(p.monto)}</td>
        <td>${METODO_PAGO_LABELS[p.metodoPago] ?? '—'}</td>
        <td>${p.periodoDesde ? `${formatFecha(p.periodoDesde)} - ${formatFecha(p.periodoHasta)}` : '—'}</td>
        <td>${p.estado}</td>
      </tr>`,
    )
    .join('')

  const ventana = window.open('', '_blank', 'width=800,height=600')
  if (!ventana) {
    window.alert('El navegador bloqueó la ventana de impresión. Habilitá los pop-ups para este sitio.')
    return
  }
  ventana.document.write(`
    <html>
      <head>
        <title>Historial de pagos -- ${socio.nombre} ${socio.apellido}</title>
        <style>
          body { font-family: sans-serif; padding: 24px; color: #111; }
          h1 { font-size: 18px; margin-bottom: 4px; }
          p { color: #555; font-size: 13px; margin: 0 0 12px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 13px; }
          th { background: #f2f2f2; }
        </style>
      </head>
      <body>
        <h1>Historial de pagos</h1>
        <p>${socio.nombre} ${socio.apellido} -- DNI ${socio.dni ?? '—'}</p>
        <table>
          <thead>
            <tr><th>Fecha</th><th>Paquete/Membresía</th><th>Monto</th><th>Método</th><th>Período</th><th>Estado</th></tr>
          </thead>
          <tbody>${filas || '<tr><td colspan="6">Sin pagos registrados.</td></tr>'}</tbody>
        </table>
      </body>
    </html>
  `)
  ventana.document.close()
  ventana.focus()
  ventana.print()
}

function FichaSocioHistorial({ socio }) {
  const [seccion, setSeccion] = useState('pagos')
  const [userId, setUserId] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const [pagos, setPagos] = useState([])
  const [asistencias, setAsistencias] = useState([])
  const [rutinas, setRutinas] = useState([])
  const [metricas, setMetricas] = useState(null)

  useEffect(() => {
    let cancelado = false
    async function cargar() {
      setCargando(true)
      setError(null)
      try {
        const idResuelto = await resolverUserIdPorDni(socio.dni)
        if (cancelado) return
        setUserId(idResuelto)
        if (!idResuelto) {
          setCargando(false)
          return
        }
        const [pagosData, asistenciasData, rutinasData, metricasData] = await Promise.all([
          fetchHistorialPagos(idResuelto),
          fetchHistorialAsistencias(idResuelto),
          fetchHistorialRutinas(idResuelto),
          fetchMetricasGamificacion(idResuelto),
        ])
        if (cancelado) return
        setPagos(pagosData)
        setAsistencias(asistenciasData)
        setRutinas(rutinasData)
        setMetricas(metricasData)
      } catch (err) {
        if (!cancelado) setError(err.message ?? 'No se pudo cargar el historial del socio.')
      } finally {
        if (!cancelado) setCargando(false)
      }
    }
    cargar()
    return () => {
      cancelado = true
    }
  }, [socio.dni])

  return (
    <div className="sm:col-span-2 mt-2 border-t border-white/10 pt-5">
      <h3 className="mb-3 text-sm font-semibold text-white">Historial y Actividad del Socio</h3>

      {!cargando && !userId ? (
        <p className="rounded-lg border border-white/10 bg-greenfit-dark px-4 py-3 text-xs text-gray-400">
          Este socio todavía no tiene una cuenta activa en la app -- el historial de actividad se activa
          automáticamente apenas la tenga.
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {SECCIONES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSeccion(s.key)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                  seccion === s.key
                    ? 'bg-greenfit-primary text-greenfit-dark'
                    : 'bg-greenfit-dark text-gray-300 hover:bg-white/5'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {cargando ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando historial...
            </div>
          ) : error ? (
            <p className="text-sm text-red-400">{error}</p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-lg border border-white/5">
              {seccion === 'pagos' && (
                <div>
                  <div className="flex items-center justify-between border-b border-white/5 bg-greenfit-dark px-3 py-2">
                    <span className="text-xs font-medium text-gray-400">{pagos.length} pago(s) registrado(s)</span>
                    <button
                      type="button"
                      onClick={() => imprimirHistorialPagos(socio, pagos)}
                      disabled={pagos.length === 0}
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Printer className="h-3.5 w-3.5" />
                      Imprimir
                    </button>
                  </div>
                  {pagos.length === 0 ? (
                    <p className="px-3 py-4 text-xs text-gray-500">Todavía no hay pagos registrados.</p>
                  ) : (
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="text-gray-500">
                          <th className="px-3 py-2 font-medium">Fecha</th>
                          <th className="px-3 py-2 font-medium">Paquete</th>
                          <th className="px-3 py-2 font-medium">Monto</th>
                          <th className="px-3 py-2 font-medium">Método</th>
                          <th className="px-3 py-2 font-medium">Período</th>
                          <th className="px-3 py-2 font-medium">Estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagos.map((p) => (
                          <tr key={p.id} className="border-t border-white/5 text-gray-300">
                            <td className="px-3 py-2">{formatFecha(p.fecha)}</td>
                            <td className="px-3 py-2">{p.paquete}</td>
                            <td className="px-3 py-2">{formatMonto(p.monto)}</td>
                            <td className="px-3 py-2">{METODO_PAGO_LABELS[p.metodoPago] ?? '—'}</td>
                            <td className="px-3 py-2">
                              {p.periodoDesde ? `${formatFecha(p.periodoDesde)} - ${formatFecha(p.periodoHasta)}` : '—'}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                  ESTADO_PAGO_STYLES[p.estado] ?? 'bg-white/10 text-gray-300'
                                }`}
                              >
                                {p.estado}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {seccion === 'asistencias' &&
                (asistencias.length === 0 ? (
                  <p className="px-3 py-4 text-xs text-gray-500">Todavía no hay asistencias registradas.</p>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-gray-500">
                        <th className="px-3 py-2 font-medium">Fecha</th>
                        <th className="px-3 py-2 font-medium">Actividad</th>
                        <th className="px-3 py-2 font-medium">Detalle</th>
                        <th className="px-3 py-2 font-medium">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {asistencias.map((a) => (
                        <tr key={a.id} className="border-t border-white/5 text-gray-300">
                          <td className="px-3 py-2">{formatFecha(a.fecha)}</td>
                          <td className="px-3 py-2">{a.tipo}</td>
                          <td className="px-3 py-2">{a.detalle}</td>
                          <td className="px-3 py-2">{a.estado}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ))}

              {seccion === 'rutinas' &&
                (rutinas.length === 0 ? (
                  <p className="px-3 py-4 text-xs text-gray-500">Todavía no tiene rutinas asignadas.</p>
                ) : (
                  <div className="divide-y divide-white/5">
                    {rutinas.map((r) => (
                      <div key={r.id} className="flex items-center justify-between px-3 py-2.5">
                        <div>
                          <p className="text-xs font-semibold text-white">{r.titulo}</p>
                          <p className="text-[11px] text-gray-500">{r.coach ? `Coach: ${r.coach}` : 'Sin coach asignado'}</p>
                        </div>
                        <span className="text-[11px] text-gray-500">{formatFecha(r.creadaEl)}</span>
                      </div>
                    ))}
                  </div>
                ))}

              {seccion === 'metricas' && metricas && (
                <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
                  <div className="rounded-lg bg-greenfit-dark p-3 text-center">
                    <p className="text-lg font-bold text-greenfit-primary">{`N${metricas.nivel}`}</p>
                    <p className="text-[11px] text-gray-500">Nivel ({metricas.totalXp} XP)</p>
                  </div>
                  <div className="rounded-lg bg-greenfit-dark p-3 text-center">
                    <p className="text-lg font-bold text-white">{metricas.racha}</p>
                    <p className="text-[11px] text-gray-500">Racha activa (días)</p>
                  </div>
                  <div className="rounded-lg bg-greenfit-dark p-3 text-center">
                    <p className="text-lg font-bold text-white">{metricas.totalAsistencias}</p>
                    <p className="text-[11px] text-gray-500">Asistencias totales</p>
                  </div>
                  <div className="rounded-lg bg-greenfit-dark p-3 text-center">
                    <p className="text-sm font-bold text-white">
                      {metricas.miembroDesde ? formatFecha(metricas.miembroDesde) : '—'}
                    </p>
                    <p className="text-[11px] text-gray-500">Alta en la app</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default FichaSocioHistorial
