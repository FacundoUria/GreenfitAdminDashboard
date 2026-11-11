import { AlertTriangle, RefreshCw } from 'lucide-react'
import { formatFecha } from '../utils/fecha'
import { formatearPlanes } from '../utils/planes'

// T5 -- cartel "Pendientes de cargar" arriba de la tabla de Socios.
// Socios que pagaron sin cuenta en la app, ya tienen cuenta y en la app no
// tienen nada vigente (admin_socios_pendientes_de_cargar). Desde T5 nadie les
// copia la ficha solo: Seba les carga los créditos desde Editar Socio →
// Créditos.
//
// `estado`: { cargando, error, lista }. R5: si la consulta falla se muestra
// en rojo con el motivo y "Reintentar" -- nunca una lista vacía en silencio.
// `mostrarLista`: true cuando el filtro "Pendientes de cargar" está activo;
// ahí se lista cada socio con lo que dice su ficha (lo que se cobró), porque
// al cargarle los créditos la fecha de la ficha se reemplaza por la del plan
// nuevo (hoy + 30): Seba la tiene que ver ANTES para ajustar la fecha.
function PendientesDeCargarAviso({ estado, mostrarLista, onVer, onOcultar, onCargar, onReintentar }) {
  if (!estado || estado.cargando) return null

  if (estado.error) {
    return (
      <div
        role="alert"
        data-testid="pendientes-de-cargar-error"
        className="flex flex-col gap-2 rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300 sm:flex-row sm:items-center sm:justify-between"
      >
        <p>No se pudo calcular &quot;Pagos sin cargar en la app&quot;: {estado.error}</p>
        <button
          type="button"
          onClick={onReintentar}
          className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/10"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Reintentar
        </button>
      </div>
    )
  }

  const lista = estado.lista ?? []
  if (lista.length === 0) return null

  // Texto de "Pagos sin cargar en la app" (antes "Pendientes de cargar: N
  // socios pagaron sin cuenta y ya tienen cuenta", que no se entendía).
  const uno = lista.length === 1
  const quien = uno ? `${`${lista[0].nombre} ${lista[0].apellido}`.trim()} pagó` : `${lista.length} socios pagaron`

  return (
    <div data-testid="pendientes-de-cargar" className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 text-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2 text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p>
            <span className="font-semibold">Pagos sin cargar en la app:</span> {quien} cuando todavía no
            tenía{uno ? '' : 'n'} cuenta en la app. Ya se registr{uno ? 'ó' : 'aron'}, pero en la app no le{uno ? '' : 's'} figura
            lo que pag{uno ? 'ó' : 'aron'}. Tocá «Cargar créditos» en cada uno.
          </p>
        </div>
        <button
          type="button"
          onClick={mostrarLista ? onOcultar : onVer}
          className="min-h-[44px] shrink-0 rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-400/10"
        >
          {mostrarLista ? 'Ver todos los socios' : 'Ver quiénes'}
        </button>
      </div>

      {mostrarLista && (
        <ul className="mt-3 flex flex-col gap-2" aria-label="Pagos sin cargar en la app">
          {lista.map((p) => (
            <li
              key={p.socioId}
              className="flex flex-col gap-2 rounded-lg bg-white/5 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 text-gray-200">
                <p className="font-medium text-white">
                  {`${p.nombre} ${p.apellido}`.trim()} <span className="text-xs text-gray-400">DNI {p.dni}</span>
                </p>
                <p className="text-xs text-gray-400">
                  Lo que pagó: {formatearPlanes(p.plan)} · {p.creditosFicha} créditos · hasta el {formatFecha(p.fechaVencimientoFicha)} ·
                  pagó el {formatFecha(p.ultimoPago)}
                </p>
                <p className="text-xs text-amber-300">
                  Al cargar, la fecha queda en hoy + 30 días. Si pagó hasta el {formatFecha(p.fechaVencimientoFicha)}, cambiala a esa
                  fecha.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onCargar(p)}
                className="min-h-[44px] shrink-0 rounded-lg bg-greenfit-primary px-4 py-2 text-xs font-semibold text-greenfit-dark hover:opacity-90"
              >
                Cargar créditos
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default PendientesDeCargarAviso
