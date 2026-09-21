import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Plus } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { formatFecha } from '../utils/fecha'
import {
  combinarFechaYHora,
  diaAnterior,
  etiquetaDia,
  formatDateOnly,
  mapearClasesDesdeBookings,
  proximosDias,
} from '../utils/clases'
import ClasesGrid from '../components/ClasesGrid'
import InscriptosModal from '../components/InscriptosModal'
import NuevaClaseModal from '../components/NuevaClaseModal'

// "Ayer" adelante de "Hoy" -- para que Seba pueda revisar quién asistió o
// si hubo algún problema en la clase del día anterior. El resto de los días
// (Hoy, Mañana, y los siguientes) queda exactamente igual que antes. `HOY`
// se guarda aparte -- DIAS_VISIBLES[0] ahora es Ayer, no Hoy, y la pantalla
// tiene que seguir abriendo en el día de hoy por defecto.
const HOY = proximosDias(1)[0]
const DIAS_VISIBLES = [diaAnterior(HOY), ...proximosDias(7)]

function Clases() {
  const navigate = useNavigate()
  const [clasesBase, setClasesBase] = useState([])
  const [bookings, setBookings] = useState([])
  const [cancelaciones, setCancelaciones] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [fechaSeleccionada, setFechaSeleccionada] = useState(HOY)
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

  // Igual que fetchBookings -- por ocurrencia puntual (class_id + fecha),
  // no por clase entera, así que se re-pide con cada cambio de día. Fail-
  // open a propósito (mismo criterio que otros fetches "de más" de este
  // archivo): si la tabla todavía no existe (migración sin correr), la
  // grilla sigue funcionando, solo sin el badge de "Cancelada".
  const fetchCancelaciones = useCallback(async (fecha) => {
    const { data, error: fetchError } = await supabase
      .from('class_occurrence_cancellations')
      .select('class_id')
      .eq('occurrence_date', fecha)

    if (fetchError) {
      console.error('Error al cargar cancelaciones puntuales desde Supabase:', fetchError.message)
      return
    }
    setCancelaciones(data ?? [])
  }, [])

  const cargarTodo = useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchClasesBase(), fetchBookings(fechaSeleccionadaStr), fetchCancelaciones(fechaSeleccionadaStr)])
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarTodo()
  }, [cargarTodo])

  // Re-pide inscriptos + cancelaciones (no las clases) cuando cambia el día
  // elegido. `cargarTodo` ya cubre la primera carga, así que acá solo
  // importan los cambios posteriores de fechaSeleccionada.
  const [fechaCargadaInicial] = useState(fechaSeleccionadaStr)
  useEffect(() => {
    if (fechaSeleccionadaStr === fechaCargadaInicial) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchBookings(fechaSeleccionadaStr)
    fetchCancelaciones(fechaSeleccionadaStr)
  }, [fechaSeleccionadaStr, fechaCargadaInicial, fetchBookings, fetchCancelaciones])

  const canceladasIds = useMemo(() => new Set(cancelaciones.map((c) => c.class_id)), [cancelaciones])

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
      // Una clase cancelada este día puntual no tiene actividad real (sus
      // reservas ya se cancelaron todas) -- no tiene sentido destacarla
      // como "En curso"/"Próxima".
      if (canceladasIds.has(clase.id)) continue
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
  }, [clasesDelDia, esHoy, fechaSeleccionadaStr, canceladasIds])

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

  // Click en el nombre de un inscripto (InscriptosModal.jsx, solo si tiene
  // dni real) -- reusa el mismo deep-link ?editar=<dni> que ya entiende
  // Socios.jsx (mismo patrón que ?filtro=por_vencer desde Home.jsx), así
  // que no hace falta ningún fetch ni modal nuevo acá.
  const handleAbrirFichaSocio = (dni) => {
    navigate(`/socios?editar=${dni}`)
  }

  const handleQuitarInscripto = async (clase, inscripto) => {
    const confirmado = window.confirm(`¿Quitar a ${inscripto.nombre} de esta clase?`)
    if (!confirmado) return

    // p_forzar_reintegro: true SIEMPRE -- a diferencia de cuando el socio se
    // cancela solo desde la PWA (cancel_booking, con tiempo de gracia), acá
    // es Seba sacando a alguien desde el Admin por cualquier motivo (no
    // necesariamente una cancelación tardía del socio) -- el crédito se
    // reintegra incondicional, sin depender de cuánto falte para la clase.
    // Sin checkbox ni opción: es automático cada vez que se usa este botón.
    const { error: rpcError } = await supabase.rpc('admin_cancel_booking', {
      p_user_id: inscripto.userId,
      p_class_id: clase.id,
      p_booking_date: fechaSeleccionadaStr,
      p_reason: 'Quitado por el admin desde el panel',
      p_forzar_reintegro: true,
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

  // REDISEÑO -- antes esto hacía un DELETE directo sobre `classes`: borraba
  // la plantilla recurrente ENTERA (todos los días programados, para
  // siempre) y encima fallaba con un error genérico apenas hubiera
  // cualquier reserva asociada (foreign key de `bookings`, sin cascade --
  // ver investigacion_cancelar_clase_prueba_fk.sql). Lo que hace falta es
  // cancelar la OCURRENCIA de este día puntual nada más -- `classes` no se
  // toca acá nunca. admin_cancelar_clase_dia() reintegra el crédito a cada
  // anotado (mismo criterio incondicional que "Quitar de la clase") y les
  // deja una notificación in-app; acá solo falta el push real.
  const handleCancelarClase = async (clase) => {
    const confirmado = window.confirm(
      `¿Cancelar la clase de ${clase.disciplina} de las ${clase.horaInicio} del ${formatFecha(fechaSeleccionadaStr)}? Se reintegra el crédito a todos los anotados de ese día y se les avisa. El resto de la semana no se toca.`,
    )
    if (!confirmado) return

    // Resuelto ANTES de cancelar -- el RPC de abajo borra las reservas, así
    // que después no quedaría de dónde sacar a quién avisarle por push.
    const { data: inscriptos, error: inscriptosError } = await supabase
      .from('bookings')
      .select('user_id')
      .eq('class_id', clase.id)
      .eq('booking_date', fechaSeleccionadaStr)
    if (inscriptosError) {
      console.error('Error al resolver los inscriptos antes de cancelar la clase:', inscriptosError.message)
    }
    const userIdsAfectados = [...new Set((inscriptos ?? []).map((b) => b.user_id))]

    const { data: cantidadCancelados, error: rpcError } = await supabase.rpc('admin_cancelar_clase_dia', {
      p_class_id: clase.id,
      p_occurrence_date: fechaSeleccionadaStr,
    })

    if (rpcError) {
      window.alert(`No se pudo cancelar la clase: ${rpcError.message}`)
      return
    }

    // Best-effort -- el reintegro y la notificación in-app YA se aplicaron
    // (RPC de arriba, en la misma transacción); si el push real falla, no
    // hay nada crítico que revertir, solo se loguea.
    if (userIdsAfectados.length > 0) {
      const { error: pushError } = await supabase.functions.invoke('send-push', {
        body: {
          title: 'Clase cancelada',
          body: `${clase.disciplina} de las ${clase.horaInicio} del ${formatFecha(fechaSeleccionadaStr)} fue cancelada por el gimnasio. Ya te reintegramos el crédito.`,
          audience: 'users',
          targetUserIds: userIdsAfectados,
        },
      })
      if (pushError) {
        console.error('No se pudo enviar el push de la cancelación (la cancelación en sí ya se aplicó):', pushError.message)
      }
    }

    window.alert(`Clase cancelada para ese día -- se reintegró el crédito a ${cantidadCancelados ?? 0} socio(s).`)
    await Promise.all([fetchBookings(fechaSeleccionadaStr), fetchCancelaciones(fechaSeleccionadaStr)])
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
          {DIAS_VISIBLES.map((fecha) => {
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
                <span className="text-xs capitalize">{etiquetaDia(fecha)}</span>
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
          canceladasIds={canceladasIds}
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
        onAbrirFicha={handleAbrirFichaSocio}
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
