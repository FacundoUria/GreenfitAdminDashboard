import { useEffect, useState } from 'react'
import { Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import {
  CODIGO_EJERCICIO_EN_USO,
  deleteExercise,
  fetchExercises,
  fetchUsoEjercicios,
  saveExercise,
} from '../../utils/routinesApi'
import { GRUPOS_MUSCULARES, colorGrupoMuscular } from '../../utils/muscleGroups'
import { estaEnUso, textoNoSePuedeBorrar, textoUsoCorto } from '../../utils/usoEjercicios'

function formVacio() {
  return { id: null, name: '', muscleGroup: GRUPOS_MUSCULARES[0], description: '', videoUrl: '' }
}

function EjerciciosLibreriaModal({ onClose }) {
  const [ejercicios, setEjercicios] = useState([])
  const [cargando, setCargando] = useState(true)
  const [form, setForm] = useState(formVacio())
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  // Dónde se usa cada ejercicio (Map id -> conteos), o null si no se pudo
  // saber: en ese caso no se ofrece borrar NINGUNO (nunca se borra a ciegas).
  const [uso, setUso] = useState(null)
  const [errorUso, setErrorUso] = useState(null)
  // Resultado de borrar (o por qué no se pudo), visible arriba de la lista.
  const [aviso, setAviso] = useState(null)

  const cargar = async () => {
    setCargando(true)
    const [lista, conteos] = await Promise.allSettled([fetchExercises(), fetchUsoEjercicios()])
    if (lista.status === 'fulfilled') setEjercicios(lista.value)
    else setError(lista.reason instanceof Error ? lista.reason.message : 'No se pudieron cargar los ejercicios.')
    if (conteos.status === 'fulfilled') {
      setUso(conteos.value)
      setErrorUso(null)
    } else {
      setUso(null)
      setErrorUso(conteos.reason instanceof Error ? conteos.reason.message : 'error desconocido')
    }
    setCargando(false)
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

  // Antes de borrar se vuelve a preguntar dónde se usa (la lista pudo quedar
  // vieja). La base igual rechaza borrar uno en uso (23503): si pasa, se avisa.
  const handleEliminar = async (ejercicio) => {
    setAviso(null)
    let usoActual
    try {
      usoActual = (await fetchUsoEjercicios([ejercicio.id])).get(ejercicio.id)
    } catch (err) {
      setAviso({
        tipo: 'error',
        texto: `No se pudo verificar si "${ejercicio.name}" está en uso, así que no se borró. ${err instanceof Error ? err.message : ''}`.trim(),
      })
      return
    }
    if (!usoActual) {
      setAviso({ tipo: 'error', texto: `"${ejercicio.name}" ya no está en la biblioteca.` })
      await cargar()
      return
    }
    if (estaEnUso(usoActual)) {
      setAviso({ tipo: 'error', texto: `"${ejercicio.name}": ${textoNoSePuedeBorrar(usoActual)}` })
      await cargar()
      return
    }

    const confirmado = window.confirm(
      `¿Borrar "${ejercicio.name}" de la biblioteca? No lo usa ninguna rutina ni plantilla, y no tiene pesos cargados. No se puede deshacer.`,
    )
    if (!confirmado) return
    try {
      await deleteExercise(ejercicio.id)
      setAviso({ tipo: 'ok', texto: `Se borró "${ejercicio.name}".` })
      await cargar()
    } catch (err) {
      if (err?.code === CODIGO_EJERCICIO_EN_USO) {
        setAviso({
          tipo: 'error',
          texto: `No se puede borrar "${ejercicio.name}": se empezó a usar mientras tanto. Actualizamos la lista.`,
        })
        await cargar()
      } else {
        setAviso({
          tipo: 'error',
          texto: `No se pudo borrar "${ejercicio.name}": ${err instanceof Error ? err.message : 'error desconocido'}`,
        })
      }
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

        <p className="mb-4 text-sm text-gray-400">
          Agregá los ejercicios que usás siempre para no tener que escribirlos de cero cada vez.
        </p>

        <form onSubmit={handleGuardar} className="mb-6 grid grid-cols-1 gap-3 rounded-lg border border-white/10 bg-greenfit-dark/40 p-4 sm:grid-cols-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 sm:col-span-2">
            {form.id ? 'Editar ejercicio' : 'Nuevo ejercicio'}
          </p>
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

        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Tu biblioteca{ejercicios.length > 0 ? ` (${ejercicios.length})` : ''}
        </p>

        {errorUso && (
          <p role="alert" className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
            No se pudo saber dónde se usa cada ejercicio, así que por ahora no se puede borrar ninguno. ({errorUso})
          </p>
        )}
        {aviso && (
          <p
            role={aviso.tipo === 'error' ? 'alert' : 'status'}
            className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
              aviso.tipo === 'error'
                ? 'border-red-500/30 bg-red-500/10 text-red-300'
                : 'border-greenfit-primary/30 bg-greenfit-primary/10 text-greenfit-primary'
            }`}
          >
            {aviso.texto}
          </p>
        )}

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
              const usoEjercicio = uso?.get(ex.id)
              const enUso = estaEnUso(usoEjercicio)
              // Solo se ofrece borrar si se sabe que NO está en uso.
              const sePuedeBorrar = uso !== null && !enUso
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
                    {enUso && (
                      <span className="shrink-0 text-[11px] text-gray-500">{textoUsoCorto(usoEjercicio)}</span>
                    )}
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
                    {sePuedeBorrar && (
                      <button
                        type="button"
                        onClick={() => handleEliminar(ex)}
                        aria-label={`Eliminar ${ex.name}`}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-red-500/10 hover:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
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
