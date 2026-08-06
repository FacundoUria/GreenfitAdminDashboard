import { useEffect, useState } from 'react'
import { ClipboardList, Copy, Dumbbell, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { deleteRoutine, duplicateRoutine, fetchRoutinesList } from '../../utils/routinesApi'
import RutinaEditorModal from './RutinaEditorModal'
import EjerciciosLibreriaModal from './EjerciciosLibreriaModal'

function BibliotecaRutinas() {
  const [plantillas, setPlantillas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [editorAbierto, setEditorAbierto] = useState(false)
  const [rutinaEnEdicion, setRutinaEnEdicion] = useState(null)
  const [libreriaAbierta, setLibreriaAbierta] = useState(false)

  const cargar = async () => {
    setCargando(true)
    setError(null)
    try {
      setPlantillas(await fetchRoutinesList({ isTemplate: true }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las plantillas.')
    } finally {
      setCargando(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar()
  }, [])

  const handleNueva = () => {
    setRutinaEnEdicion(null)
    setEditorAbierto(true)
  }

  const handleEditar = (id) => {
    setRutinaEnEdicion(id)
    setEditorAbierto(true)
  }

  const handleDuplicar = async (plantilla) => {
    try {
      await duplicateRoutine(plantilla.id, { title: `${plantilla.title} (copia)`, isTemplate: true })
      await cargar()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'No se pudo duplicar la plantilla.')
    }
  }

  const handleEliminar = async (id) => {
    const confirmado = window.confirm('¿Eliminar esta plantilla? Esta acción no se puede deshacer.')
    if (!confirmado) return
    try {
      await deleteRoutine(id)
      await cargar()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'No se pudo eliminar la plantilla.')
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-400">
          Plantillas base reutilizables -- se pueden asignar (duplicándolas) a cualquier socio desde la pestaña
          "Asignación a Socios".
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setLibreriaAbierta(true)}
            className="flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-white/10 px-4 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
          >
            <Dumbbell className="h-4 w-4" />
            Ejercicios
          </button>
          <button
            type="button"
            onClick={handleNueva}
            className="flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Nueva plantilla
          </button>
        </div>
      </div>

      {cargando ? (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-greenfit-card p-10 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Cargando plantillas...
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center text-sm text-red-400">{error}</div>
      ) : plantillas.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/10 bg-greenfit-card p-10 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-greenfit-primary/15">
            <ClipboardList className="h-6 w-6 text-greenfit-primary" />
          </div>
          <p className="text-sm font-semibold text-white">Tu cajón de rutinas base</p>
          <p className="max-w-sm text-sm text-gray-400">
            Armá rutinas generales acá (ej. "Adaptación 4 días") y asignalas rápido a tus socios desde su perfil.
          </p>
          <button
            type="button"
            onClick={handleNueva}
            className="mt-1 flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Crear la primera plantilla
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {plantillas.map((p) => (
            <div key={p.id} className="flex flex-col gap-3 rounded-xl border border-white/5 bg-greenfit-card p-5">
              <div>
                <p className="text-sm font-semibold text-white">{p.title}</p>
              </div>
              <div className="mt-auto flex items-center gap-2 border-t border-white/5 pt-3">
                <button
                  type="button"
                  onClick={() => handleEditar(p.id)}
                  className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Editar
                </button>
                <button
                  type="button"
                  onClick={() => handleDuplicar(p)}
                  aria-label="Duplicar"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleEliminar(p.id)}
                  aria-label="Eliminar"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 text-red-400 transition-colors hover:bg-red-500/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editorAbierto && (
        <RutinaEditorModal
          key={rutinaEnEdicion ?? 'nueva'}
          routineId={rutinaEnEdicion}
          socioPreset={null}
          onClose={() => setEditorAbierto(false)}
          onSaved={() => {
            setEditorAbierto(false)
            cargar()
          }}
        />
      )}

      {libreriaAbierta && <EjerciciosLibreriaModal onClose={() => setLibreriaAbierta(false)} />}
    </div>
  )
}

export default BibliotecaRutinas
