import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  MessageCircle,
  Plus,
  Search,
  UserPlus,
  Users,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { esDelMesActual, formatFecha, hoyISO } from '../utils/fecha'
import { estadoOperativoSocio, getSocioMetrics } from '../utils/socioMetrics'
import { formatearPlanes, planesDeCreditos, planesDeVencimiento, PLANES_DISPONIBLES } from '../utils/planes'
import { buscarCoincidenciaPorNombre } from '../utils/coincidenciaSocios'
import {
  sincronizarCreditosPwa,
  sincronizarVencimientoPwa,
  sincronizarVencimientoCreditoPwa,
  sincronizarEstadoCuentaPwa,
} from '../utils/creditosPwa'
import { fetchAvataresYNiveles, fetchCreditosPorDisciplina, resolverUserIdPorDni, registrarPago } from '../utils/fichaSocioPwa'
import SociosTabla from '../components/SociosTabla'
import NuevoSocioModal from '../components/NuevoSocioModal'
import RegistrarPagoModal from '../components/RegistrarPagoModal'
import WhatsAppModal from '../components/WhatsAppModal'
import { useConfiguracion } from '../context/useConfiguracion'
import { useAuth } from '../context/useAuth'

function Toast({ message }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg bg-greenfit-card px-4 py-3 shadow-xl ring-1 ring-white/10">
      <CheckCircle2 className="h-5 w-5 text-greenfit-primary" />
      <span className="text-sm font-medium text-white">{message}</span>
    </div>
  )
}

const DIAS_POR_VENCER = 5

const filtroOptions = [
  { value: 'activo', label: 'Activo' },
  { value: 'vencido', label: 'Cuota Vencida' },
  { value: 'por_vencer', label: `Por Vencer (${DIAS_POR_VENCER} días)` },
  { value: 'tolerancia', label: 'En Tolerancia' },
  { value: 'nuevo', label: 'Nuevos del Mes' },
  { value: 'inactivo_cuenta', label: 'Inactivos (dados de baja)' },
  { value: 'todos', label: 'Todos' },
]

const filtroPlanOptions = [{ value: 'todos', label: 'Todos los planes' }, ...PLANES_DISPONIBLES.map((p) => ({ value: p, label: p }))]

// Un mensaje distinto por cada `reason` que puede devolver sincronizarCreditosPwa
// (ver creditosPwa.js) -- antes TODO fallo que no fuera 'sin_cuenta_pwa' caía en
// el mismo texto genérico, y 'sin_cuenta_pwa' específicamente quedaba en
// silencio total (sin avisar nada). El cliente pidió explícitamente un aviso
// claro para el caso "el socio todavía no está registrado en la app".
const MENSAJES_SYNC_FALLIDO = {
  sin_cuenta_pwa: (disciplina) =>
    `Créditos del panel actualizados. El socio todavía no está registrado en la app -- ${disciplina} no se pudo sincronizar todavía (se sincroniza solo apenas cree su cuenta).`,
  disciplina_no_encontrada: (disciplina) =>
    `Créditos del panel actualizados, pero "${disciplina}" no existe en el catálogo de Disciplinas -- revisalo en Configuración.`,
  rls_bloqueo_escritura: (disciplina) =>
    `Créditos del panel actualizados, pero un permiso (RLS) bloqueó la escritura en la app para ${disciplina}. Revisá supabase_migration_user_credits_rls_admin.sql.`,
  error_supabase: (disciplina) =>
    `Créditos del panel actualizados, pero no se pudo sincronizar ${disciplina} con la app (error técnico -- revisá la consola).`,
}

// Activo (no vencido, no en tolerancia) y con fecha_vencimiento dentro de los
// próximos DIAS_POR_VENCER días -- mismo criterio que usa el widget del
// Dashboard, para que el número que ves ahí y lo que filtra acá coincidan.
function estaPorVencer(socio) {
  if (socio.estado !== 'activo' || !socio.fechaVencimiento) return false
  const vencimiento = new Date(`${socio.fechaVencimiento}T00:00:00`)
  const msPorDia = 1000 * 60 * 60 * 24
  const diasRestantes = Math.ceil((vencimiento.getTime() - Date.now()) / msPorDia)
  return diasRestantes >= 0 && diasRestantes <= DIAS_POR_VENCER
}

