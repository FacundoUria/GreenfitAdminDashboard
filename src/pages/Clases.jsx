import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Loader2, Percent, Plus, Users } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { DIAS_SEMANA, diaActualPorDefecto, mapearClases } from '../utils/clases'
import ClasesGrid from '../components/ClasesGrid'
import InscriptosModal from '../components/InscriptosModal'
import NuevaClaseModal from '../components/NuevaClaseModal'

function Clases() {
  const [clases, setClases] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [diaSeleccionado, setDiaSeleccionado] = useState(diaActualPorDefecto)
  const [claseInscriptos, setClaseInscriptos] = useState(null)
  const [modalNuevaClaseAbierto, setModalNuevaClaseAbierto] = useState(false)
  const [claseEnEdicion, setClaseEnEdicion] = useState(null)

  const fetchClases = async () => {
    setLoading(true)
    setError(null)

    const [clasesResult, asistenciasResult] = await Promise.all([
      supabase.from('classes').select('*').order('start_time', { ascending: true }),
      supabase.from('asistencias').select('id, clase_id, asistio, socios(nombre, apellido)'),
    ])

    if (clasesResult.error) {
      console.error('Error al cargar clases desde Supabase:', clasesResult.error.message)
      setError('No se pudieron cargar las clases. Verificá la conexión con Supabase.')
      setClases([])
      setLoading(false)
      return
    }

    if (asistenciasResult.error) {
      console.error('Error al cargar asistencias desde Supabase:', asistenciasResult.error.message)
    }

    setClases(mapearClases(clasesResult.data ?? [], asistenciasResult.data ?? []))
    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchClases()
  }, [])

  const clasesDelDia = useMemo(
    () => clases.filter((clase) => clase.diasSemana.includes(diaSeleccionado)),
    [clases, diaSeleccionado],
  )

  const kpis = useMemo(() => {
    const cuposTotales = clasesDelDia.reduce((total, clase) => total + clase.cupoMaximo, 0)
    const inscriptosHoy = clasesDelDia.reduce((total, clase) => total + clase.inscriptos.length, 0)
    const ocupacion = cuposTotales === 0 ? 0 : Math.round((inscriptosHoy / cuposTotales) * 100)

    return [
      { label: 'Clases Hoy', value: clasesDelDia.length, icon: CalendarDays },
      { label: 'Cupos Totales', value: cuposTotales, icon: Users },
      { label: 'Inscriptos Hoy', value: inscriptosHoy, icon: Users },
      { label: 'Ocupación', value: `${ocupacion}%`, icon: Percent },
    ]
  }, [clasesDelDia])

  const handleVerInscriptos = (clase) => setClaseInscriptos(clase)

  const handleMarcarAsistencia = async (claseId, inscriptoId, asistio) => {
    const { data, error: updateError } = await supabase
      .from('asistencias')
      .update({ asistio })
      .eq('id', inscriptoId)
      .select()

    if (updateError || !data || data.length === 0) {
      console.error(
        'Error al marcar asistencia en Supabase:',
        updateError?.message ?? 'no se actualizó ninguna fila (revisá las políticas RLS)',
      )
      window.alert('No se pudo actualizar la asistencia. Intentá nuevamente.')
      return
    }

    setClases((prev) =>
      prev.map((clase) =>
        clase.id !== claseId
          ? clase
          : {
              ...clase,
              inscriptos: clase.inscriptos.map((inscripto) =>
                inscripto.id === inscriptoId ? { ...inscripto, asistio } : inscripto,
              ),
            },
      ),
    )
    setClaseInscriptos((prev) =>
      prev && prev.id === claseId
        ? {
            ...prev,
            inscriptos: prev.inscriptos.map((inscripto) =>
              inscripto.id === inscriptoId ? { ...inscripto, asistio } : inscripto,
            ),
          }
        : prev,
    )
  }

  const handleAbrirNuevaClase = () => {
    setClaseEnEdicion(null)
    setModalNuevaClaseAbierto(true)
  }

  const handleEditar = (clase) => {
    setClaseEnEdicion(clase)
    setModalNuevaClaseAbierto(true)
  }

  const handleCancelarClase = async (clase) => {
    const confirmado = window.confirm(
      `¿Seguro que querés cancelar la clase de ${clase.disciplina} de las ${clase.horaInicio}?`,
    )
    if (!confirmado) return

    const { data, error: deleteError } = await supabase
      .from('classes')
      .delete()
      .eq('id', clase.id)
      .select()

    if (deleteError || !data || data.length === 0) {
      console.error(
        'Error al cancelar la clase en Supabase:',
        deleteError?.message ?? 'no se eliminó ninguna fila (revisá las políticas RLS)',
      )
      window.alert('No se pudo cancelar la clase. Intentá nuevamente.')
      return
    }

    setClases((prev) => prev.filter((c) => c.id !== clase.id))
  }

  const handleClaseGuardada = () => {
    setModalNuevaClaseAbierto(false)
    setClaseEnEdicion(null)
    fetchClases()
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map(({ label, value, icon: Icon }) => (
          <div key={label} className="flex items-center gap-4 rounded-xl bg-greenfit-card p-5">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-greenfit-primary/15">
              <Icon className="h-5 w-5 text-greenfit-primary" />
            </div>
            <div>
              <p className="text-sm text-gray-400">{label}</p>
              <p className="text-2xl font-semibold text-white">{value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {DIAS_SEMANA.map(({ numero, nombre }) => (
            <button
              key={numero}
              type="button"
              onClick={() => setDiaSeleccionado(numero)}
              className={`min-h-[44px] rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                diaSeleccionado === numero
                  ? 'bg-greenfit-primary text-greenfit-dark'
                  : 'bg-greenfit-card text-gray-300 hover:text-white'
              }`}
            >
              {nombre}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={handleAbrirNuevaClase}
          className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Nueva Clase
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-greenfit-card p-10 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Cargando clases...
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-10 text-center text-sm text-red-400">
          <p>{error}</p>
          <button
            type="button"
            onClick={fetchClases}
            className="rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10"
          >
            Reintentar
          </button>
        </div>
      ) : (
        <ClasesGrid
          clases={clasesDelDia}
          onVerInscriptos={handleVerInscriptos}
          onEditar={handleEditar}
          onCancelar={handleCancelarClase}
        />
      )}

      <InscriptosModal
        open={Boolean(claseInscriptos)}
        clase={claseInscriptos}
        onClose={() => setClaseInscriptos(null)}
        onMarcarAsistencia={handleMarcarAsistencia}
      />

      {modalNuevaClaseAbierto && (
        <NuevaClaseModal
          key={claseEnEdicion?.id ?? 'nueva'}
          clase={claseEnEdicion}
          diaPorDefecto={diaSeleccionado}
          onClose={() => {
            setModalNuevaClaseAbierto(false)
            setClaseEnEdicion(null)
          }}
          onSaved={handleClaseGuardada}
        />
      )}
    </div>
  )
}

export default Clases
