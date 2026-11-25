import { useEffect, useState } from 'react'
import { Loader2, Search, User } from 'lucide-react'
import { asignarRutina, fetchRoutinesList, searchSocios } from '../../utils/routinesApi'
import RutinaEditorModal from './RutinaEditorModal'
import RutinasDelSocio from './RutinasDelSocio'

// Rutinas > Asignación a Socios. La rutina actual y el historial del socio los muestra
// RutinasDelSocio (el mismo que la Ficha 360°), acá con acciones. Asignar una plantilla
// NO toca la rutina que tenía: pasa a su historial con fecha de fin (lo hace la base, en
// una transacción: admin_asignar_rutina).
function AsignacionSocios() {
  const [busqueda, setBusqueda] = useState('')
  const [resultados, setResultados] = useState([])
  const [buscando, setBuscando] = useState(false)
  const [socioSeleccionado, setSocioSeleccionado] = useState(null)
  const [vigente, setVigente] = useState(null)
  const [plantillas, setPlantillas] = useState([])
  const [asignando, setAsignando] = useState(false)
  const [recargar, setRecargar] = useState(0)
  // undefined = cerrado; null = rutina nueva; id = editar esa rutina.
  const [editorRutinaId, setEditorRutinaId] = useState(undefined)
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

  const handleElegirSocio = (socio) => {
    setSocioSeleccionado(socio)
    setVigente(null)
    setResultados([])
    setBusqueda('')
    setError(null)
  }

  const handleAsignarPlantilla = async (event) => {
    const plantillaId = event.target.value
    event.target.value = ''
    if (!plantillaId || !socioSeleccionado) return
    const plantilla = plantillas.find((p) => p.id === plantillaId)
    if (
      vigente &&
      !window.confirm(
        `¿Asignar "${plantilla?.title ?? 'la plantilla'}" a ${socioSeleccionado.full_name}? Su rutina actual ("${vigente.title}") pasa a su historial.`,
      )
    ) {
      return
    }
    setAsignando(true)
    setError(null)
    try {
      await asignarRutina(socioSeleccionado.id, plantillaId)
      setRecargar((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo asignar la plantilla.')
    } finally {
      setAsignando(false)
    }
  }

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
              aria-label="Asignar desde plantilla"
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

          {asignando ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Asignando...
            </div>
          ) : (
            <RutinasDelSocio
              key={socioSeleccionado.id}
              userId={socioSeleccionado.id}
              acciones
              recargar={recargar}
              onCargado={setVigente}
              onEditarVigente={(id) => setEditorRutinaId(id)}
              onCrearRutina={() => setEditorRutinaId(null)}
            />
          )}
        </div>
      )}

      {editorRutinaId !== undefined && socioSeleccionado && (
        <RutinaEditorModal
          key={editorRutinaId ?? 'nueva'}
          routineId={editorRutinaId}
          socioPreset={socioSeleccionado}
          onClose={() => setEditorRutinaId(undefined)}
          onSaved={() => {
            setEditorRutinaId(undefined)
            setRecargar((n) => n + 1)
          }}
        />
      )}
    </div>
  )
}

export default AsignacionSocios
