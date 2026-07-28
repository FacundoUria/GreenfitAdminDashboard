import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Clock, Loader2, Plus, Search, UserPlus, Users } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import {
  calcularEstadoCuota,
  esDelMesActual,
  formatFecha,
  hoyISO,
  proximoVencimiento,
  toISODate,
} from '../utils/fecha'
import SociosTabla from '../components/SociosTabla'
import NuevoSocioModal from '../components/NuevoSocioModal'
import { useConfiguracion } from '../context/useConfiguracion'

const filtroOptions = [
  { value: 'todos', label: 'Todos' },
  { value: 'activo', label: 'Activo' },
  { value: 'vencido', label: 'Cuota Vencida' },
  { value: 'tolerancia', label: 'En Tolerancia' },
  { value: 'nuevo', label: 'Nuevos del Mes' },
]

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
  }
}

function Socios() {
  const { configuracion } = useConfiguracion()
  const diasTolerancia = configuracion?.dias_tolerancia ?? 5

  const [socios, setSocios] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busqueda, setBusqueda] = useState('')
  const [filtroEstado, setFiltroEstado] = useState('todos')
  const [modalAbierto, setModalAbierto] = useState(false)
  const [socioEnEdicion, setSocioEnEdicion] = useState(null)

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

      const coincideEstado =
        filtroEstado === 'todos'
          ? true
          : filtroEstado === 'nuevo'
            ? esDelMesActual(socio.fechaInicio)
            : (socio.estado ?? '').toLowerCase() === filtroEstado

      return coincideBusqueda && coincideEstado
    })
  }, [sociosConEstado, busqueda, filtroEstado])

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

  const handleAjustarCredito = async (socio, delta) => {
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

    fetchSocios()
  }

  const handleRegistrarPago = async (socio) => {
    const hoy = hoyISO()
    // Ciclo fijo: el próximo vencimiento sale de sumar 1 mes a la fecha_vencimiento
    // anterior (nunca de sumar días a HOY), así una cuota pagada tarde no corre el
    // ciclo de cobro hacia adelante. `dia_corte` es el ancla fija de ese cálculo.
    const diaCorte = socio.diaCorte ?? new Date(`${socio.fechaVencimiento ?? hoy}T00:00:00`).getDate()
    const fechaBaseCiclo = socio.fechaVencimiento ?? hoy
    const nuevoVencimiento = toISODate(proximoVencimiento(fechaBaseCiclo, diaCorte))

    const { data, error: updateError } = await supabase
      .from('socios')
      .update({
        estado: 'Activo',
        ultimo_pago: hoy,
        fecha_vencimiento: nuevoVencimiento,
        dia_corte: diaCorte,
      })
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

    fetchSocios()
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
              className="w-full rounded-lg border border-white/10 bg-greenfit-card py-2 pl-9 pr-3 text-sm text-white placeholder:text-gray-500 outline-none focus:border-greenfit-primary"
            />
          </div>

          <select
            value={filtroEstado}
            onChange={(event) => setFiltroEstado(event.target.value)}
            className="rounded-lg border border-white/10 bg-greenfit-card px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
          >
            {filtroOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={handleAbrirNuevoSocio}
          className="flex items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Nuevo Socio
        </button>
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
          onRegistrarPago={handleRegistrarPago}
          onEditar={handleEditar}
          onAjustarCredito={handleAjustarCredito}
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
        />
      )}
    </div>
  )
}

export default Socios
