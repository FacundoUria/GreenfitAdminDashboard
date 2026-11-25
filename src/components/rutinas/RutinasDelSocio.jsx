import { useEffect, useState } from 'react'
import { Eye, History, Loader2, Pencil, Plus, RotateCcw } from 'lucide-react'
import {
  asignarRutina,
  fetchEntrenamientosPorRutina,
  fetchRoutineFull,
  fetchRutinasDelSocio,
} from '../../utils/routinesApi'
import { formatFecha } from '../../utils/fecha'
import RutinaDetalleModal from './RutinaDetalleModal'

// Rutina actual + "Historial de rutinas" de un socio. El MISMO componente vive en la
// Ficha 360° (solo mirar) y en Rutinas > Asignación a Socios (con acciones: Editar,
// Crear, Volver a asignar). Las rutinas nunca se borran: al asignar otra, la actual pasa
// acá abajo con su fecha de fin y queda de solo lectura.
//
// `recargar`: un número que el padre sube para forzar una recarga (después de asignar o
// guardar). `onCargado(vigente)`: avisa cuál es la vigente (o null) cada vez que carga.
function RutinasDelSocio({ userId, acciones = false, onEditarVigente, onCrearRutina, onCambio, onCargado, recargar = 0 }) {
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [vigente, setVigente] = useState(null)
  const [vigenteFull, setVigenteFull] = useState(null)
  const [anteriores, setAnteriores] = useState([])
  const [entrenamientos, setEntrenamientos] = useState(new Map())
  const [detalleId, setDetalleId] = useState(null)
  const [reasignando, setReasignando] = useState(null)
  const [recargaInterna, setRecargaInterna] = useState(0)

  useEffect(() => {
    let activo = true
    async function cargar() {
      setCargando(true)
      setError(null)
      try {
        const [{ vigente: v, anteriores: a }, conteos] = await Promise.all([
          fetchRutinasDelSocio(userId),
          // Si falla el conteo (ej. sin permiso), la lista se muestra igual.
          fetchEntrenamientosPorRutina(userId).catch(() => new Map()),
        ])
        const full = v ? await fetchRoutineFull(v.id) : null
        if (!activo) return
        setVigente(v)
        setVigenteFull(full)
        setAnteriores(a)
        setEntrenamientos(conteos)
        onCargado?.(v)
      } catch (err) {
        if (activo) setError(err instanceof Error ? err.message : 'No se pudieron cargar las rutinas del socio.')
      } finally {
        if (activo) setCargando(false)
      }
    }
    cargar()
    return () => {
      activo = false
    }
    // onCargado puede cambiar de identidad en cada render del padre: no dispara recargas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, recargar, recargaInterna])

  const handleVolverAAsignar = async (rutina) => {
    const aviso = vigente
      ? `¿Volver a asignar "${rutina.title}"? La rutina actual ("${vigente.title}") pasa al historial del socio.`
      : `¿Volver a asignar "${rutina.title}"?`
    if (!window.confirm(aviso)) return
    setReasignando(rutina.id)
    try {
      await asignarRutina(userId, rutina.id)
      setRecargaInterna((n) => n + 1)
      onCambio?.()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'No se pudo volver a asignar la rutina.')
    } finally {
      setReasignando(null)
    }
  }

  if (cargando) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Cargando rutinas...
      </div>
    )
  }
  if (error) return <p className="px-3 py-4 text-sm text-red-400">{error}</p>

  const totalEjercicios = vigenteFull?.days.reduce((acc, d) => acc + d.exercises.length, 0) ?? 0
  const cuantos = (id) => entrenamientos.get(id) ?? 0
  const textoEntrenamientos = (id) => (cuantos(id) === 1 ? ' · 1 entrenamiento' : ` · ${cuantos(id)} entrenamientos`)

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Rutina actual">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Rutina actual</p>
        {!vigente ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-white/10 py-6 text-center">
            <p className="text-sm text-gray-400">Este socio todavía no tiene una rutina asignada.</p>
            {acciones && onCrearRutina && (
              <button
                type="button"
                onClick={onCrearRutina}
                className="flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
              >
                <Plus className="h-4 w-4" />
                Crear rutina desde cero
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-lg border border-greenfit-primary/20 bg-greenfit-dark/40 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white">{vigente.title}</p>
                <p className="text-xs text-gray-400">
                  Desde el {formatFecha(vigente.vigenteDesde)}
                  {vigenteFull &&
                    ` · ${vigenteFull.days.length} día${vigenteFull.days.length !== 1 ? 's' : ''} · ${totalEjercicios} ejercicios`}
                  {cuantos(vigente.id) > 0 && textoEntrenamientos(vigente.id)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setDetalleId(vigente.id)}
                  className="flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/10 px-3 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Ver
                </button>
                {acciones && onEditarVigente && (
                  <button
                    type="button"
                    onClick={() => onEditarVigente(vigente.id)}
                    className="flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/10 px-3 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Editar
                  </button>
                )}
              </div>
            </div>
            {vigenteFull && (
              <ul className="flex flex-col gap-1.5">
                {vigenteFull.days.map((d) => (
                  <li key={d.id} className="rounded-lg bg-greenfit-card px-3 py-2 text-xs text-gray-300">
                    <span className="font-semibold text-white">{d.title}</span> — {d.exercises.length} ejercicios
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section aria-label="Historial de rutinas">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          <History className="h-3.5 w-3.5" />
          Historial de rutinas ({anteriores.length})
        </p>
        {anteriores.length === 0 ? (
          <p className="text-sm text-gray-500">Todavía no tiene rutinas anteriores.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-white/5 rounded-lg border border-white/5">
            {anteriores.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">{r.title}</p>
                  <p className="text-xs text-gray-500">
                    Del {formatFecha(r.vigenteDesde)} al {formatFecha(r.vigenteHasta)}
                    {cuantos(r.id) > 0 && textoEntrenamientos(r.id)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => setDetalleId(r.id)}
                    aria-label={`Ver ${r.title}`}
                    className="flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/10 px-3 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Ver
                  </button>
                  {acciones && (
                    <button
                      type="button"
                      onClick={() => handleVolverAAsignar(r)}
                      disabled={reasignando !== null}
                      aria-label={`Volver a asignar ${r.title}`}
                      className="flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/10 px-3 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
                    >
                      {reasignando === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      Volver a asignar
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detalleId && <RutinaDetalleModal routineId={detalleId} onClose={() => setDetalleId(null)} />}
    </div>
  )
}

export default RutinasDelSocio
