import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Loader2, Percent, Plus, Users } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { DIAS_SEMANA, diaActualPorDefecto, fechaDeEstaSemana, mapearClasesDesdeBookings } from '../utils/clases'
import ClasesGrid from '../components/ClasesGrid'
import InscriptosModal from '../components/InscriptosModal'
import NuevaClaseModal from '../components/NuevaClaseModal'

function Clases() {
  const [clasesBase, setClasesBase] = useState([])
  const [bookings, setBookings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [diaSeleccionado, setDiaSeleccionado] = useState(diaActualPorDefecto)
  const [claseInscriptosId, setClaseInscriptosId] = useState(null)
  const [modalNuevaClaseAbierto, setModalNuevaClaseAbierto] = useState(false)
  const [claseEnEdicion, setClaseEnEdicion] = useState(null)

  const fechaSeleccionada = useMemo(() => fechaDeEstaSemana(diaSeleccionado), [diaSeleccionado])

  const fetchClasesBase = useCallback(async () => {
    const { data, error: fetchError } = await supabase.from('classes').select('*').order('start_time', { ascending: true })
    if (fetchError) {
      console.error('Error al cargar clases desde Supabase:', fetchError.message)
      setError('No se pudieron cargar las clases. Verificá la conexión con Supabase.')
      setClasesBase([])
      return
    }
    setError(null)
    setClasesBase(data ?? [])
  }, [])

  // Los inscriptos son por ocurrencia puntual (class_id + booking_date), así
  // que se re-piden cada vez que cambia el día elegido, no una sola vez.
  const fetchBookings = useCallback(async (fecha) => {
    const { data, error: fetchError } = await supabase
      .from('bookings')
      .select('id, user_id, class_id, attended, profiles(full_name, dni)')
      .eq('booking_date', fecha)

    if (fetchError) {
      console.error('Error al cargar inscriptos desde Supabase:', fetchError.message)
      return
    }
    setBookings(data ?? [])
  }, [])

  const cargarTodo = useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchClasesBase(), fetchBookings(fechaSeleccionada)])
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarTodo()
  }, [cargarTodo])

  // Re-pide los inscriptos (no las clases) cuando cambia el día elegido.
  // `cargarTodo` ya cubre la primera carga (classes + bookings juntos), así
  // que acá solo importan los cambios posteriores de fechaSeleccionada.
  const [fechaCargadaInicial] = useState(fechaSeleccionada)
  useEffect(() => {
    if (fechaSeleccionada === fechaCargadaInicial) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchBookings(fechaSeleccionada)
  }, [fechaSeleccionada, fechaCargadaInicial, fetchBookings])

  const clases = useMemo(
    () => mapearClasesDesdeBookings(clasesBase, bookings),
    [clasesBase, bookings],
  )

  const clasesDelDia = useMemo(
    () => clases.filter((clase) => clase.diasSemana.includes(diaSeleccionado)),
    [clases, diaSeleccionado],
  )

  const claseInscriptos = useMemo(
    () => clasesDelDia.find((c) => c.id === claseInscriptosId) ?? null,
    [clasesDelDia, claseInscriptosId],
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

  const handleVerInscriptos = (clase) => setClaseInscriptosId(clase.id)

  const handleMarcarAsistencia = async (claseId, inscriptoId, asistio) => {
    const { data, error: updateError } = await supabase
      .from('bookings')
      .update({ attended: asistio })
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

    setBookings((prev) => prev.map((b) => (b.id === inscriptoId ? { ...b, attended: asistio } : b)))
  }

  // Busca socios (profiles con role='socio') por DNI para anotarlos a la
  // clase abierta. admin_book_class ya valida cupo y créditos atómicamente
  // (misma lógica que usa la PWA cuando el socio se anota solo).
  const handleAgregarSocio = async (clase, dniBuscado) => {
    const { data: candidatos, error: buscarError } = await supabase
      .from('profiles')
      .select('id, full_name, dni')
      .eq('role', 'socio')
      .eq('dni', dniBuscado.trim())
      .limit(1)

    if (buscarError || !candidatos || candidatos.length === 0) {
      window.alert('No se encontró ningún socio con ese DNI (o todavía no tiene cuenta creada en la app).')
      return
    }

    const { error: rpcError } = await supabase.rpc('admin_book_class', {
      p_user_id: candidatos[0].id,
      p_class_id: clase.id,
      p_booking_date: fechaSeleccionada,
    })

    if (rpcError) {
      window.alert(`No se pudo anotar al socio: ${rpcError.message}`)
      return
    }

    await fetchBookings(fechaSeleccionada)
  }

  const handleQuitarInscripto = async (clase, inscripto) => {
    const confirmado = window.confirm(`¿Quitar a ${inscripto.nombre} de esta clase?`)
    if (!confirmado) return

    const { error: rpcError } = await supabase.rpc('admin_cancel_booking', {
      p_user_id: inscripto.userId,
      p_class_id: clase.id,
      p_booking_date: fechaSeleccionada,
      p_reason: 'Quitado por el admin desde el panel',
    })

    if (rpcError) {
      window.alert(`No se pudo quitar al socio: ${rpcError.message}`)
      return
    }

    await fetchBookings(fechaSeleccionada)
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

    setClasesBase((prev) => prev.filter((c) => c.id !== clase.id))
  }

  const handleClaseGuardada = () => {
    setModalNuevaClaseAbierto(false)
    setClaseEnEdicion(null)
    fetchClasesBase()
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
            onClick={cargarTodo}
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
        onClose={() => setClaseInscriptosId(null)}
        onMarcarAsistencia={handleMarcarAsistencia}
        onAgregarSocio={handleAgregarSocio}
        onQuitarInscripto={handleQuitarInscripto}
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
