import { useEffect, useState } from 'react'
import { EyeOff, Loader2, Lock, X } from 'lucide-react'
import { fetchRoutineFull, fetchSesionesDeRutina } from '../../utils/routinesApi'
import { formatFecha, formatFechaHora } from '../../utils/fecha'

// Una rutina en SOLO LECTURA (la vigente o una del historial del socio): sus días y
// ejercicios, y los entrenamientos que el socio registró en ella ("Finalizar
// Entrenamiento"), con la carga que usó en ese momento. Seba ve también los que el socio
// ocultó. No hay ningún input: una rutina del historial no se edita (la base lo rechaza).
function RutinaDetalleModal({ routineId, onClose }) {
  const [rutina, setRutina] = useState(null)
  const [sesiones, setSesiones] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let activo = true
    Promise.all([fetchRoutineFull(routineId), fetchSesionesDeRutina(routineId)])
      .then(([r, s]) => {
        if (!activo) return
        setRutina(r)
        setSesiones(s)
      })
      .catch((err) => {
        if (activo) setError(err instanceof Error ? err.message : 'No se pudo cargar la rutina.')
      })
      .finally(() => {
        if (activo) setCargando(false)
      })
    return () => {
      activo = false
    }
  }, [routineId])

  const esAnterior = !!rutina?.vigenteHasta

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4" role="dialog" aria-label="Detalle de la rutina">
      <div className="mx-auto my-6 w-full max-w-3xl rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white">{rutina?.title ?? 'Rutina'}</h2>
            {rutina && (
              <p className="mt-0.5 text-xs text-gray-400">
                {esAnterior
                  ? `Del ${formatFecha(rutina.vigenteDesde)} al ${formatFecha(rutina.vigenteHasta)}`
                  : rutina.vigenteDesde
                    ? `Vigente desde el ${formatFecha(rutina.vigenteDesde)}`
                    : 'Plantilla'}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {cargando ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando...
          </div>
        ) : error ? (
          <p className="py-8 text-center text-sm text-red-400">{error}</p>
        ) : (
          <div className="flex flex-col gap-5">
            {esAnterior && (
              <p className="flex items-center gap-2 rounded-lg border border-white/10 bg-greenfit-dark/40 px-3 py-2 text-xs text-gray-400">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                Rutina del historial: solo lectura. Para usarla de nuevo, "Volver a asignar".
              </p>
            )}
            {rutina.notes && <p className="text-sm text-gray-300">{rutina.notes}</p>}

            {rutina.days.map((dia) => (
              <div key={dia.id} className="rounded-xl border border-white/10 bg-greenfit-dark/40 p-4">
                <p className="mb-3 text-sm font-semibold text-white">{dia.title}</p>
                <ul className="flex flex-col gap-2">
                  {dia.exercises.map((e) => (
                    <li key={e.id} className="flex flex-col gap-0.5 rounded-lg bg-greenfit-card px-3 py-2">
                      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
                        <span className="text-sm text-gray-200">
                          {e.exerciseName}
                          {e.muscleGroup && <span className="ml-2 text-xs text-gray-500">{e.muscleGroup}</span>}
                        </span>
                        <span className="text-xs text-gray-400">
                          {[
                            `${e.sets || '-'} × ${e.reps || '-'}`,
                            e.restSeconds ? `${e.restSeconds} s` : null,
                            e.weightSuggestion ? `Carga sugerida ${e.weightSuggestion}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                      {e.notes && <span className="text-xs text-gray-500">{e.notes}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Entrenamientos registrados en esta rutina ({sesiones.length})
              </p>
              {sesiones.length === 0 ? (
                <p className="text-sm text-gray-500">Todavía no hay entrenamientos registrados en esta rutina.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {sesiones.map((s) => (
                    <li key={s.sesionId} className="rounded-lg border border-white/5 bg-greenfit-dark/40 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-white">{formatFechaHora(s.creadoEn)}</span>
                        {s.tituloDia && <span className="text-gray-400">{s.tituloDia}</span>}
                        <span className="text-gray-500">
                          {s.ejercicios.length} de {s.totalEjercicios} ejercicios
                        </span>
                        {s.oculta && (
                          <span className="flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-400">
                            <EyeOff className="h-3 w-3" />
                            Oculto por el socio
                          </span>
                        )}
                      </div>
                      <ul className="mt-1.5 flex flex-col gap-0.5">
                        {s.ejercicios.map((e) => (
                          <li key={e.id} className="flex justify-between gap-3 text-xs text-gray-300">
                            <span>{e.nombre}</span>
                            <span className="text-gray-400">
                              {`${e.series ?? '-'} × ${e.repeticiones || '-'}`} · {e.peso || 'sin carga'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default RutinaDetalleModal
