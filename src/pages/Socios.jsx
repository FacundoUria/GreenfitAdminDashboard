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
import {
  calcularEstadoCuota,
  esDelMesActual,
  formatFecha,
  hoyISO,
  proximoVencimiento,
  toISODate,
} from '../utils/fecha'
import { planesDeCreditos, PLANES_DISPONIBLES } from '../utils/planes'
import { sincronizarCreditosPwa, sincronizarVencimientoPwa, sincronizarEstadoCuentaPwa } from '../utils/creditosPwa'
import SociosTabla from '../components/SociosTabla'
import NuevoSocioModal from '../components/NuevoSocioModal'
import RegistrarPagoModal from '../components/RegistrarPagoModal'
import WhatsAppModal from '../components/WhatsAppModal'
import { useConfiguracion } from '../context/useConfiguracion'

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
    ultimoPago: formatFecha(row.ultimo_pago),
    creditos: row.creditos ?? 0,
    activo: row.activo ?? true,
  }
}

function Socios() {
  const { configuracion } = useConfiguracion()
  const diasTolerancia = configuracion?.dias_tolerancia ?? 5
  const [searchParams] = useSearchParams()

  const [socios, setSocios] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busqueda, setBusqueda] = useState('')
  // El Dashboard linkea acá con ?filtro=por_vencer (u otro value de
  // filtroOptions) para llegar con la lista ya filtrada.
  const [filtroEstado, setFiltroEstado] = useState(
    () => filtroOptions.find((o) => o.value === searchParams.get('filtro'))?.value ?? 'activo',
  )
  const [filtroPlan, setFiltroPlan] = useState('todos')
  const [modalAbierto, setModalAbierto] = useState(false)
  const [socioEnEdicion, setSocioEnEdicion] = useState(null)
  const [socioParaPago, setSocioParaPago] = useState(null)
  const [toastMessage, setToastMessage] = useState(null)
  const [seleccionados, setSeleccionados] = useState(new Set())
  const [whatsappDestinatarios, setWhatsappDestinatarios] = useState(null)
  const [whatsappPreset, setWhatsappPreset] = useState(null)

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

  const sociosConEstado = useMemo(
    () =>
      socios.map((socio) => ({
        ...socio,
        estado: calcularEstadoCuota(socio.fechaVencimiento, diasTolerancia) ?? socio.estadoDb,
      })),
    [socios, diasTolerancia],
  )

  const counts = useMemo(
    () => ({
      activo: sociosConEstado.filter((s) => (s.estado ?? '').toLowerCase() === 'activo').length,
      vencido: sociosConEstado.filter((s) => (s.estado ?? '').toLowerCase() === 'vencido').length,
      tolerancia: sociosConEstado.filter((s) => (s.estado ?? '').toLowerCase() === 'tolerancia').length,
      nuevo: sociosConEstado.filter((s) => esDelMesActual(s.fechaInicio)).length,
    }),
    [sociosConEstado],
  )

  const kpis = [
    { key: 'activo', label: 'Socios Activos', value: counts.activo, icon: Users },
    { key: 'vencido', label: 'Cuota Vencida', value: counts.vencido, icon: AlertCircle },
    { key: 'tolerancia', label: 'En Tolerancia', value: counts.tolerancia, icon: Clock },
    { key: 'nuevo', label: 'Nuevos del Mes', value: counts.nuevo, icon: UserPlus },
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
    const nuevoValor = Math.max(0, (socio.creditos ?? 0) + delta)

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
      const resultado = await sincronizarCreditosPwa({ dni: socio.dni, disciplina: disciplinaDestino, delta })
      if (!resultado.synced && resultado.reason !== 'sin_cuenta_pwa') {
        setToastMessage(`Créditos del panel actualizados, pero no se pudo sincronizar ${disciplinaDestino} con la app.`)
        setTimeout(() => setToastMessage(null), 4000)
      }
    }

    fetchSocios()
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

    const resultado = await sincronizarEstadoCuentaPwa({ dni: socio.dni, activo: nuevoActivo })
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
      // Ciclo fijo: el próximo vencimiento sale de sumar 1 mes a la fecha_vencimiento
      // anterior (nunca de sumar días a HOY), así una cuota pagada tarde no corre el
      // ciclo de cobro hacia adelante. `dia_corte` es el ancla fija de ese cálculo.
      const diaCorte = socio.diaCorte ?? new Date(`${socio.fechaVencimiento ?? hoy}T00:00:00`).getDate()
      const fechaBaseCiclo = socio.fechaVencimiento ?? hoy
      cambios.fecha_vencimiento = toISODate(proximoVencimiento(fechaBaseCiclo, diaCorte))
      cambios.dia_corte = diaCorte
      cambios.estado = 'Activo'
    }

    const { data, error: updateError } = await supabase
      .from('socios')
      .update(cambios)
      .eq('id', socio.id)
      .select()

    // Supabase/RLS puede devolver 200/204 "exitoso" afectando 0 filas (sin `error`)
    // si una policy bloquea el UPDATE. Sin este chequeo, el pago parecería
    // registrarse y en realidad no se guardaría nada.
    if (updateError || !data || data.length === 0) {
      console.error(
        'Error al registrar el pago en Supabase:',
        updateError?.message ?? 'no se actualizó ninguna fila (revisá las políticas RLS)',
      )
      window.alert('No se pudo registrar el pago. Intentá nuevamente.')
      return
    }

    let mensaje = 'Pago registrado correctamente'
    if (payload.creditosPorDisciplina) {
      for (const { disciplina, cantidad } of payload.creditosPorDisciplina) {
        const resultado = await sincronizarCreditosPwa({ dni: socio.dni, disciplina, delta: cantidad })
        if (!resultado.synced && resultado.reason !== 'sin_cuenta_pwa') {
          mensaje = 'Pago registrado, pero no se pudo sincronizar con la app. Revisá la consola.'
        }
      }
    }
    if (payload.vencimiento) {
      const resultado = await sincronizarVencimientoPwa({
        dni: socio.dni,
        fechaVencimiento: cambios.fecha_vencimiento,
      })
      if (!resultado.synced && resultado.reason !== 'sin_cuenta_pwa') {
        mensaje = 'Pago registrado, pero no se pudo sincronizar con la app. Revisá la consola.'
      }
    }

    setSocioParaPago(null)
    setToastMessage(mensaje)
    setTimeout(() => setToastMessage(null), 2500)
    fetchSocios()
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
        {kpis.map(({ key, label, value, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => handleKpiClick(key)}
            className={`flex items-center gap-4 rounded-xl bg-greenfit-card p-5 text-left transition-shadow ${
              filtroEstado === key ? 'ring-2 ring-greenfit-primary' : 'hover:ring-1 hover:ring-white/10'
            }`}
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-greenfit-primary/15">
              <Icon className="h-5 w-5 text-greenfit-primary" />
            </div>
            <div>
              <p className="text-sm text-gray-400">{label}</p>
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
          onSaved={fetchSocios}
          onBuscarSocioPorDni={(dni) => sociosConEstado.find((s) => s.dni === dni) ?? null}
          onEditarSocioExistente={handleEditar}
        />
      )}

      {socioParaPago && (
        <RegistrarPagoModal
          key={socioParaPago.id}
          socio={socioParaPago}
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
