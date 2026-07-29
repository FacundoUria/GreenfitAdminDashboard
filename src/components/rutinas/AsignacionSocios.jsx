import { useEffect, useState } from 'react'
import { Loader2, Pencil, Plus, Search, User } from 'lucide-react'
import {
  duplicateRoutine,
  fetchRoutinesList,
  fetchSocioActiveRoutine,
  searchSocios,
} from '../../utils/routinesApi'
import RutinaEditorModal from './RutinaEditorModal'

function AsignacionSocios() {
  const [busqueda, setBusqueda] = useState('')
  const [resultados, setResultados] = useState([])
  const [buscando, setBuscando] = useState(false)
  const [socioSeleccionado, setSocioSeleccionado] = useState(null)
  const [rutinaSocio, setRutinaSocio] = useState(null)
  const [cargandoRutina, setCargandoRutina] = useState(false)
  const [plantillas, setPlantillas] = useState([])
  const [asignando, setAsignando] = useState(false)
  const [editorAbierto, setEditorAbierto] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchRoutinesList({ isTemplate: true }).then(setPlantillas).catch(() => {})
  }, [])

  useEffect(() => {
    if (!busqueda.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResultados([])
      return
    }
    setBuscando(true)
    const timeout = setTimeout(() => {
      searchSocios(busqueda)
        .then(setResultados)
        .catch(() => setResultados([]))
        .finally(() => setBuscando(false))
    }, 300)
    return () => clearTimeout(timeout)
  }, [busqueda])

  const handleElegirSocio = async (socio) => {
    setSocioSeleccionado(socio)
    setResultados([])
    setBusqueda('')
    setCargandoRutina(true)
    setError(null)
    try {
      setRutinaSocio(await fetchSocioActiveRoutine(socio.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar la rutina del socio.')
    } finally {
      setCargandoRutina(false)
    }
  }

  const handleAsignarPlantilla = async (event) => {
    const plantillaId = event.target.value
    if (!plantillaId || !socioSeleccionado) return
    setAsignando(true)
    setError(null)
    try {
      await duplicateRoutine(plantillaId, {
        userId: socioSeleccionado.id,
        isTemplate: false,
      })
      setRutinaSocio(await fetchSocioActiveRoutine(socioSeleccionado.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo asignar la plantilla.')
    } finally {
      setAsignando(false)
      event.target.value = ''
    }
  }

  const totalEjercicios = (rutina) => rutina?.days.reduce((acc, d) => acc + d.exercises.length, 0) ?? 0

  return (
    <div className="flex flex-col gap-5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
        <input
          type="text"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar socio por nombre o DNI..."
          className="min-h-[44px] w-full rounded-lg border border-white/10 bg-greenfit-card py-2.5 pl-10 pr-3 text-sm text-white outline-none placeholder:text-gray-500 focus:border-greenfit-primary"
        />
        {(buscando || resultados.length > 0) && (
          <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-white/10 bg-greenfit-card shadow-xl">
            {buscando ? (
              <div className="flex items-center gap-2 px-4 py-3 text-sm text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Buscando...
              </div>
            ) : (
              resultados.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleElegirSocio(s)}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-gray-200 hover:bg-white/5"
                >
                  <User className="h-4 w-4 text-gray-500" />
                  <span>{s.full_name}</span>
                  {s.dni && <span className="text-xs text-gray-500">DNI {s.dni}</span>}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {!socioSeleccionado ? (
        <div className="rounded-xl border border-white/5 bg-greenfit-card p-10 text-center text-sm text-gray-400">
          Buscá un socio para ver o asignarle una rutina.
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-greenfit-card p-5 sm:p-6">
          <div className="mb-5 flex flex-col gap-3 border-b border-white/5 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-base font-semibold text-white">{socioSeleccionado.full_name}</p>
              <p className="text-xs text-gray-400">DNI {socioSeleccionado.dni}</p>
            </div>
            <select
              onChange={handleAsignarPlantilla}
              disabled={asignando || plantillas.length === 0}
              defaultValue=""
              className="min-h-[40px] rounded-lg border border-white/10 bg-greenfit-dark px-3 text-sm text-white outline-none focus:border-greenfit-primary disabled:opacity-50"
            >
              <option value="" disabled>
                {plantillas.length === 0 ? 'No hay plantillas creadas' : 'Asignar desde plantilla...'}
              </option>
              {plantillas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

          {cargandoRutina || asignando ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              {asignando ? 'Asignando...' : 'Cargando...'}
            </div>
          ) : !rutinaSocio ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <p className="text-sm text-gray-400">Este socio todavía no tiene una rutina asignada.</p>
              <button
                type="button"
                onClick={() => setEditorAbierto(true)}
                className="flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
              >
                <Plus className="h-4 w-4" />
                Crear rutina desde cero
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-white">{rutinaSocio.title}</p>
                  <p className="text-xs text-gray-400">
                    {rutinaSocio.days.length} día{rutinaSocio.days.length !== 1 ? 's' : ''} ·{' '}
                    {totalEjercicios(rutinaSocio)} ejercicios
                    {rutinaSocio.coachName ? ` · Coach: ${rutinaSocio.coachName}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditorAbierto(true)}
                  className="flex min-h-[40px] shrink-0 items-center justify-center gap-2 rounded-lg border border-white/10 px-4 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Editar
                </button>
              </div>
              <ul className="flex flex-col gap-1.5">
                {rutinaSocio.days.map((d) => (
                  <li key={d.id} className="rounded-lg bg-greenfit-dark/40 px-3 py-2 text-xs text-gray-300">
                    <span className="font-semibold text-white">{d.title}</span> — {d.exercises.length} ejercicios
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {editorAbierto && socioSeleccionado && (
        <RutinaEditorModal
          key={rutinaSocio?.id ?? 'nueva'}
          routineId={rutinaSocio?.id ?? null}
          socioPreset={socioSeleccionado}
          onClose={() => setEditorAbierto(false)}
          onSaved={async () => {
            setEditorAbierto(false)
            setCargandoRutina(true)
            try {
              setRutinaSocio(await fetchSocioActiveRoutine(socioSeleccionado.id))
            } finally {
              setCargandoRutina(false)
            }
          }}
        />
      )}
    </div>
  )
}

export default AsignacionSocios
