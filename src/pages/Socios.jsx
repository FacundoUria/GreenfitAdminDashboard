import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  CheckCircle2,
  Loader2,
  MessageCircle,
  Plus,
  Search,
  UserPlus,
  Users,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { diferenciaEnDias, esDelMesActual, formatFecha, hoyISO } from '../utils/fecha'
import { estadoOperativoSocio, getSocioMetrics } from '../utils/socioMetrics'
import { formatearPlanes, planesDeVencimiento, PLANES_DISPONIBLES } from '../utils/planes'
import { buscarCoincidenciaPorNombre } from '../utils/coincidenciaSocios'
import { sincronizarEstadoCuentaPwa, resolverDisciplinaId } from '../utils/creditosPwa'
import {
  fetchAvataresYNiveles,
  fetchAparatosVigentePorDni,
  fetchCreditosPorDisciplina,
  resolverUserIdPorDni,
  registrarPago,
} from '../utils/fichaSocioPwa'
import SociosTabla from '../components/SociosTabla'
import NuevoSocioModal from '../components/NuevoSocioModal'
import RegistrarPagoModal from '../components/RegistrarPagoModal'
import WhatsAppModal from '../components/WhatsAppModal'
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

// CAMBIO 2 (simplificar estados de Socios) -- ANTES había 2 opciones
// separadas para "no está al día": 'vencido' (cuota vencida, socio.activo
// sigue true) e 'inactivo_cuenta' (dado de baja, socio.activo=false). Se
// unifican en una sola 'inactivo' -- ambos casos se ven y filtran igual,
// sin distinguir la razón (ver coincideEstado más abajo y EstadoBadge en
// SociosTabla.jsx). La distinción interna sigue viva en getSocioMetrics()/
// estadoOperativoSocio() -- Home/Reportes siguen contando bien "Cuota
// Vencida" aparte de "dados de baja"; acá solo se simplificó QUÉ se puede
// elegir en el desplegable.
const filtroOptions = [
  { value: 'activo', label: 'Activo' },
  { value: 'por_vencer', label: `Por Vencer (${DIAS_POR_VENCER} días)` },
  { value: 'inactivo', label: 'Inactivo' },
  { value: 'nuevo', label: 'Nuevos del Mes' },
  { value: 'todos', label: 'Todos' },
]

const filtroPlanOptions = [{ value: 'todos', label: 'Todos los planes' }, ...PLANES_DISPONIBLES.map((p) => ({ value: p, label: p }))]

// BUG REAL (filtro por disciplina, caso real "Inactivo" + CrossFit) --
// ANTES el filtro de disciplina comparaba contra `socio.plan`, el mismo
// campo de texto legacy editado a mano que PlanCell/CreditosCell/
// checkboxesEdicion ya habían dejado de leer hacía varios tickets (se
// desincroniza: "+ Agregar disciplina" nunca lo actualiza, y una
// disciplina puede agotarse sin que nadie destilde el plan a mano). Un
// socio podía aparecer (o desaparecer) del filtro por una disciplina que
// ya no tiene realmente, o que sí tiene pero nunca quedó tildada en el
// plan. Mismo criterio real que ya usa PlanCell (SociosTabla.jsx): créditos
// reales por disciplina + 'Aparatos'/'Pase Libre' como alias de la misma
// membresía si aparatosVigenteReal.
function disciplinasRealesDelSocio(socio) {
  const nombres = (socio.creditosPwaPorDisciplina ?? []).map((entrada) => entrada.disciplineName)
  if (socio.aparatosVigenteReal) nombres.push('Aparatos', 'Pase Libre')
  return nombres
}

