import { useEffect, useState } from 'react'
import { Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { deleteExercise, fetchExercises, saveExercise } from '../../utils/routinesApi'
import { GRUPOS_MUSCULARES, colorGrupoMuscular } from '../../utils/muscleGroups'

function formVacio() {
  return { id: null, name: '', muscleGroup: GRUPOS_MUSCULARES[0], description: '', videoUrl: '' }
}

function EjerciciosLibreriaModal({ onClose }) {
  const [ejercicios, setEjercicios] = useState([])
  const [cargando, setCargando] = useState(true)
  const [form, setForm] = useState(formVacio())
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  const cargar = async () => {
    setCargando(true)
    try {
      setEjercicios(await fetchExercises())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los ejercicios.')
    } finally {
      setCargando(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar()
  }, [])

  const handleGuardar = async (event) => {
    event.preventDefault()
    if (!form.name.trim()) {
      setError('Ponele un nombre al ejercicio.')
      return
    }
    setError(null)
    setGuardando(true)
    try {
      await saveExercise(form)
      setForm(formVacio())
      await cargar()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el ejercicio.')
    } finally {
      setGuardando(false)
    }
  }

  const handleEditar = (ejercicio) => {
    setForm({
      id: ejercicio.id,
      name: ejercicio.name,
      muscleGroup: ejercicio.muscle_group,
      description: ejercicio.description ?? '',
      videoUrl: ejercicio.video_url ?? '',
    })
  }

  const handleEliminar = async (id) => {
    const confirmado = window.confirm('¿Eliminar este ejercicio de la biblioteca? Ya no podrá elegirse en rutinas nuevas.')
    if (!confirmado) return
    try {
      await deleteExercise(id)
      await cargar()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'No se pudo eliminar el ejercicio.')
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto my-6 w-full max-w-2xl rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Biblioteca de ejercicios</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleGuardar} className="mb-5 grid grid-cols-1 gap-3 rounded-lg border border-white/10 bg-greenfit-dark/40 p-4 sm:grid-cols-2">
          <input
            type="text"
            placeholder="Nombre del ejercicio"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary"
          />
          <select
            value={form.muscleGroup}
            onChange={(e) => setForm((f) => ({ ...f, muscleGroup: e.target.value }))}
            className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
          >
            {GRUPOS_MUSCULARES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Video URL / GIF (opcional)"
            value={form.videoUrl}
            onChange={(e) => setForm((f) => ({ ...f, videoUrl: e.target.value }))}
            className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary sm:col-span-2"
          />
          <textarea
            rows={2}
            placeholder="Descripción / técnica (opcional)"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            className="resize-none rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary sm:col-span-2"
          />
          {error && <p className="text-sm text-red-400 sm:col-span-2">{error}</p>}
          <div className="flex gap-2 sm:col-span-2">
            <button
              type="submit"
              disabled={guardando}
              className="flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              <Plus className="h-4 w-4" />
              {form.id ? 'Guardar cambios' : 'Agregar ejercicio'}
            </button>
            {form.id && (
              <button
                type="button"
                onClick={() => setForm(formVacio())}
                className="flex min-h-[40px] items-center justify-center rounded-lg border border-white/10 px-4 text-sm text-gray-300 hover:bg-white/5"
              >
                Cancelar edición
              </button>
            )}
          </div>
        </form>

        {cargando ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando...
          </div>
        ) : ejercicios.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">Todavía no hay ejercicios cargados.</p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {ejercicios.map((ex) => {
              const color = colorGrupoMuscular(ex.muscle_group)
              return (
                <li
                  key={ex.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-greenfit-dark px-4 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${color.bg} ${color.text}`}>
                      {ex.muscle_group}
                    </span>
                    <span className="truncate text-sm text-white">{ex.name}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleEditar(ex)}
                      aria-label="Editar ejercicio"
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-white/5 hover:text-white"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEliminar(ex.id)}
                      aria-label="Eliminar ejercicio"
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

export default EjerciciosLibreriaModal
