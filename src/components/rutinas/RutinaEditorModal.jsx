import { useEffect, useState } from 'react'
import { CopyPlus, Loader2, Plus, Save, Trash2, X } from 'lucide-react'
import { CODIGO_BORRARIA_REGISTRO, fetchExercises, fetchRoutineFull, saveRoutineFull } from '../../utils/routinesApi'
import { GRUPOS_MUSCULARES } from '../../utils/muscleGroups'

// Placeholders de la grilla Reps/Carga/Descanso: en itálica, más tenues y con
// "ej: ... (opcional)" para que nadie confunda un campo VACÍO con un valor
// cargado (el "20kg" de antes parecía un dato real y no se podía "borrar").
// Vaciar el campo guarda null (ver saveRoutineFull) y la app no muestra nada.
const PLACEHOLDER_REPS = 'ej: 10-12 (opcional)'
const PLACEHOLDER_CARGA = 'ej: 20kg (opcional)'
const PLACEHOLDER_DESCANSO = 'ej: 60 (opcional)'
const CLASE_PLACEHOLDER_EJEMPLO = 'placeholder:italic placeholder:text-gray-500/60'

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
  // GFR04: "Guardar cambios" borraría ejercicios con tildes del socio (su registro). El
  // servidor no guarda nada; acá se ofrece "Guardar como rutina nueva" en el mismo aviso.
  const [borrariaRegistro, setBorrariaRegistro] = useState(false)
  const [ejerciciosDisponibles, setEjerciciosDisponibles] = useState([])

  const [titulo, setTitulo] = useState('')
  const [notas, setNotas] = useState('')
  const [dias, setDias] = useState([diaVacio(1)])
  // Sin socio = plantilla (lo decide el servidor: admin_guardar_rutina). Editando la
  // rutina vigente de un socio hay dos formas de guardar: en el lugar, o como rutina nueva
  // (la actual pasa a su historial tal como estaba).
  const esPlantilla = !socioPreset
  const editandoRutinaDeSocio = !!routineId && !!socioPreset

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
          // Con sus ids: "Guardar cambios" actualiza en el lugar lo que sigue (los tildes
          // de hoy del socio no se pierden).
          setDias(
            rutina.days.length > 0
              ? rutina.days.map((d) => ({
                  id: d.id,
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

  const handleGuardar = async ({ comoNueva = false } = {}) => {
    setError(null)
    setBorrariaRegistro(false)
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

    if (
      comoNueva &&
      !window.confirm(
        `Se crea una rutina nueva para ${socioPreset?.full_name ?? 'el socio'} con estos cambios. La rutina actual pasa a su historial tal como estaba. ¿Seguir?`,
      )
    ) {
      return
    }

    setGuardando(true)
    try {
      await saveRoutineFull({
        id: routineId ?? null,
        title: titulo,
        notes: notas,
        userId: socioPreset?.id ?? null,
        days: dias,
        comoNueva,
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la rutina.')
      setBorrariaRegistro(err?.code === CODIGO_BORRARIA_REGISTRO)
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
            <div className="flex flex-col gap-4 rounded-lg border border-white/10 bg-greenfit-dark/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Información general</p>
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
            </div>

            <div className="flex flex-col gap-4">
              {dias.map((dia, dayIdx) => (
                <div key={dayIdx} className="rounded-xl border border-white/10 bg-greenfit-dark/40 p-4">
                  <div className="mb-4 flex items-center gap-3 border-b border-white/5 pb-3">
                    <span className="flex h-9 shrink-0 items-center justify-center rounded-lg bg-greenfit-primary/15 px-3 text-sm font-bold text-greenfit-primary">
                      Día {dayIdx + 1}
                    </span>
                    <input
                      type="text"
                      value={dia.title}
                      onChange={(e) => handleCambiarTituloDia(dayIdx, e.target.value)}
                      placeholder="Ej: Pecho y Espalda"
                      className="min-w-0 flex-1 rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm font-medium text-white outline-none focus:border-greenfit-primary"
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

                        <div className="flex flex-col gap-3">
                          <div className="flex flex-col gap-1">
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

                          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
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
                          </div>

                          {/* Grilla horizontal compacta: los 4 números clave del
                              bloque juntos y alineados, para leerlos de un
                              vistazo en vez de ir buscándolos entre el resto de
                              los campos descriptivos. */}
                          <div className="grid grid-cols-2 gap-2 rounded-lg bg-greenfit-dark/60 p-2.5 sm:grid-cols-4">
                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">Series</label>
                              <input
                                type="number"
                                min="1"
                                value={bloque.sets}
                                onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'sets', e.target.value)}
                                className="rounded-md border border-white/10 bg-greenfit-dark px-2 py-1.5 text-sm text-white outline-none focus:border-greenfit-primary"
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">Reps</label>
                              <input
                                type="text"
                                value={bloque.reps}
                                placeholder={PLACEHOLDER_REPS}
                                aria-label="Reps"
                                onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'reps', e.target.value)}
                                className={`rounded-md border border-white/10 bg-greenfit-dark px-2 py-1.5 text-sm text-white outline-none focus:border-greenfit-primary ${CLASE_PLACEHOLDER_EJEMPLO}`}
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">Carga</label>
                              <input
                                type="text"
                                value={bloque.weightSuggestion}
                                placeholder={PLACEHOLDER_CARGA}
                                aria-label="Carga"
                                onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'weightSuggestion', e.target.value)}
                                className={`rounded-md border border-white/10 bg-greenfit-dark px-2 py-1.5 text-sm text-white outline-none focus:border-greenfit-primary ${CLASE_PLACEHOLDER_EJEMPLO}`}
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">Descanso (s)</label>
                              <input
                                type="number"
                                min="0"
                                value={bloque.restSeconds}
                                placeholder={PLACEHOLDER_DESCANSO}
                                aria-label="Descanso (s)"
                                onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'restSeconds', e.target.value)}
                                className={`rounded-md border border-white/10 bg-greenfit-dark px-2 py-1.5 text-sm text-white outline-none focus:border-greenfit-primary ${CLASE_PLACEHOLDER_EJEMPLO}`}
                              />
                            </div>
                          </div>

                          <div className="flex flex-col gap-1">
                            <label className="text-[11px] font-medium text-gray-500">Notas de técnica / instrucciones</label>
                            <textarea
                              rows={2}
                              value={bloque.notes}
                              onChange={(e) => handleCambiarBloque(dayIdx, exIdx, 'notes', e.target.value)}
                              className="resize-none rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
                            />
                          </div>
                          {!bloque.exerciseId && (
                            <div className="flex flex-col gap-1">
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

            {error &&
              (borrariaRegistro && editandoRutinaDeSocio ? (
                <div
                  role="alert"
                  className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <p className="text-sm text-amber-200">{error}</p>
                  <button
                    type="button"
                    onClick={() => handleGuardar({ comoNueva: true })}
                    disabled={guardando}
                    className="flex min-h-[40px] shrink-0 items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    <CopyPlus className="h-4 w-4" />
                    Guardar como rutina nueva
                  </button>
                </div>
              ) : (
                <p className="text-sm text-red-400">{error}</p>
              ))}

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={onClose}
                className="flex min-h-[44px] items-center justify-center rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
              >
                Cancelar
              </button>
              {editandoRutinaDeSocio && (
                <button
                  type="button"
                  onClick={() => handleGuardar({ comoNueva: true })}
                  disabled={guardando}
                  className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-greenfit-primary/40 px-4 py-2 text-sm font-medium text-greenfit-primary transition-colors hover:bg-greenfit-primary/10 disabled:opacity-60"
                >
                  <CopyPlus className="h-4 w-4" />
                  Guardar como rutina nueva
                </button>
              )}
              <button
                type="button"
                onClick={() => handleGuardar()}
                disabled={guardando}
                className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {guardando ? 'Guardando...' : editandoRutinaDeSocio ? 'Guardar cambios' : 'Guardar rutina'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default RutinaEditorModal
