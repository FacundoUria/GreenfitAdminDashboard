import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import {
  combinarFechaYHora,
  etiquetaDia,
  formatDateOnly,
  mapearClasesDesdeBookings,
  proximosDias,
} from '../utils/clases'
import ClasesGrid from '../components/ClasesGrid'
import InscriptosModal from '../components/InscriptosModal'
import NuevaClaseModal from '../components/NuevaClaseModal'

const DIAS_VISIBLES = proximosDias(7)

function Clases() {
  const [clasesBase, setClasesBase] = useState([])
  const [bookings, setBookings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [fechaSeleccionada, setFechaSeleccionada] = useState(DIAS_VISIBLES[0])
  const [claseInscriptosId, setClaseInscriptosId] = useState(null)
  const [modalNuevaClaseAbierto, setModalNuevaClaseAbierto] = useState(false)
  const [claseEnEdicion, setClaseEnEdicion] = useState(null)

  const fechaSeleccionadaStr = useMemo(() => formatDateOnly(fechaSeleccionada), [fechaSeleccionada])
  const esHoy = fechaSeleccionadaStr === formatDateOnly(new Date())

  const fetchClasesBase = useCallback(async () => {
    // Embed de `disciplines(show_in_agenda)` -- mismo flag que ya usa
    // loadClassesForDate() en la PWA (greenfit-app/src/lib/classesApi.ts)
    // para decidir qué es "una clase para reservar" y qué es horario
    // meramente informativo (ej. Aparatos/Pase Libre: acceso libre, sin
    // cupo que reservar). Antes acá se listaba TODO lo que hubiera en
    // `classes` sin este filtro -- una franja real cargada para Aparatos
    // (para que la landing/Disciplinas.jsx muestren su horario) aparecía
    // también acá como si fuera una clase reservable más, generando ruido
    // y contradiciendo lo que el socio ve en su propia Agenda.
    const { data, error: fetchError } = await supabase
      .from('classes')
      .select('*, disciplines(show_in_agenda)')
      .order('start_time', { ascending: true })
    if (fetchError) {
      console.error('Error al cargar clases desde Supabase:', fetchError.message)
      setError('No se pudieron cargar las clases. Verificá la conexión con Supabase.')
      setClasesBase([])
      return
    }
    setError(null)
    const reservables = (data ?? []).filter((row) => {
      const disciplina = Array.isArray(row.disciplines) ? row.disciplines[0] : row.disciplines
      return disciplina?.show_in_agenda !== false
    })
    setClasesBase(reservables)
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
    await Promise.all([fetchClasesBase(), fetchBookings(fechaSeleccionadaStr)])
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
  const [fechaCargadaInicial] = useState(fechaSeleccionadaStr)
  useEffect(() => {
    if (fechaSeleccionadaStr === fechaCargadaInicial) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchBookings(fechaSeleccionadaStr)
  }, [fechaSeleccionadaStr, fechaCargadaInicial, fetchBookings])

  const clases = useMemo(
    () => mapearClasesDesdeBookings(clasesBase, bookings),
    [clasesBase, bookings],
  )

  // Orden estrictamente cronológico (de la más temprana a la más tardía) --
  // la query base ya viene ordenada por start_time, pero lo reafirmamos acá
  // porque es la garantía que le importa a esta pantalla en particular.
  const clasesDelDia = useMemo(
    () =>
      clases
        .filter((clase) => clase.diasSemana.includes(fechaSeleccionada.getDay()))
        .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio)),
    [clases, fechaSeleccionada],
  )

  // Jerarquía visual: solo tiene sentido "en curso" / "próxima" mirando el
  // día de HOY -- en cualquier otro día todas las clases son simplemente
  // futuras, ninguna requiere atención inmediata todavía.
  const { enCursoIds, proximaClaseId } = useMemo(() => {
    if (!esHoy) return { enCursoIds: new Set(), proximaClaseId: null }

    const ahora = new Date()
    const enCurso = new Set()
    let proxima = null
    let proximaInicio = null

    for (const clase of clasesDelDia) {
      const inicio = combinarFechaYHora(fechaSeleccionadaStr, clase.horaInicio)
      const fin = combinarFechaYHora(fechaSeleccionadaStr, clase.horaFin) ?? inicio
      if (!inicio) continue

      if (ahora >= inicio && ahora < fin) {
        enCurso.add(clase.id)
      } else if (ahora < inicio && (!proximaInicio || inicio < proximaInicio)) {
        proxima = clase.id
        proximaInicio = inicio
      }
    }

    return { enCursoIds: enCurso, proximaClaseId: proxima }
  }, [clasesDelDia, esHoy, fechaSeleccionadaStr])

  const claseInscriptos = useMemo(
    () => clasesDelDia.find((c) => c.id === claseInscriptosId) ?? null,
    [clasesDelDia, claseInscriptosId],
  )

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
      p_booking_date: fechaSeleccionadaStr,
    })

    if (rpcError) {
      window.alert(`No se pudo anotar al socio: ${rpcError.message}`)
      return
    }

    await fetchBookings(fechaSeleccionadaStr)
  }

  const handleQuitarInscripto = async (clase, inscripto) => {
    const confirmado = window.confirm(`¿Quitar a ${inscripto.nombre} de esta clase?`)
    if (!confirmado) return

    const { error: rpcError } = await supabase.rpc('admin_cancel_booking', {
      p_user_id: inscripto.userId,
      p_class_id: clase.id,
      p_booking_date: fechaSeleccionadaStr,
      p_reason: 'Quitado por el admin desde el panel',
    })

    if (rpcError) {
      window.alert(`No se pudo quitar al socio: ${rpcError.message}`)
      return
    }

    await fetchBookings(fechaSeleccionadaStr)
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {DIAS_VISIBLES.map((fecha, index) => {
            const fechaStr = formatDateOnly(fecha)
            const seleccionado = fechaStr === fechaSeleccionadaStr
            return (
              <button
                key={fechaStr}
                type="button"
                onClick={() => setFechaSeleccionada(fecha)}
                className={`flex min-h-[52px] w-16 shrink-0 flex-col items-center justify-center rounded-lg px-2 py-2 text-sm font-medium transition-colors ${
                  seleccionado
                    ? 'bg-greenfit-primary text-greenfit-dark'
                    : 'bg-greenfit-card text-gray-300 hover:text-white'
                }`}
              >
                <span className="text-xs capitalize">{etiquetaDia(fecha, index)}</span>
                <span className="text-base font-semibold">{fecha.getDate()}</span>
              </button>
            )
          })}
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
          enCursoIds={enCursoIds}
          proximaClaseId={proximaClaseId}
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
          // El picker de días de NuevaClaseModal solo cubre Lunes-Sábado (el
          // gimnasio no abre los domingos) -- si se está viendo un domingo,
          // el prefill cae en Lunes en vez de un día que no existe ahí.
          diaPorDefecto={fechaSeleccionada.getDay() === 0 ? 1 : fechaSeleccionada.getDay()}
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
