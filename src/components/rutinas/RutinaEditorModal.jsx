import { useEffect, useState } from 'react'
import { Loader2, Plus, Save, Trash2, X } from 'lucide-react'
import { fetchExercises, fetchRoutineFull, saveRoutineFull } from '../../utils/routinesApi'
import { GRUPOS_MUSCULARES } from '../../utils/muscleGroups'

function bloqueVacio() {
  return {
    exerciseId: null,
    exerciseName: '',
    muscleGroup: GRUPOS_MUSCULARES[0],
    exerciseDescription: '',
    exerciseVideoUrl: '',
    sets: 3,
    reps: '10-12',
    restSeconds: 60,
    weightSuggestion: '',
    notes: '',
  }
}

function diaVacio(numero) {
  return { title: `Día ${numero}`, exercises: [bloqueVacio()] }
}

function RutinaEditorModal({ routineId, socioPreset, onClose, onSaved }) {
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [ejerciciosDisponibles, setEjerciciosDisponibles] = useState([])

  const [titulo, setTitulo] = useState('')
  const [notas, setNotas] = useState('')
  const [esPlantilla, setEsPlantilla] = useState(!socioPreset)
  const [dias, setDias] = useState([diaVacio(1)])

  useEffect(() => {
    let activo = true
    async function cargar() {
      try {
        const disponibles = await fetchExercises()
        if (!activo) return
        setEjerciciosDisponibles(disponibles)

        if (routineId) {
          const rutina = await fetchRoutineFull(routineId)
          if (!activo) return
          setTitulo(rutina.title)
          setNotas(rutina.notes)
          setEsPlantilla(rutina.isTemplate)
          setDias(
            rutina.days.length > 0
              ? rutina.days.map((d) => ({
                  title: d.title,
                  exercises: d.exercises.map((e) => ({ ...e })),
                }))
              : [diaVacio(1)],
          )
        }
      } catch (err) {
        if (activo) setError(err instanceof Error ? err.message : 'No se pudo cargar la rutina.')
      } finally {
        if (activo) setCargando(false)
      }
    }
    cargar()
    return () => {
      activo = false
    }
  }, [routineId])

  const handleAgregarDia = () => setDias((prev) => [...prev, diaVacio(prev.length + 1)])
  const handleEliminarDia = (dayIdx) => setDias((prev) => prev.filter((_, i) => i !== dayIdx))
  const handleCambiarTituloDia = (dayIdx, value) =>
    setDias((prev) => prev.map((d, i) => (i === dayIdx ? { ...d, title: value } : d)))

  const handleAgregarBloque = (dayIdx) =>
    setDias((prev) => prev.map((d, i) => (i === dayIdx ? { ...d, exercises: [...d.exercises, bloqueVacio()] } : d)))

  const handleEliminarBloque = (dayIdx, exIdx) =>
    setDias((prev) =>
      prev.map((d, i) => (i === dayIdx ? { ...d, exercises: d.exercises.filter((_, j) => j !== exIdx) } : d)),
    )

  const handleCambiarBloque = (dayIdx, exIdx, field, value) =>
    setDias((prev) =>
      prev.map((d, i) =>
        i === dayIdx
          ? { ...d, exercises: d.exercises.map((e, j) => (j === exIdx ? { ...e, [field]: value } : e)) }
          : d,
      ),
    )

  // Elegir un ejercicio existente de la biblioteca precarga sus datos de
  // referencia (grupo muscular, descripción, video) -- el admin puede
  // seguir ajustando series/reps/carga/notas propias de este bloque.
  const handleElegirExistente = (dayIdx, exIdx, exerciseId) => {
    if (!exerciseId) {
      handleCambiarBloque(dayIdx, exIdx, 'exerciseId', null)
      return
    }
    const ejercicio = ejerciciosDisponibles.find((e) => e.id === exerciseId)
    setDias((prev) =>
      prev.map((d, i) =>
        i === dayIdx
          ? {
              ...d,
              exercises: d.exercises.map((e, j) =>
                j === exIdx
                  ? {
                      ...e,
                      exerciseId,
                      exerciseName: ejercicio.name,
                      muscleGroup: ejercicio.muscle_group,
                      exerciseDescription: ejercicio.description ?? '',
                      exerciseVideoUrl: ejercicio.video_url ?? '',
                    }
                  : e,
              ),
            }
          : d,
      ),
    )
  }

  const handleGuardar = async () => {
    setError(null)
    if (!titulo.trim()) {
      setError('Ponele un nombre a la rutina.')
      return
    }
    if (dias.length === 0) {
      setError('Agregá al menos un día.')
      return
    }
    for (const dia of dias) {
      for (const bloque of dia.exercises) {
        if (!bloque.exerciseName?.trim()) {
          setError(`Completá el nombre del ejercicio en "${dia.title}".`)
          return
        }
      }
    }

    setGuardando(true)
    try {
      await saveRoutineFull({
        id: routineId ?? null,
        title: titulo,
        coachName: null,
        notes: notas,
        isTemplate: esPlantilla,
        userId: socioPreset?.id ?? null,
        days: dias,
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la rutina.')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto my-6 w-full max-w-3xl rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            {routineId ? 'Editar rutina' : esPlantilla ? 'Nueva plantilla' : `Nueva rutina para ${socioPreset?.full_name ?? 'socio'}`}
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

        {cargando ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando...
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <label className="text-xs font-medium text-gray-400">Nombre de la rutina / Objetivo</label>
                <input
                  type="text"
                  value={titulo}
                  onChange={(e) => setTitulo(e.target.value)}
                  placeholder="Ej: Rutina Fuerza 4 días"
                  className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary"
                />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <label className="text-xs font-medium text-gray-400">Notas generales</label>
                <input
                  type="text"
                  value={notas}
                  onChange={(e) => setNotas(e.target.value)}
                  placeholder="Opcional"
                  className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary"
                />
              </div>
            </div>

            {!socioPreset && (
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={esPlantilla}
                  onChange={(e) => setEsPlantilla(e.target.checked)}
                  className="accent-greenfit-primary"
                />
                Guardar como plantilla base (no asignada a ningún socio)
              </label>
            )}

            <div className="flex flex-col gap-4">
              {dias.map((dia, dayIdx) => (
                <div key={dayIdx} className="rounded-lg border border-white/10 bg-greenfit-dark/40 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="shrink-0 rounded-md bg-greenfit-primary/15 px-2 py-1 text-xs font-bold text-greenfit-primary">
                      Día {dayIdx + 1}
                    </span>
                    <input
                      type="text"
                      value={dia.title}
                      onChange={(e) => handleCambiarTituloDia(dayIdx, e.target.value)}
                      placeholder="Ej: Pecho y Espalda"
                      className="min-w-0 flex-1 rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
                    />
                    {dias.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleEliminarDia(dayIdx)}
                        aria-label="Eliminar día"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-red-500/10 hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-3">
                    {dia.exercises.map((bloque, exIdx) => (
                      <div key={exIdx} className="rounded-lg border border-white/10 bg-greenfit-card p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-xs font-semibold text-gray-400">Ejercicio #{exIdx + 1}</span>
                          <button
                            type="button"
                            onClick={() => handleEliminarBloque(dayIdx, exIdx)}
                            aria-label="Eliminar ejercicio"
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-red-500/10 hover:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                          <div className="flex flex-col gap-1 sm:col-span-2">
                            <label className="text-[11px] font-medium text-gray-500">Ejercicio de la biblioteca (o escribí uno nuevo)</label>
                            <select
                              value={bloque.exerciseId ?? ''}
                              onChange={(e) => handleElegirExistente(dayIdx, exIdx, e.target.value || null)}
                              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
                            >
                              <option value="">+ Ejercicio nuevo</option>
                              {ejerciciosDisponibles.map((ex) => (
                                <option key={ex.id} value={ex.id}>
                                  {ex.name} ({ex.muscle_group})
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="flex flex-col gap-1">
                            <label className="text-[11px] font-medium text-gray-500">Nombre</label>
                            <input
                              type="text"
                              value={bloque.exerciseName}
                              disabled={!!bloque.exerciseId}
                              onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'exerciseName', e.target.value)}
                              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary disabled:opacity-50"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[11px] font-medium text-gray-500">Grupo muscular</label>
                            <select
                              value={bloque.muscleGroup}
                              disabled={!!bloque.exerciseId}
                              onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'muscleGroup', e.target.value)}
                              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary disabled:opacity-50"
                            >
                              {GRUPOS_MUSCULARES.map((g) => (
                                <option key={g} value={g}>
                                  {g}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="flex flex-col gap-1">
                            <label className="text-[11px] font-medium text-gray-500">Series</label>
                            <input
                              type="number"
                              min="1"
                              value={bloque.sets}
                              onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'sets', e.target.value)}
                              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[11px] font-medium text-gray-500">Repeticiones</label>
                            <input
                              type="text"
                              value={bloque.reps}
                              placeholder="Ej: 10-12"
                              onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'reps', e.target.value)}
                              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[11px] font-medium text-gray-500">Carga / Peso sugerido</label>
                            <input
                              type="text"
                              value={bloque.weightSuggestion}
                              placeholder="Ej: 20kg"
                              onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'weightSuggestion', e.target.value)}
                              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[11px] font-medium text-gray-500">Descanso (seg)</label>
                            <input
                              type="number"
                              min="0"
                              value={bloque.restSeconds}
                              onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'restSeconds', e.target.value)}
                              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
                            />
                          </div>

                          <div className="flex flex-col gap-1 sm:col-span-2">
                            <label className="text-[11px] font-medium text-gray-500">Notas de técnica / instrucciones</label>
                            <textarea
                              rows={2}
                              value={bloque.notes}
                              onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'notes', e.target.value)}
                              className="resize-none rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
                            />
                          </div>
                          {!bloque.exerciseId && (
                            <div className="flex flex-col gap-1 sm:col-span-2">
                              <label className="text-[11px] font-medium text-gray-500">Video URL / GIF (opcional)</label>
                              <input
                                type="text"
                                value={bloque.exerciseVideoUrl}
                                placeholder="https://..."
                                onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'exerciseVideoUrl', e.target.value)}
                                className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary"
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    ))}

                    <button
                      type="button"
                      onClick={() => handleAgregarBloque(dayIdx)}
                      className="flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 text-xs font-medium text-gray-400 transition-colors hover:border-greenfit-primary hover:text-greenfit-primary"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Agregar ejercicio
                    </button>
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={handleAgregarDia}
                className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 text-sm font-medium text-gray-300 transition-colors hover:border-greenfit-primary hover:text-greenfit-primary"
              >
                <Plus className="h-4 w-4" />
                Agregar día
              </button>
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={onClose}
                className="flex min-h-[44px] items-center justify-center rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleGuardar}
                disabled={guardando}
                className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {guardando ? 'Guardando...' : 'Guardar rutina'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default RutinaEditorModal