// Activo (no vencido) y con fecha_vencimiento dentro de los próximos
// DIAS_POR_VENCER días -- mismo criterio que usa el widget del Dashboard,
// para que el número que ves ahí y lo que filtra acá coincidan.
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
    // más abajo (estadoOperativoSocio), a partir de datos reales.
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
  const { usuario } = useAuth()
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
  // Aparatos REALMENTE vigente por DNI (fila real en user_credits,
  // discipline kind='membership', expires_at > ahora) -- mismo criterio
  // que creditosPorDni, pero para Aparatos. Fuente de verdad para
  // aparatosActivoReal() en NuevoSocioModal.jsx/SociosTabla.jsx/
  // CreditosEditablesSocio.jsx: BUG REAL (caso Arianna Isgro, DNI
  // 51705419) -- esas tres funciones decidían "¿Aparatos activo?" mirando
  // SOLO socios.fecha_vencimiento, sin confirmar que hubiera una fila real
  // detrás. Un residuo (import de CrossFy, el campo viejo ya eliminado de
  // Editar Socio) podía dejar esa columna con una fecha futura sin que le
  // correspondiera nada real -- el checkbox/columna "mentían" Aparatos
  // activo. Un dni ausente de este Map significa "no hay nada real".
  const [aparatosVigentePorDni, setAparatosVigentePorDni] = useState(new Map())
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
    fetchAparatosVigentePorDni(socios.map((s) => s.dni)).then(setAparatosVigentePorDni)
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
        // CAMBIO 3 (bug real: "Activo" sin nada real) -- estadoOperativoSocio()
        // necesita `creditosPwaPorDisciplina` YA mergeado para poder decidir
        // bien un socio 100% créditos, sin fecha_vencimiento -- se arma el
        // objeto completo ANTES de llamarla, no después.
        const creditosPwaPorDisciplina = creditosPorDni.get(socio.dni) ?? []
        return {
          ...socio,
          estado: estadoOperativoSocio({ ...socio, creditosPwaPorDisciplina }),
          avatarUrl: gamificacion?.avatarUrl ?? null,
          nivelXp: gamificacion?.nivel ?? null,
          creditosPwaPorDisciplina,
          // Caso Arianna Isgro -- ver aparatosActivoReal() en
          // SociosTabla.jsx/NuevoSocioModal.jsx/CreditosEditablesSocio.jsx:
          // esas tres funciones ya no calculan esto desde fecha_vencimiento,
          // leen este campo directo.
          aparatosVigenteReal: aparatosVigentePorDni.get(socio.dni) === true,
        }
      }),
    [socios, gamificacionPorDni, creditosPorDni, aparatosVigentePorDni],
  )

  const counts = useMemo(() => {
    const metrics = getSocioMetrics(sociosConEstado)
    return {
      activo: metrics.activos,
      vencido: metrics.vencidos,
      nuevo: sociosConEstado.filter((s) => esDelMesActual(s.fechaInicio)).length,
    }
  }, [sociosConEstado])

  // Simplificación de tarjetas de KPI -- mismo criterio que ya se aplicó al
  // filtro dropdown y al badge de fila (Activo/Por Vencer/Inactivo, ver
  // tickets anteriores): se sacan "Cuota Vencida" y "En Tolerancia" (esta
  // última ya no existía, se sacó en el ticket que sacó la tolerancia del
  // todo) -- quedan solo "Socios Activos" y "Nuevos del Mes". `counts.vencido`
  // sigue viviendo en `counts` (getSocioMetrics lo sigue distinguiendo
  // internamente, lo necesitan Home/Reportes) aunque ya no tenga tarjeta
  // propia acá.
  const kpis = [
    { key: 'activo', testId: 'kpi-activos', label: 'Socios Activos', value: counts.activo, icon: Users },
    { key: 'nuevo', testId: 'kpi-nuevos', label: 'Nuevos del Mes', value: counts.nuevo, icon: UserPlus },
  ]

  const sociosFiltrados = useMemo(() => {
    const termino = busqueda.trim().toLowerCase()

    return sociosConEstado.filter((socio) => {
      const coincideBusqueda =
        termino === '' ||
        `${socio.nombre} ${socio.apellido}`.toLowerCase().includes(termino) ||
        (socio.dni ?? '').toLowerCase().includes(termino)

      // CAMBIO 2 -- 'inactivo' agrupa TANTO al dado de baja (socio.activo
      // === false) COMO al de cuota vencida (estadoOperativoSocio ya
      // devuelve 'inactivo' para el primer caso y 'vencido' para el
      // segundo, ver socioMetrics.js) -- ya no son dos opciones separadas
      // del desplegable (antes 'inactivo_cuenta' y 'vencido').
      //
      // BUG REAL (URGENTE, filtro "Inactivo" mostrando socios con badge
      // "Activo") -- esto compara contra `socio.estado`, que sale de
      // estadoOperativoSocio() -- el fix real estaba ahí, no acá: esa
      // función podía devolver 'vencido' para un socio con créditos reales
      // vigentes en otra disciplina (si Aparatos estaba vencido/residual y
      // fecha_vencimiento nunca se sincronizó con el resto del plan),
      // mientras EstadoBadge (que NO mira fecha_vencimiento si hay
      // créditos reales) mostraba "Activo" -- ver el comentario completo en
      // socioMetrics.js. Ya arreglado ahí; esta comparación en sí siempre
      // estuvo bien.
      const coincideEstado =
        filtroEstado === 'todos'
          ? true
          : filtroEstado === 'inactivo'
            ? socio.estado === 'inactivo' || socio.estado === 'vencido'
            : socio.activo === false
              ? false
              : filtroEstado === 'nuevo'
                ? esDelMesActual(socio.fechaInicio)
                : filtroEstado === 'por_vencer'
                  ? estaPorVencer(socio)
                  : socio.estado === filtroEstado // 'activo'

      const coincidePlan = filtroPlan === 'todos' || disciplinasRealesDelSocio(socio).includes(filtroPlan)

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

  // Reemplaza al viejo ajuste incremental sobre `socios.creditos` (steppers
  // sueltos en la fila de la tabla, ver handleAjustarCredito -- eliminado):
  // ahora la edición de créditos vive en CreditosEditablesSocio.jsx, dentro
  // de "Editar Socio", y llama directo a los RPCs
  // admin_fijar_creditos_disciplina/admin_ajustar_credito_disciplina (ver
  // supabase_migration_editar_creditos_disciplina.sql). Esta función solo
  // refresca lo que la tabla ya tenía: el mismo fetch batch que corre al
  // cargar la lista, para que el total que se ve en CreditosCell quede al
  // día apenas se cierra el modal después de un cambio.
  const refrescarCreditosPwa = () => {
    if (socios.length === 0) return
    fetchCreditosPorDisciplina(socios.map((s) => s.dni)).then(setCreditosPorDni)
    // "+ Agregar Aparatos" (CreditosEditablesSocio.jsx) dispara este mismo
    // callback -- sin este refresh, aparatosVigenteReal quedaría
    // desactualizado hasta el próximo fetchSocios() completo.
    fetchAparatosVigentePorDni(socios.map((s) => s.dni)).then(setAparatosVigentePorDni)
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
      // FIX (modelo de "plan único") -- ANTES sumaba sobre el pozo global
      // viejo (`(socio.creditos ?? 0) + total`), el mismo modelo aditivo
      // que el resto de esta sesión viene reemplazando en todos lados.
      // Ahora es el total de ESTE pago nada más -- coincide con lo que
      // admin_acreditar_creditos_manual() (más abajo) va a dejar en
      // user_credits para un socio CON cuenta PWA (ese RPC recalcula
      // socios.creditos por su cuenta, así que este valor queda pisado
      // enseguida ahí); para uno SIN cuenta (no hay ningún RPC que corra,
      // ver más abajo), este es el único valor posible y queda como
      // definitivo.
      cambios.creditos = payload.creditosPorDisciplina.reduce((suma, item) => suma + item.cantidad, 0)
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
      // FIX (modelo de "plan único") -- este valor es la fecha que Seba
      // eligió en el modal, no necesariamente el vencimiento REAL de
      // Aparatos (ej. un cobro 100% de créditos, sin Aparatos incluido).
      // Para un socio CON cuenta PWA, admin_acreditar_creditos_manual()
      // (más abajo) la pisa enseguida con el estado real post-reseteo --
      // este valor queda como escritura INICIAL/fallback, no la
      // definitiva. Para un socio SIN cuenta PWA (no hay ningún
      // user_credits real del que derivar nada -- import masivo de
      // Crossfy, socio sin DNI, etc.), no hay ningún RPC que corra
      // después, así que este es el único valor posible y se mantiene tal
      // cual -- mismo comportamiento de siempre para ese caso.
      cambios.fecha_vencimiento = payload.vencimiento.fechaVencimiento
      cambios.dia_corte = new Date(`${payload.vencimiento.fechaVencimiento}T00:00:00`).getDate()
      cambios.estado = 'Activo'
    }

    // Todo el flujo de cobro (socios + créditos/vencimiento + historial)
    // queda envuelto en un único try/catch -- antes, cualquier excepción
    // inesperada (no el `updateError` ya chequeado abajo, sino un fallo real
    // de red/RLS en admin_acreditar_creditos_manual, que no tiene su propio
    // try/catch) se colaba sin capturar: la promesa que devuelve esta
    // función quedaba rechazada, RegistrarPagoModal nunca llegaba a su
    // `setGuardando(false)` y el modal quedaba trabado en "Guardando..."
    // para siempre, sin ningún mensaje para Seba. Acá se loguea siempre el
    // mensaje EXACTO que devuelve Supabase (nunca un genérico vacío) y se
    // lo avisa.
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

      // Resuelto UNA sola vez -- se reusa tanto para
      // admin_acreditar_creditos_manual (abajo) como para el historial de
      // pagos más abajo (antes se resolvía dos veces, con dos consultas
      // idénticas a `profiles`).
      const userId = await resolverUserIdPorDni(socio.dni)

      // FIX (Fase 2, modelo de "plan único") -- ANTES esto era
      // sincronizarCreditosPwa() por disciplina (sumaba un delta sobre el
      // balance existente) + sincronizarVencimientoPwa()/
      // sincronizarVencimientoCreditoPwa() por separado para el
      // vencimiento -- exactamente el sistema aditivo/de lotes que generaba
      // el bug de doble vencimiento cada vez que se cobraba. Ahora es UN
      // SOLO RPC atómico (admin_acreditar_creditos_manual, Fase 1, ya en
      // producción): resetea todo lo previo del socio y acredita
      // exactamente lo que Seba cargó en este cobro, con una sola fecha de
      // vencimiento para todo -- mismo criterio que "Nuevo Socio" (ver
      // NuevoSocioModal.jsx).
      //
      // Consecuencia directa: una disciplina de créditos tildada en este
      // cobro pero SIN cantidad cargada (antes preservaba su balance y solo
      // extendía la fecha, vía sincronizarVencimientoCreditoPwa) ahora
      // resetea a 0 igual que cualquier disciplina no tildada -- bajo plan
      // único ya no existe el concepto de "renovar la fecha sin re-cargar
      // los créditos", es la MISMA regla que ya rige en todos lados
      // (acreditar_pack, CreditosEditablesSocio.jsx): lo que no se
      // re-acredita explícitamente, se pierde.
      if (userId) {
        const pCreditos = []
        for (const { disciplina, cantidad } of payload.creditosPorDisciplina ?? []) {
          const disciplineId = await resolverDisciplinaId(disciplina)
          if (!disciplineId) {
            mensaje = `Pago registrado, pero no se encontró "${disciplina}" en el catálogo de Disciplinas -- sus créditos no se pudieron cargar.`
            continue
          }
          pCreditos.push({ discipline_id: disciplineId, credits: cantidad })
        }

        // payload.vencimiento SIEMPRE viene poblado en este flujo --
        // tieneVencimiento (RegistrarPagoModal.jsx) es true apenas hay algún
        // plan tildado, y el modal ya bloquea el submit con
        // planes.length===0 -- se asume acá tal cual, mismo criterio que ya
        // tenía este bloque antes de este cambio.
        const incluyeAparatos = planesDeVencimiento(payload.plan ?? socio.plan).length > 0

        if (pCreditos.length > 0 || incluyeAparatos) {
          const diasVigencia = diferenciaEnDias(payload.vencimiento.fechaInicio, payload.vencimiento.fechaVencimiento)
          const { error: errorAcreditar } = await supabase.rpc('admin_acreditar_creditos_manual', {
            p_user_id: userId,
            p_creditos: pCreditos,
            p_incluye_aparatos: incluyeAparatos,
            p_dias_vigencia: diasVigencia,
            p_fecha_inicio: payload.vencimiento.fechaInicio,
          })
          if (errorAcreditar) {
            console.error('ERROR admin_acreditar_creditos_manual SUPABASE:', errorAcreditar)
            mensaje = 'Pago registrado, pero no se pudo sincronizar con la app. Revisá la consola.'
          }
        }
      }
      // userId null -- socio sin cuenta PWA todavía: el pago YA quedó
      // registrado en `socios` arriba, mismo criterio "fail open" de
      // siempre, solo no hay nada que sincronizar del lado de la app.

      // Historial de pagos (Ficha 360°) -- best-effort: si el socio todavía no
      // tiene cuenta PWA, o pagos_socio no está desplegada, el pago YA se
      // registró arriba (socios + créditos/vencimiento), así que no hay que
      // cortar el flujo por esto, solo no queda un renglón en el historial.
      // Antes este catch solo logueaba a consola -- si `pagos_socio` SÍ
      // existe pero el insert falla por una razón real (nombre de campo mal,
      // constraint, RLS), Seba veía igual "Pago registrado correctamente"
      // sin ninguna pista de que el historial no se guardó.
      if (userId) {
        try {
          await registrarPago({
            userId,
            paquete: formatearPlanes(payload.plan ?? socio.plan),
            monto: payload.monto,
            metodoPago: payload.metodoPago,
            // Para planes con vencimiento el período es el que Seba eligió en el
            // modal (puede no arrancar hoy); para planes de créditos no hay rango
            // de fechas, así que el período queda simplemente en "hoy". Se lee
            // DIRECTO de payload.vencimiento (no de cambios.fecha_vencimiento --
            // esa columna ahora la escribe admin_acreditar_creditos_manual con
            // el estado REAL de Aparatos, que puede no coincidir con la fecha
            // que Seba eligió acá si este cobro no incluye Aparatos): el
            // historial tiene que reflejar el período de ESTE pago puntual, no
            // el vencimiento de Aparatos.
            periodoDesde: payload.vencimiento?.fechaInicio ?? hoy,
            periodoHasta: payload.vencimiento?.fechaVencimiento ?? null,
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
      {/* Solo 2 tarjetas (se sacaron "Cuota Vencida" y "En Tolerancia") --
          grilla tope en sm:grid-cols-2 con ancho acotado, en vez de la de 4
          columnas de antes: dos tarjetas estiradas a todo el ancho de la
          pantalla en desktop se veían sueltas/desbalanceadas. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:max-w-2xl">
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
          disciplinasActivas={disciplinasActivas}
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
          onCreditosActualizados={refrescarCreditosPwa}
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
