import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { fetchCreditosVigentesPorSocio, fetchSociosParaAnotar } from '../utils/anotarSocios'
import { mensajeErrorAnotar } from '../utils/buscarSocios'
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
  // Inscriptos y cancelaciones se guardan JUNTO con el día al que pertenecen.
  // En pantalla solo se usan si ese día es el elegido ahora (ver `bookings` /
  // `cancelaciones` más abajo): mientras no llega la respuesta del día
  // elegido se ve "Cargando", nunca los datos de otro día.
  //
  // Bug real (2026-10-01): había un solo arreglo `bookings` sin fecha y dos
  // formas de que quedara con datos de OTRO día bajo el día elegido:
  //   1) al volver al día con el que se abrió la pantalla (hoy), un `return`
  //      temprano evitaba volver a pedir los inscriptos -> HOY quedaba con
  //      los de mañana ("0, 0, 0") siempre, sin necesidad de tocar rápido;
  //   2) sin protección contra respuestas fuera de orden, una respuesta
  //      atrasada de otro día pisaba la del día elegido.
  // Con la lista equivocada, "Ver inscriptos" mostraba socios de otro día y
  // marcar asistencia escribía sobre la reserva de ese otro día.
  const [inscriptosDia, setInscriptosDia] = useState({ fecha: null, filas: [] })
  const [cancelacionesDia, setCancelacionesDia] = useState({ fecha: null, filas: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [errorInscriptos, setErrorInscriptos] = useState(null)
  const [fechaSeleccionada, setFechaSeleccionada] = useState(HOY)
  // Número del último pedido de cada tipo: solo la respuesta del ÚLTIMO
  // pedido puede escribir en pantalla; las que llegan tarde se descartan.
  const pedidoInscriptos = useRef(0)
  const pedidoCancelaciones = useRef(0)
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
    const estePedido = ++pedidoInscriptos.current
    const { data, error: fetchError } = await supabase
      .from('bookings')
      .select('id, user_id, class_id, attended, profiles(full_name, dni)')
      .eq('booking_date', fecha)

    // Respuesta atrasada (ya se pidió otra cosa después): se descarta entera.
    if (estePedido !== pedidoInscriptos.current) return

    if (fetchError) {
      console.error('Error al cargar inscriptos desde Supabase:', fetchError.message)
      setErrorInscriptos('No se pudieron cargar los inscriptos de este día. Verificá la conexión con Supabase.')
      return
    }
    setErrorInscriptos(null)
    setInscriptosDia({ fecha, filas: data ?? [] })
  }, [])

  // Igual que fetchBookings -- por ocurrencia puntual (class_id + fecha),
  // no por clase entera, así que se re-pide con cada cambio de día. Fail-
  // open a propósito (mismo criterio que otros fetches "de más" de este
  // archivo): si la tabla todavía no existe (migración sin correr), la
  // grilla sigue funcionando, solo sin el badge de "Cancelada".
  const fetchCancelaciones = useCallback(async (fecha) => {
    const estePedido = ++pedidoCancelaciones.current
    const { data, error: fetchError } = await supabase
      .from('class_occurrence_cancellations')
      .select('class_id')
      .eq('occurrence_date', fecha)

    if (estePedido !== pedidoCancelaciones.current) return

    if (fetchError) {
      console.error('Error al cargar cancelaciones puntuales desde Supabase:', fetchError.message)
    }
    // Fail-open también con error: se marca el día como "resuelto" sin
    // cancelaciones, así la grilla de ESE día se muestra igual (sin el badge).
    setCancelacionesDia({ fecha, filas: fetchError ? [] : data ?? [] })
  }, [])

  // Las clases (plantillas recurrentes) se piden una sola vez: no dependen
  // del día elegido.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchClasesBase().finally(() => setLoading(false))
  }, [fetchClasesBase])

  // Inscriptos + cancelaciones se piden al entrar y en CADA cambio de día,
  // sin excepciones -- incluido al volver al día con el que se abrió la
  // pantalla (antes había un `return` que salteaba justo ese caso).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setErrorInscriptos(null)
    fetchBookings(fechaSeleccionadaStr)
    fetchCancelaciones(fechaSeleccionadaStr)
  }, [fechaSeleccionadaStr, fetchBookings, fetchCancelaciones])

  // "Reintentar": recarga todo para el día elegido AHORA.
  const cargarTodo = useCallback(async () => {
    setLoading(true)
    setErrorInscriptos(null)
    await Promise.all([fetchClasesBase(), fetchBookings(fechaSeleccionadaStr), fetchCancelaciones(fechaSeleccionadaStr)])
    setLoading(false)
  }, [fetchClasesBase, fetchBookings, fetchCancelaciones, fechaSeleccionadaStr])

  // Datos del día ELEGIDO: si lo cargado es de otro día, se trata como "no
  // hay datos todavía" (lista vacía + cargando), nunca se muestra.
  const hayDatosDelDia = inscriptosDia.fecha === fechaSeleccionadaStr && cancelacionesDia.fecha === fechaSeleccionadaStr
  const bookings = useMemo(
    () => (inscriptosDia.fecha === fechaSeleccionadaStr ? inscriptosDia.filas : []),
    [inscriptosDia, fechaSeleccionadaStr],
  )
  const cancelaciones = useMemo(
    () => (cancelacionesDia.fecha === fechaSeleccionadaStr ? cancelacionesDia.filas : []),
    [cancelacionesDia, fechaSeleccionadaStr],
  )

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
    // La asistencia solo se marca sobre una reserva del día que se está
    // viendo. Doble resguardo, porque escribir "asistió" en la reserva de
    // OTRO día era el efecto más grave del bug de arriba:
    //   1) acá: la reserva tiene que estar en la lista del día elegido (y de
    //      esa clase); si no, no se manda nada.
    //   2) en la consulta: el UPDATE exige además booking_date = día elegido y
    //      class_id = esa clase, así que aunque llegara un id de otro día el
    //      servidor no toca ninguna fila.
    const fechaVista = fechaSeleccionadaStr
    const esDelDiaVisto = bookings.some((b) => b.id === inscriptoId && b.class_id === claseId)
    if (!esDelDiaVisto) {
      console.error('Marcar asistencia: la reserva no pertenece al día/clase que se está viendo', { inscriptoId, claseId, fechaVista })
      window.alert('Esa reserva no corresponde al día que estás viendo. Actualizá la pantalla e intentá de nuevo.')
      return
    }

    const { data, error: updateError } = await supabase
      .from('bookings')
      .update({ attended: asistio })
      .eq('id', inscriptoId)
      .eq('booking_date', fechaVista)
      .eq('class_id', claseId)
      .select()

    if (updateError || !data || data.length === 0) {
      console.error(
        'Error al marcar asistencia en Supabase:',
        updateError?.message ?? 'no se actualizó ninguna fila (revisá las políticas RLS)',
      )
      window.alert('No se pudo actualizar la asistencia. Intentá nuevamente.')
      return
    }

    // Solo se actualiza en pantalla si la lista sigue siendo la de ese día.
    setInscriptosDia((prev) =>
      prev.fecha === fechaVista
        ? { ...prev, filas: prev.filas.map((b) => (b.id === inscriptoId ? { ...b, attended: asistio } : b)) }
        : prev,
    )
  }

  // Cambiar de día cierra "Ver inscriptos": el modal nunca queda abierto
  // sobre la lista de otro día.
  const handleElegirDia = (fecha) => {
    if (formatDateOnly(fecha) !== fechaSeleccionadaStr) setClaseInscriptosId(null)
    setFechaSeleccionada(fecha)
  }

  // Buscador de "Ver inscriptos": la lista de socios (role='socio') y sus
  // créditos vigentes en la disciplina de la clase se piden UNA vez al abrir
  // el modal; el filtrado por DNI / nombre / apellido corre en el navegador
  // (InscriptosModal + utils/buscarSocios.js). Si alguna de las dos consultas
  // falla, el modal sigue sirviendo para anotar por DNI exacto como siempre.
  const [sociosBusqueda, setSociosBusqueda] = useState(null)
  const [cargandoSocios, setCargandoSocios] = useState(false)
  const [errorSocios, setErrorSocios] = useState(false)
  const [creditosPorSocio, setCreditosPorSocio] = useState(null)
  const disciplinaIdAbierta = claseInscriptos?.disciplinaId ?? null

  useEffect(() => {
    if (claseInscriptosId === null || !disciplinaIdAbierta) return undefined
    let vigente = true
    /* eslint-disable react-hooks/set-state-in-effect */
    setSociosBusqueda(null)
    setCreditosPorSocio(null)
    setErrorSocios(false)
    setCargandoSocios(true)
    /* eslint-enable react-hooks/set-state-in-effect */
    Promise.allSettled([fetchSociosParaAnotar(), fetchCreditosVigentesPorSocio(disciplinaIdAbierta)]).then(
      ([socios, creditos]) => {
        if (!vigente) return
        if (socios.status === 'fulfilled') setSociosBusqueda(socios.value)
        else {
          console.error('Error al cargar socios para el buscador:', socios.reason?.message)
          setErrorSocios(true)
        }
        if (creditos.status === 'fulfilled') setCreditosPorSocio(creditos.value)
        else console.error('Error al cargar créditos para el buscador:', creditos.reason?.message)
        setCargandoSocios(false)
      },
    )
    return () => {
      vigente = false
    }
  }, [claseInscriptosId, disciplinaIdAbierta])

  const refrescarCreditosBusqueda = async () => {
    if (!disciplinaIdAbierta) return
    try {
      setCreditosPorSocio(await fetchCreditosVigentesPorSocio(disciplinaIdAbierta))
    } catch (err) {
      console.error('Error al refrescar créditos del buscador:', err.message)
    }
  }

  // Anota con admin_book_class (mismo RPC de siempre: valida cupo, créditos,
  // día de la clase y cancelación puntual, y descuenta el crédito -- la misma
  // lógica que usa la PWA cuando el socio se anota solo). Los dos caminos
  // (DNI exacto / socio elegido de la lista) terminan acá.
  const anotarSocio = async (clase, userId, nombre) => {
    const { error: rpcError } = await supabase.rpc('admin_book_class', {
      p_user_id: userId,
      p_class_id: clase.id,
      p_booking_date: fechaSeleccionadaStr,
    })

    if (rpcError) {
      window.alert(mensajeErrorAnotar(rpcError, nombre))
      return
    }

    await Promise.all([fetchBookings(fechaSeleccionadaStr), refrescarCreditosBusqueda()])
  }

  // Camino de siempre: DNI tipeado -> se busca el perfil por DNI exacto.
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

    await anotarSocio(clase, candidatos[0].id, candidatos[0].full_name)
  }

  // Socio elegido de la lista de resultados: ya tenemos su id, no se vuelve a
  // buscar por DNI.
  const handleAgregarSocioPorId = (clase, socio) => anotarSocio(clase, socio.id, socio.full_name)

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

    // El reintegro cambia los créditos que muestra el buscador.
    await Promise.all([fetchBookings(fechaSeleccionadaStr), refrescarCreditosBusqueda()])
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
                onClick={() => handleElegirDia(fecha)}
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

      {/* "Cargando" mientras no esté la respuesta del día ELEGIDO: nunca se
          dibuja la grilla con inscriptos de otro día. */}
      {loading || (!hayDatosDelDia && !error && !errorInscriptos) ? (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-greenfit-card p-10 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Cargando clases...
        </div>
      ) : error || errorInscriptos ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-10 text-center text-sm text-red-400">
          <p>{error || errorInscriptos}</p>
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
        onAgregarSocioPorId={handleAgregarSocioPorId}
        socios={sociosBusqueda}
        cargandoSocios={cargandoSocios}
        errorSocios={errorSocios}
        creditosPorSocio={creditosPorSocio}
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