function mapearSocio(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    apellido: row.apellido,
    dni: row.dni,
    email: row.email,
    telefono: row.telefono,
    plan: row.plan,
    // Texto libre guardado en `estado`, usado solo como fallback si todavía no
    // tiene fecha_vencimiento. El estado visual real se calcula reactivamente
    // más abajo, porque depende de `dias_tolerancia` (Configuración).
    estadoDb: (row.estado ?? '').toLowerCase(),
    fechaVencimiento: row.fecha_vencimiento,
    diaCorte: row.dia_corte,
    fechaInicio: row.created_at,
    // Inicio de la cuota VIGENTE (elegido a mano en Registrar Pago), distinto de
    // `fechaInicio` de arriba que es la fecha de alta de la cuenta -- no confundir.
    fechaInicioCuota: row.fecha_inicio_cuota,
    ultimoPago: formatFecha(row.ultimo_pago),
    creditos: row.creditos ?? 0,
    activo: row.activo ?? true,
  }
}

function Socios() {
  const { configuracion } = useConfiguracion()
  const { usuario } = useAuth()
  const diasTolerancia = configuracion?.dias_tolerancia ?? 5
  const [searchParams] = useSearchParams()

  const [socios, setSocios] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Avatar real + nivel de XP por DNI (Ficha 360°/tabla principal) -- se
  // trae en batch (2 queries para TODA la lista, no una por socio) apenas
  // cambia el listado de socios, y se mergea en sociosConEstado más abajo.
  const [gamificacionPorDni, setGamificacionPorDni] = useState(new Map())
  // Créditos REALES de la PWA por disciplina (user_credits), en batch --
  // mismo criterio que gamificacionPorDni. Fuente de verdad para
  // CreditosCell: `socios.creditos` es un solo pozo global (ver
  // planesDeCreditos en utils/planes.js), esto es lo que la app realmente
  // tiene cargado por cada disciplina de créditos del socio.
  const [creditosPorDni, setCreditosPorDni] = useState(new Map())
  const [busqueda, setBusqueda] = useState('')
  // El Dashboard linkea acá con ?filtro=por_vencer (u otro value de
  // filtroOptions) para llegar con la lista ya filtrada. Sin ese query
  // param (entrando desde el Sidebar), el default es 'todos' -- ver TODOS
  // los socios sin tener que tocar el filtro es el punto de partida
  // esperado del módulo, "Activo" quedaba escondiendo altas/bajas/
  // vencidos apenas se entraba.
  const [filtroEstado, setFiltroEstado] = useState(
    () => filtroOptions.find((o) => o.value === searchParams.get('filtro'))?.value ?? 'todos',
  )
  const [filtroPlan, setFiltroPlan] = useState('todos')
  const [modalAbierto, setModalAbierto] = useState(false)
  const [socioEnEdicion, setSocioEnEdicion] = useState(null)
  const [socioParaPago, setSocioParaPago] = useState(null)
  const [toastMessage, setToastMessage] = useState(null)
  const [seleccionados, setSeleccionados] = useState(new Set())
  const [whatsappDestinatarios, setWhatsappDestinatarios] = useState(null)
  const [whatsappPreset, setWhatsappPreset] = useState(null)
  // Catálogo real de disciplinas activas -- se lo pasa a RegistrarPagoModal
  // para que "Actividad / Plan de este pago" deje de ser una lista fija
  // hardcodeada (PLANES_DISPONIBLES) y sume cualquier disciplina nueva que
  // se cargue desde el catálogo (Disciplinas.jsx) sin tocar código. También
  // trae `kind` (créditos vs. vencimiento) y `default_capacity` (reusado
  // como "días de vigencia" para las de vencimiento, ver DisciplinaModal.jsx)
  // para poder sugerir la fecha de vencimiento sola al tildar una actividad.
  const [disciplinasActivas, setDisciplinasActivas] = useState([])

  const fetchSocios = async () => {
    setLoading(true)
    setError(null)

    const { data, error: fetchError } = await supabase
      .from('socios')
      .select('*')
      .order('nombre', { ascending: true })

    if (fetchError) {
      console.error('Error al cargar socios desde Supabase:', fetchError.message)
      setError('No se pudieron cargar los socios. Verificá la conexión con Supabase.')
      setSocios([])
    } else {
      setSocios((data ?? []).map(mapearSocio))
    }

    setLoading(false)
  }

  useEffect(() => {
    // Patrón estándar de fetch-on-mount (avalado por la doc de React); la regla
    // experimental set-state-in-effect no distingue este caso del anti-patrón que persigue.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSocios()
  }, [])

  // Best-effort, aparte del fetch principal de socios -- si falla, el modal
  // de cobro simplemente cae a la lista fija legacy (PLANES_DISPONIBLES) en
  // vez de romper toda la pantalla.
  useEffect(() => {
    supabase
      .from('disciplines')
      .select('id, name, kind, default_capacity')
      .eq('is_active', true)
      .order('name')
      .then(({ data, error: fetchError }) => {
        if (fetchError) {
          console.error('No se pudieron cargar las disciplinas activas para Registrar Pago:', fetchError.message)
          return
        }
        setDisciplinasActivas(data ?? [])
      })
  }, [])

  // Aparte del fetch de `socios` -- si falla o tarda no debe bloquear la
  // tabla principal, es un dato "de más" (avatar + badge de nivel), no
  // crítico para la gestión de cuotas/créditos.
  useEffect(() => {
    if (socios.length === 0) return
    fetchAvataresYNiveles(socios.map((s) => s.dni)).then(setGamificacionPorDni)
    fetchCreditosPorDisciplina(socios.map((s) => s.dni)).then(setCreditosPorDni)
  }, [socios])

  // estadoOperativoSocio() es la MISMA función que usa Home.jsx -- antes
  // acá un socio sin fecha_vencimiento (planes de créditos) caía a
  // `socio.estadoDb` (texto legacy, potencialmente desactualizado), mientras
  // que Home lo excluía directamente de los tres conteos. Eso hacía que
  // "Socios Activos"/"Cuotas Vencidas" mostraran números distintos en las
  // dos pantallas para los mismos socios.
  const sociosConEstado = useMemo(
    () =>
      socios.map((socio) => {
        const gamificacion = gamificacionPorDni.get(socio.dni)
        return {
          ...socio,
          estado: estadoOperativoSocio(socio, diasTolerancia),
          avatarUrl: gamificacion?.avatarUrl ?? null,
          nivelXp: gamificacion?.nivel ?? null,
          creditosPwaPorDisciplina: creditosPorDni.get(socio.dni) ?? [],
        }
      }),
    [socios, diasTolerancia, gamificacionPorDni, creditosPorDni],
  )

  const counts = useMemo(() => {
    const metrics = getSocioMetrics(sociosConEstado, diasTolerancia)
    return {
      activo: metrics.activos,
      vencido: metrics.vencidos,
      tolerancia: metrics.tolerancia,
      nuevo: sociosConEstado.filter((s) => esDelMesActual(s.fechaInicio)).length,
    }
  }, [sociosConEstado, diasTolerancia])

  // testId comparte prefijo con las tarjetas equivalentes de Home.jsx
  // (kpi-activos/kpi-vencidos/kpi-tolerancia) a propósito -- permite a un
  // test E2E leer "el mismo número" en las dos pantallas sin depender del
  // texto exacto de la etiqueta (que además difiere: "Cuotas Vencidas" en
  // Home vs "Cuota Vencida" acá).
  const kpis = [
    { key: 'activo', testId: 'kpi-activos', label: 'Socios Activos', value: counts.activo, icon: Users },
    { key: 'vencido', testId: 'kpi-vencidos', label: 'Cuota Vencida', value: counts.vencido, icon: AlertCircle },
    {
      key: 'tolerancia',
      testId: 'kpi-tolerancia',
      label: 'En Tolerancia',
      // Mismo criterio de claridad que la tarjeta equivalente de Home --
      // aclara el rango de días de gracia configurado en vez de un genérico
      // "En Tolerancia" sin contexto.
      subtitulo: `1 a ${diasTolerancia} día${diasTolerancia === 1 ? '' : 's'} vencido`,
      value: counts.tolerancia,
      icon: Clock,
    },
    { key: 'nuevo', testId: 'kpi-nuevos', label: 'Nuevos del Mes', value: counts.nuevo, icon: UserPlus },
  ]

  const sociosFiltrados = useMemo(() => {
    const termino = busqueda.trim().toLowerCase()

    return sociosConEstado.filter((socio) => {
      const coincideBusqueda =
        termino === '' ||
        `${socio.nombre} ${socio.apellido}`.toLowerCase().includes(termino) ||
        (socio.dni ?? '').toLowerCase().includes(termino)

      // La baja de cuenta es un estado aparte del estado de pago -- un socio
      // dado de baja no debe mezclarse en Activo/Vencido/etc, solo aparece
      // en "Inactivos" o en "Todos".
      const coincideEstado =
        filtroEstado === 'todos'
          ? true
          : filtroEstado === 'inactivo_cuenta'
            ? socio.activo === false
            : socio.activo === false
              ? false
              : filtroEstado === 'nuevo'
                ? esDelMesActual(socio.fechaInicio)
                : filtroEstado === 'por_vencer'
                  ? estaPorVencer(socio)
                  : (socio.estado ?? '').toLowerCase() === filtroEstado

      const coincidePlan = filtroPlan === 'todos' || (socio.plan ?? []).includes(filtroPlan)

      return coincideBusqueda && coincideEstado && coincidePlan
    })
  }, [sociosConEstado, busqueda, filtroEstado, filtroPlan])

  const handleKpiClick = (key) => {
    setFiltroEstado((prev) => (prev === key ? 'todos' : key))
  }

  const handleAbrirNuevoSocio = () => {
    setSocioEnEdicion(null)
    setModalAbierto(true)
  }

  const handleEditar = (socio) => {
    setSocioEnEdicion(socio)
    setModalAbierto(true)
  }

  const handleAjustarCredito = async (socio, delta, disciplina) => {
    // Bug reportado: un socio importado sin DNI cargado no tenía forma real
    // de resolverse contra su cuenta PWA (resolverUserId dependía SOLO del
    // DNI) -- operar sobre "un balance que nunca se inicializó" es lo que
    // terminaba rompiendo el flujo. Se bloquea acá ANTES de tocar nada, con
    // el mismo criterio de "avisar y no hacer nada" que el resto del panel,
    // en vez de dejar que la acción siga a medias.
    if (!socio.dni || !String(socio.dni).trim()) {
      window.alert(
        'No se pueden editar créditos: Este socio no tiene el DNI cargado. Por favor, edite el perfil y agregue el DNI primero.',
      )
      return
    }

    const nuevoValor = Math.max(0, (socio.creditos ?? 0) + delta)

    try {
      const { data, error: updateError } = await supabase
        .from('socios')
        .update({ creditos: nuevoValor })
        .eq('id', socio.id)
        .select()

      if (updateError || !data || data.length === 0) {
        console.error(
          'Error al ajustar créditos en Supabase:',
          updateError?.message ?? 'no se actualizó ninguna fila (revisá las políticas RLS)',
        )
        window.alert('No se pudo actualizar los créditos. Intentá nuevamente.')
        return
      }

      // `disciplina` viene del selector de CreditosCell cuando el socio tiene
      // más de una actividad de créditos -- con una sola no hace falta elegir.
      const disciplinaDestino = disciplina ?? planesDeCreditos(socio.plan)[0]
      if (disciplinaDestino) {
        const resultado = await sincronizarCreditosPwa({
          dni: socio.dni,
          email: socio.email,
          disciplina: disciplinaDestino,
          delta,
        })
        if (!resultado.synced) {
          // Log siempre (no solo cuando se muestra el toast) -- `resultado`
          // trae el motivo exacto (`reason`), clave para depurar un caso
          // puntual como este sin tener que ir a buscar en creditosPwa.js.
          console.error('No se pudo sincronizar créditos con la app:', { socio: socio.dni, disciplina: disciplinaDestino, delta, resultado })
          const mensaje = MENSAJES_SYNC_FALLIDO[resultado.reason]?.(disciplinaDestino) ?? MENSAJES_SYNC_FALLIDO.error_supabase(disciplinaDestino)
          setToastMessage(mensaje)
          setTimeout(() => setToastMessage(null), 5000)
        }
      }

      fetchSocios()
    } catch (err) {
      // Robustez: cualquier excepción inesperada (red caída, respuesta
      // rara de Supabase) se atrapa acá en vez de escalar sin control --
      // antes esto podía tirar la pantalla entera si algo fallaba a mitad
      // de camino.
      console.error('ERROR inesperado ajustando créditos:', err)
      window.alert('No se pudo actualizar los créditos. Intentá nuevamente.')
    }
  }

  const handleCambiarBaja = async (socio) => {
    const nuevoActivo = socio.activo === false
    const accion = nuevoActivo ? 'reactivar' : 'dar de baja a'
    if (!window.confirm(`¿Confirmás ${accion} ${socio.nombre} ${socio.apellido}?`)) return

    const { data, error: updateError } = await supabase
      .from('socios')
      .update({ activo: nuevoActivo })
      .eq('id', socio.id)
      .select()

    if (updateError || !data || data.length === 0) {
      console.error(
        'Error al cambiar el estado de baja del socio:',
        updateError?.message ?? 'no se actualizó ninguna fila (revisá las políticas RLS)',
      )
      window.alert('No se pudo actualizar el estado del socio. Intentá nuevamente.')
      return
    }

    const resultado = await sincronizarEstadoCuentaPwa({ dni: socio.dni, email: socio.email, activo: nuevoActivo })
    let mensaje = nuevoActivo ? 'Socio reactivado' : 'Socio dado de baja'
    if (!resultado.synced && resultado.reason !== 'sin_cuenta_pwa') {
      mensaje += ' (no se pudo sincronizar el acceso en la app -- revisá la consola)'
    }
    setToastMessage(mensaje)
    setTimeout(() => setToastMessage(null), 3000)
    fetchSocios()
  }

  const handleAbrirRegistrarPago = (socio) => {
    setSocioParaPago(socio)
  }

  const handleConfirmarPago = async (socio, payload) => {
    const hoy = hoyISO()
    const cambios = { ultimo_pago: hoy }

    if (payload.plan) {
      cambios.plan = payload.plan
    }

    if (payload.creditosPorDisciplina) {
      const total = payload.creditosPorDisciplina.reduce((suma, item) => suma + item.cantidad, 0)
      cambios.creditos = (socio.creditos ?? 0) + total
    }

    if (payload.vencimiento) {
      // Fechas de inicio/vencimiento 100% elegidas por Seba en el modal (ya no se
      // calculan solas a +1 mes fijo) -- así puede cargar cualquier rango custom
      // (10 días, 15 días, 2 meses). `dia_corte` se recalcula a partir del día del
      // mes de la NUEVA fecha_vencimiento para que, si más adelante deja el modal
      // en los valores sugeridos por defecto, el ciclo siga anclado a lo último
      // que él mismo cargó. El estado (Activo/Vencido/Tolerancia) no se guarda de
      // verdad acá -- se recalcula reactivamente en todos lados a partir de
      // `fecha_vencimiento` vía `calcularEstadoCuota` (ver utils/fecha.js).
      cambios.fecha_inicio_cuota = payload.vencimiento.fechaInicio
      cambios.fecha_vencimiento = payload.vencimiento.fechaVencimiento
      cambios.dia_corte = new Date(`${payload.vencimiento.fechaVencimiento}T00:00:00`).getDate()
      cambios.estado = 'Activo'
    }

    // Todo el flujo de cobro (socios + créditos/vencimiento + historial)
    // queda envuelto en un único try/catch -- antes, cualquier excepción
    // inesperada (no el `updateError` ya chequeado abajo, sino un fallo real
    // de red/RLS en sincronizarCreditosPwa/sincronizarVencimientoPwa, que
    // NO tienen su propio try/catch) se colaba sin capturar: la promesa que
    // devuelve esta función quedaba rechazada, RegistrarPagoModal nunca
    // llegaba a su `setGuardando(false)` y el modal quedaba trabado en
    // "Guardando..." para siempre, sin ningún mensaje para Seba. Acá se
    // loguea siempre el mensaje EXACTO que devuelve Supabase (nunca un
    // genérico vacío) y se lo avisa.
    try {
      let { data, error: updateError } = await supabase
        .from('socios')
        .update(cambios)
        .eq('id', socio.id)
        .select()

      // `fecha_inicio_cuota` viene de supabase_migration_fecha_inicio_cuota.sql
      // -- si ese script todavía no se corrió en este ambiente, Postgrest
      // rechaza el UPDATE ENTERO (PGRST204, "Could not find the
      // 'fecha_inicio_cuota' column ... in the schema cache"), no solo esa
      // columna: el resto de los campos del mismo request -- fecha_vencimiento,
      // dia_corte, estado, que SÍ existen -- también se perdía. Reintenta el
      // mismo UPDATE sin esa columna para no tirar el cobro entero por una
      // migración pendiente; en cuanto se corra ese script, este fallback deja
      // de activarse solo (no hace falta tocar este código de nuevo).
      let fechaInicioCuotaSinGuardar = false
      if ('fecha_inicio_cuota' in cambios && updateError?.message?.includes("'fecha_inicio_cuota' column")) {
        console.warn(
          'La columna fecha_inicio_cuota no existe todavía en Supabase (correr supabase_migration_fecha_inicio_cuota.sql). ' +
            'Reintentando el cobro sin esa columna para no perder el resto del pago.',
        )
        const cambiosSinFechaInicio = { ...cambios }
        delete cambiosSinFechaInicio.fecha_inicio_cuota
        fechaInicioCuotaSinGuardar = true
        ;({ data, error: updateError } = await supabase
          .from('socios')
          .update(cambiosSinFechaInicio)
          .eq('id', socio.id)
          .select())
      }

      // Supabase/RLS puede devolver 200/204 "exitoso" afectando 0 filas (sin
      // `error`) si una policy bloquea el UPDATE. Sin este chequeo, el pago
      // parecería registrarse y en realidad no se guardaría nada.
      if (updateError || !data || data.length === 0) {
        // Este era el motivo REAL por el que en producción seguía saliendo
        // el alert genérico "No se pudo registrar el pago. Intentá
        // nuevamente." sin ninguna pista -- este branch (a diferencia del
        // catch general de más abajo) tenía su propio alert hardcodeado que
        // nunca se tocó. `updateError` es un PostgrestError real cuando lo
        // hay: loguea el objeto completo (message/details/hint/code, no
        // solo .message) para poder diagnosticar la causa exacta (típico:
        // RLS bloqueando el UPDATE porque el admin logueado no matchea
        // `public.is_admin()`, o un constraint real de la tabla `socios`).
        const motivo = updateError
          ? { message: updateError.message, details: updateError.details, hint: updateError.hint, code: updateError.code }
          : 'no se actualizó ninguna fila (revisá las políticas RLS: el admin logueado tiene que pasar public.is_admin())'
        console.error('ERROR REGISTRAR PAGO SUPABASE:', motivo)
        window.alert(
          'No se pudo registrar el pago: ' +
            (updateError?.message || (typeof motivo === 'string' ? motivo : null) || 'Error desconocido'),
        )
        return
      }

      let mensaje = fechaInicioCuotaSinGuardar
        ? 'Pago registrado, pero la fecha de inicio personalizada no se guardó (falta correr una migración pendiente en Supabase). El resto del cobro se guardó bien.'
        : 'Pago registrado correctamente'
      // Disciplinas de crédito que ya reciben su propio insert acá abajo --
      // el loop de vencimiento-de-créditos más adelante las salta a
      // propósito: si el mismo pago carga créditos Y vencimiento para la
      // MISMA disciplina, hacerlo en dos inserts separados competía por
      // cuál quedaba como "la fila más reciente" (ver la nota larga en
      // sincronizarCreditosPwa) -- un solo insert con los dos datos juntos
      // (fechaVencimiento pasada acá abajo) lo resuelve de raíz.
      const disciplinasConCreditosCargados = new Set((payload.creditosPorDisciplina ?? []).map((c) => c.disciplina))
      if (payload.creditosPorDisciplina) {
        for (const { disciplina, cantidad } of payload.creditosPorDisciplina) {
          const resultado = await sincronizarCreditosPwa({
            dni: socio.dni,
            email: socio.email,
            disciplina,
            delta: cantidad,
            fechaVencimiento: payload.vencimiento ? cambios.fecha_vencimiento : undefined,
          })
          if (!resultado.synced && resultado.reason !== 'sin_cuenta_pwa') {
            mensaje = 'Pago registrado, pero no se pudo sincronizar con la app. Revisá la consola.'
          }
        }
      }
      if (payload.vencimiento) {
        // Por nombre de plan (igual que los créditos arriba), no "la única
        // disciplina kind=membership que exista" -- un socio podría tener más
        // de una etiqueta de vencimiento a la vez (ej. Pase Libre + Aparatos).
        for (const disciplina of planesDeVencimiento(payload.plan ?? socio.plan)) {
          const resultado = await sincronizarVencimientoPwa({
            dni: socio.dni,
            email: socio.email,
            disciplina,
            fechaVencimiento: cambios.fecha_vencimiento,
          })
          if (!resultado.synced && resultado.reason !== 'sin_cuenta_pwa') {
            mensaje = 'Pago registrado, pero no se pudo sincronizar con la app. Revisá la consola.'
          }
        }
        // El calendario de vencimiento ya no está atado exclusivamente a
        // Aparatos (bug reportado) -- si el cobro es de una disciplina de
        // CRÉDITOS (CrossFit, Boxeo...) que NO recibió créditos en este
        // mismo pago, la fecha elegida se sincroniza acá, preservando el
        // balance real de créditos (sincronizarVencimientoCreditoPwa no pisa
        // remaining_credits con null como sí hace sincronizarVencimientoPwa
        // para membresías). Las que SÍ recibieron créditos ya quedaron
        // cubiertas arriba, en el mismo insert.
        for (const disciplina of planesDeCreditos(payload.plan ?? socio.plan)) {
          if (disciplinasConCreditosCargados.has(disciplina)) continue
          const resultado = await sincronizarVencimientoCreditoPwa({
            dni: socio.dni,
            email: socio.email,
            disciplina,
            fechaVencimiento: cambios.fecha_vencimiento,
          })
          if (!resultado.synced && resultado.reason !== 'sin_cuenta_pwa') {
            mensaje = 'Pago registrado, pero no se pudo sincronizar con la app. Revisá la consola.'
          }
        }
      }

      // Historial de pagos (Ficha 360°) -- best-effort: si el socio todavía no
      // tiene cuenta PWA, o pagos_socio no está desplegada, el pago YA se
      // registró arriba (socios + créditos/vencimiento), así que no hay que
      // cortar el flujo por esto, solo no queda un renglón en el historial.
      // Antes este catch solo logueaba a consola -- si `pagos_socio` SÍ
      // existe pero el insert falla por una razón real (nombre de campo mal,
      // constraint, RLS), Seba veía igual "Pago registrado correctamente"
      // sin ninguna pista de que el historial no se guardó.
      const userId = await resolverUserIdPorDni(socio.dni)
      if (userId) {
        try {
          await registrarPago({
            userId,
            paquete: formatearPlanes(payload.plan ?? socio.plan),
            monto: payload.monto,
            metodoPago: payload.metodoPago,
            // Para planes con vencimiento el período es el que Seba eligió en el
            // modal (puede no arrancar hoy); para planes de créditos no hay rango
            // de fechas, así que el período queda simplemente en "hoy".
            periodoDesde: cambios.fecha_inicio_cuota ?? hoy,
            periodoHasta: cambios.fecha_vencimiento ?? null,
            creadoPor: usuario?.id ?? null,
          })
        } catch (err) {
          // registrarPago() ya loguea el objeto completo antes de relanzar
          // (ver fichaSocioPwa.js) -- acá se repite por si `err` trae
          // detalle extra que no se vio ahí (ej. un TypeError de red real,
          // no un PostgrestError).
          console.error('ERROR pagos_socio (historial) SUPABASE:', {
            message: err.message,
            details: err.details,
            hint: err.hint,
            code: err.code,
          })
          mensaje = 'Pago registrado, pero no se pudo guardar en el historial (pagos_socio). Revisá la consola.'
        }
      }

      setSocioParaPago(null)
      setToastMessage(mensaje)
      setTimeout(() => setToastMessage(null), 2500)
      fetchSocios()
    } catch (err) {
      // Cualquier excepción inesperada del resto del flujo (créditos,
      // vencimiento) que no se haya lanzado como PostgrestError todavía
      // llega acá -- se loguea completo y se muestra el motivo real, nunca
      // el genérico "Intentá nuevamente" sin más.
      console.error('ERROR REGISTRAR PAGO SUPABASE (inesperado):', {
        message: err.message,
        details: err.details,
        hint: err.hint,
        code: err.code,
      })
      window.alert(`No se pudo registrar el pago: ${err.message || 'Error desconocido'}`)
    }
  }

  const handleToggleSeleccionado = (id) => {
    setSeleccionados((prev) => {
      const siguiente = new Set(prev)
      if (siguiente.has(id)) siguiente.delete(id)
      else siguiente.add(id)
      return siguiente
    })
  }

  const handleToggleSeleccionarTodos = () => {
    setSeleccionados((prev) => {
      const todosSeleccionados = sociosFiltrados.length > 0 && sociosFiltrados.every((s) => prev.has(s.id))
      if (todosSeleccionados) return new Set()
      return new Set(sociosFiltrados.map((s) => s.id))
    })
  }

  const handleAbrirWhatsappIndividual = (socio) => {
    setWhatsappPreset(null)
    setWhatsappDestinatarios([socio])
  }

  const handleAbrirWhatsappSeleccionados = () => {
    setWhatsappPreset(null)
    setWhatsappDestinatarios(sociosFiltrados.filter((s) => seleccionados.has(s.id)))
  }

  const handleNotificarDeudores = () => {
    const deudores = sociosConEstado.filter((s) => (s.estado ?? '').toLowerCase() === 'vencido')
    setWhatsappPreset('vencida')
    setWhatsappDestinatarios(deudores)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map(({ key, testId, label, subtitulo, value, icon: Icon }) => (
          <button
            key={key}
            data-testid={testId}
            type="button"
            onClick={() => handleKpiClick(key)}
            title={subtitulo}
            className={`flex items-center gap-4 rounded-xl bg-greenfit-card p-5 text-left transition-shadow ${
              filtroEstado === key ? 'ring-2 ring-greenfit-primary' : 'hover:ring-1 hover:ring-white/10'
            }`}
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-greenfit-primary/15">
              <Icon className="h-5 w-5 text-greenfit-primary" />
            </div>
            <div>
              <p className="text-sm text-gray-400">
                {label}
                {subtitulo && <span className="block text-xs text-gray-500">({subtitulo})</span>}
              </p>
              <p className="text-2xl font-semibold text-white">{value}</p>
            </div>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              value={busqueda}
              onChange={(event) => setBusqueda(event.target.value)}
              placeholder="Buscar por nombre, apellido o DNI..."
              className="w-full rounded-lg border border-white/10 bg-greenfit-card py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-gray-500 outline-none focus:border-greenfit-primary"
            />
          </div>

          <select
            value={filtroEstado}
            onChange={(event) => setFiltroEstado(event.target.value)}
            className="min-h-[44px] rounded-lg border border-white/10 bg-greenfit-card px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
          >
            {filtroOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <select
            value={filtroPlan}
            onChange={(event) => setFiltroPlan(event.target.value)}
            aria-label="Filtrar por plan/disciplina"
            className="min-h-[44px] rounded-lg border border-white/10 bg-greenfit-card px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
          >
            {filtroPlanOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {seleccionados.size > 0 && (
            <button
              type="button"
              onClick={handleAbrirWhatsappSeleccionados}
              className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-[#25D366]/15 px-4 py-2 text-sm font-semibold text-[#25D366] transition-colors hover:bg-[#25D366]/25"
            >
              <MessageCircle className="h-4 w-4" />
              WhatsApp a Seleccionados ({seleccionados.size})
            </button>
          )}
          <button
            type="button"
            onClick={handleNotificarDeudores}
            className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-200 transition-colors hover:bg-white/5 hover:text-white"
          >
            <MessageCircle className="h-4 w-4" />
            Notificar a Deudores
          </button>
          <button
            type="button"
            onClick={handleAbrirNuevoSocio}
            className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Nuevo Socio
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-greenfit-card p-10 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Cargando socios...
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-10 text-center text-sm text-red-400">
          <p>{error}</p>
          <button
            type="button"
            onClick={fetchSocios}
            className="rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10"
          >
            Reintentar
          </button>
        </div>
      ) : (
        <SociosTabla
          socios={sociosFiltrados}
          onRegistrarPago={handleAbrirRegistrarPago}
          onEditar={handleEditar}
          onAjustarCredito={handleAjustarCredito}
          onAbrirWhatsapp={handleAbrirWhatsappIndividual}
          onCambiarBaja={handleCambiarBaja}
          seleccionados={seleccionados}
          onToggleSeleccionado={handleToggleSeleccionado}
          onToggleSeleccionarTodos={handleToggleSeleccionarTodos}
        />
      )}

      {modalAbierto && (
        <NuevoSocioModal
          key={socioEnEdicion?.id ?? 'nuevo'}
          socio={socioEnEdicion}
          onClose={() => {
            setModalAbierto(false)
            setSocioEnEdicion(null)
          }}
          onSaved={(mensaje) => {
            fetchSocios()
            if (mensaje) {
              setToastMessage(mensaje)
              setTimeout(() => setToastMessage(null), 3000)
            }
          }}
          onBuscarSocioPorDni={(dni) => sociosConEstado.find((s) => s.dni === dni) ?? null}
          onEditarSocioExistente={handleEditar}
          onBuscarSocioPorNombre={(nombre, apellido) =>
            buscarCoincidenciaPorNombre(sociosConEstado, nombre, apellido, { excluirId: socioEnEdicion?.id })
          }
        />
      )}

      {socioParaPago && (
        <RegistrarPagoModal
          key={socioParaPago.id}
          socio={socioParaPago}
          disciplinasActivas={disciplinasActivas}
          onClose={() => setSocioParaPago(null)}
          onConfirmar={handleConfirmarPago}
        />
      )}

      {whatsappDestinatarios && (
        <WhatsAppModal
          socios={whatsappDestinatarios}
          presetInicial={whatsappPreset}
          onClose={() => setWhatsappDestinatarios(null)}
        />
      )}

      {toastMessage && <Toast message={toastMessage} />}
    </div>
  )
}

export default Socios
