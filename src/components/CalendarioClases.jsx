import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import {
  DIAS_ADELANTE,
  fetchPrimeraReserva,
  fetchResumenMes,
  mesDe,
  nombreMes,
  numeroDiaISO,
  semanasDelMes,
  sumarDiasISO,
  sumarMeses,
} from '../utils/calendarioClases'

const ENCABEZADO = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do']

// "Ver calendario" de la pantalla Clases: un mes con la cantidad de
// INSCRIPTOS (reservas activas) de cada día y una marca en los días con
// alguna clase cancelada. Se navega hacia atrás hasta el mes de la primera
// reserva y hacia adelante hasta el último día de la tira (hoy + 6). Tocar
// un día lo abre en el panel de siempre (onElegirDia).
function CalendarioClases({ hoy, fechaSeleccionada, onElegirDia, onCerrar }) {
  const [mes, setMes] = useState(() => mesDe(fechaSeleccionada ?? hoy))
  const [resumen, setResumen] = useState({ mes: null, inscriptosPorDia: new Map(), diasConCancelacion: new Set() })
  const [error, setError] = useState(null)
  const [primeraReserva, setPrimeraReserva] = useState(undefined) // undefined = cargando
  const [errorPrimera, setErrorPrimera] = useState(false)
  // Solo la respuesta del ÚLTIMO pedido escribe en pantalla.
  const pedido = useRef(0)

  const cargarMes = useCallback(async (mesPedido) => {
    const estePedido = ++pedido.current
    setError(null)
    try {
      const datos = await fetchResumenMes(mesPedido)
      if (estePedido !== pedido.current) return
      setResumen({ mes: mesPedido, ...datos })
    } catch (err) {
      if (estePedido !== pedido.current) return
      console.error('Error al cargar el calendario de inscriptos:', err.message)
      setError('No se pudieron cargar los inscriptos de este mes. Verificá la conexión con Supabase.')
    }
  }, [])

  const cargarPrimeraReserva = useCallback(async () => {
    setErrorPrimera(false)
    try {
      setPrimeraReserva(await fetchPrimeraReserva())
    } catch (err) {
      console.error('Error al buscar la primera reserva:', err.message)
      setPrimeraReserva(null)
      setErrorPrimera(true)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarMes(mes)
  }, [cargarMes, mes])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarPrimeraReserva()
  }, [cargarPrimeraReserva])

  // Sin reservas, el mínimo es el mes actual; si no se pudo averiguar, no se limita.
  const mesMinimo = errorPrimera ? null : primeraReserva ? mesDe(primeraReserva) : mesDe(hoy)
  const mesMaximo = mesDe(sumarDiasISO(hoy, DIAS_ADELANTE))
  const puedeRetroceder = primeraReserva !== undefined && (mesMinimo === null || mes > mesMinimo)
  const puedeAvanzar = mes < mesMaximo
  const cargando = resumen.mes !== mes && !error
  const nombre = nombreMes(mes)

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Calendario de inscriptos">
      <div className="mx-auto my-6 w-full max-w-lg rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Calendario de inscriptos</h2>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar calendario"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setMes(sumarMeses(mes, -1))}
            disabled={!puedeRetroceder}
            aria-label="Mes anterior"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-300 transition-colors enabled:hover:bg-white/5 disabled:opacity-30"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <p className="text-base font-semibold text-white">{nombre}</p>
          <button
            type="button"
            onClick={() => setMes(sumarMeses(mes, 1))}
            disabled={!puedeAvanzar}
            aria-label="Mes siguiente"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-300 transition-colors enabled:hover:bg-white/5 disabled:opacity-30"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {errorPrimera && (
          <p className="mb-2 text-xs text-amber-300">
            No se pudo averiguar la primera reserva: el calendario no limita hasta qué mes se puede ir para atrás.{' '}
            <button type="button" onClick={cargarPrimeraReserva} className="underline">
              Reintentar
            </button>
          </p>
        )}

        {error ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center text-sm text-red-400">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => cargarMes(mes)}
              className="rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10"
            >
              Reintentar
            </button>
          </div>
        ) : cargando ? (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando inscriptos...
          </div>
        ) : (
          <table className="w-full table-fixed border-separate border-spacing-1">
            <thead>
              <tr>
                {ENCABEZADO.map((d) => (
                  <th key={d} scope="col" className="text-[11px] font-medium text-gray-500">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {semanasDelMes(mes).map((semana, i) => (
                <tr key={i}>
                  {semana.map((fecha, j) => {
                    if (!fecha) return <td key={`vacio-${j}`} />
                    const inscriptos = resumen.inscriptosPorDia.get(fecha) ?? 0
                    const conCancelacion = resumen.diasConCancelacion.has(fecha)
                    const esHoy = fecha === hoy
                    const elegido = fecha === fechaSeleccionada
                    const dia = numeroDiaISO(fecha)
                    const etiqueta = `${dia} de ${nombre}: ${inscriptos} ${inscriptos === 1 ? 'inscripto' : 'inscriptos'}${
                      conCancelacion ? ', con clase cancelada' : ''
                    }`
                    return (
                      <td key={fecha}>
                        <button
                          type="button"
                          onClick={() => onElegirDia(fecha)}
                          aria-label={etiqueta}
                          title={etiqueta}
                          data-fecha={fecha}
                          className={`relative flex h-14 w-full flex-col items-center justify-center rounded-lg text-xs transition-colors ${
                            elegido
                              ? 'bg-greenfit-primary text-greenfit-dark'
                              : `bg-white/5 text-gray-300 hover:bg-white/10 ${esHoy ? 'ring-2 ring-greenfit-primary' : ''}`
                          }`}
                        >
                          <span className="font-semibold">{dia}</span>
                          <span className={inscriptos > 0 ? 'font-bold' : 'opacity-40'}>{inscriptos}</span>
                          {conCancelacion && (
                            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
                          )}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-gray-500">
          Número = inscriptos (reservas activas).
          <span className="ml-2 inline-block h-2 w-2 rounded-full bg-red-500" aria-hidden="true" /> alguna clase cancelada.
        </p>
      </div>
    </div>
  )
}

export default CalendarioClases
