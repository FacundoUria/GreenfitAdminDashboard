import { useMemo, useState } from 'react'
import { AlertCircle, Clock, Plus, Search, UserPlus, Users } from 'lucide-react'
import SociosTabla from '../components/SociosTabla'
import NuevoSocioModal from '../components/NuevoSocioModal'

function formatFecha(date) {
  return date.toLocaleDateString('es-AR')
}

function diasAtras(dias) {
  const fecha = new Date()
  fecha.setDate(fecha.getDate() - dias)
  return fecha
}

function esNuevoDelMes(fecha) {
  const hoy = new Date()
  return fecha.getMonth() === hoy.getMonth() && fecha.getFullYear() === hoy.getFullYear()
}

const sociosIniciales = [
  {
    id: 1,
    nombre: 'Lucía',
    apellido: 'Gómez',
    dni: '38.451.902',
    email: 'lucia.gomez@mail.com',
    telefono: '11-2345-6789',
    estado: 'activo',
    plan: 'Musculación',
    fechaInicio: diasAtras(3),
    ultimoPago: formatFecha(diasAtras(3)),
  },
  {
    id: 2,
    nombre: 'Martín',
    apellido: 'Fernández',
    dni: '40.123.887',
    email: 'martin.fernandez@mail.com',
    telefono: '11-3456-7890',
    estado: 'vencido',
    plan: 'Crossfit',
    fechaInicio: diasAtras(400),
    ultimoPago: formatFecha(diasAtras(48)),
  },
  {
    id: 3,
    nombre: 'Sofía',
    apellido: 'Ramírez',
    dni: '35.789.234',
    email: 'sofia.ramirez@mail.com',
    telefono: '11-4567-8901',
    estado: 'pendiente',
    plan: 'Pase Libre',
    fechaInicio: diasAtras(60),
    ultimoPago: formatFecha(diasAtras(20)),
  },
  {
    id: 4,
    nombre: 'Nicolás',
    apellido: 'Torres',
    dni: '42.998.112',
    email: 'nicolas.torres@mail.com',
    telefono: '11-5678-9012',
    estado: 'activo',
    plan: 'Musculación',
    fechaInicio: diasAtras(200),
    ultimoPago: formatFecha(diasAtras(10)),
  },
  {
    id: 5,
    nombre: 'Valentina',
    apellido: 'Suárez',
    dni: '39.221.560',
    email: 'valentina.suarez@mail.com',
    telefono: '11-6789-0123',
    estado: 'activo',
    plan: 'Crossfit',
    fechaInicio: diasAtras(5),
    ultimoPago: formatFecha(diasAtras(6)),
  },
  {
    id: 6,
    nombre: 'Diego',
    apellido: 'Molina',
    dni: '37.654.021',
    email: 'diego.molina@mail.com',
    telefono: '11-7890-1234',
    estado: 'vencido',
    plan: 'Pase Libre',
    fechaInicio: diasAtras(500),
    ultimoPago: formatFecha(diasAtras(55)),
  },
  {
    id: 7,
    nombre: 'Camila',
    apellido: 'Ibáñez',
    dni: '41.335.678',
    email: 'camila.ibanez@mail.com',
    telefono: '11-8901-2345',
    estado: 'pendiente',
    plan: 'Musculación',
    fechaInicio: diasAtras(90),
    ultimoPago: formatFecha(diasAtras(18)),
  },
  {
    id: 8,
    nombre: 'Federico',
    apellido: 'Álvarez',
    dni: '36.887.445',
    email: 'federico.alvarez@mail.com',
    telefono: '11-9012-3456',
    estado: 'activo',
    plan: 'Pase Libre',
    fechaInicio: diasAtras(2),
    ultimoPago: formatFecha(diasAtras(1)),
  },
]

const filtroOptions = [
  { value: 'todos', label: 'Todos' },
  { value: 'activo', label: 'Activo' },
  { value: 'vencido', label: 'Cuota Vencida' },
  { value: 'pendiente', label: 'Pendiente' },
  { value: 'nuevo', label: 'Nuevos del Mes' },
]

function Socios() {
  const [socios, setSocios] = useState(sociosIniciales)
  const [busqueda, setBusqueda] = useState('')
  const [filtroEstado, setFiltroEstado] = useState('todos')
  const [modalAbierto, setModalAbierto] = useState(false)

  const counts = useMemo(
    () => ({
      activo: socios.filter((s) => s.estado === 'activo').length,
      vencido: socios.filter((s) => s.estado === 'vencido').length,
      pendiente: socios.filter((s) => s.estado === 'pendiente').length,
      nuevo: socios.filter((s) => esNuevoDelMes(s.fechaInicio)).length,
    }),
    [socios],
  )

  const kpis = [
    { key: 'activo', label: 'Socios Activos', value: counts.activo, icon: Users },
    { key: 'vencido', label: 'Cuota Vencida', value: counts.vencido, icon: AlertCircle },
    { key: 'pendiente', label: 'Pendientes', value: counts.pendiente, icon: Clock },
    { key: 'nuevo', label: 'Nuevos del Mes', value: counts.nuevo, icon: UserPlus },
  ]

  const sociosFiltrados = useMemo(() => {
    const termino = busqueda.trim().toLowerCase()

    return socios.filter((socio) => {
      const coincideBusqueda =
        termino === '' ||
        `${socio.nombre} ${socio.apellido}`.toLowerCase().includes(termino) ||
        socio.dni.toLowerCase().includes(termino)

      const coincideEstado =
        filtroEstado === 'todos'
          ? true
          : filtroEstado === 'nuevo'
            ? esNuevoDelMes(socio.fechaInicio)
            : socio.estado === filtroEstado

      return coincideBusqueda && coincideEstado
    })
  }, [socios, busqueda, filtroEstado])

  const handleKpiClick = (key) => {
    setFiltroEstado((prev) => (prev === key ? 'todos' : key))
  }

  const handleGuardarSocio = (form) => {
    const fechaInicio = form.fechaInicio ? new Date(`${form.fechaInicio}T00:00:00`) : new Date()

    setSocios((prev) => [
      ...prev,
      {
        id: prev.length ? Math.max(...prev.map((s) => s.id)) + 1 : 1,
        nombre: form.nombre,
        apellido: form.apellido,
        dni: form.dni,
        email: form.email,
        telefono: form.telefono,
        plan: form.plan,
        estado: 'activo',
        fechaInicio,
        ultimoPago: formatFecha(fechaInicio),
      },
    ])
    setModalAbierto(false)
  }

  const handleVerFicha = (socio) => {
    window.alert(`Ficha de ${socio.nombre} ${socio.apellido}\nDNI: ${socio.dni}\nPlan: ${socio.plan}`)
  }

  const handleEditar = (socio) => {
    window.alert(`Editar socio: ${socio.nombre} ${socio.apellido} (próximamente)`)
  }

  const handleRegistrarPago = (socio) => {
    setSocios((prev) =>
      prev.map((s) =>
        s.id === socio.id ? { ...s, estado: 'activo', ultimoPago: formatFecha(new Date()) } : s,
      ),
    )
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
          onClick={() => setModalAbierto(true)}
          className="flex items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Nuevo Socio
        </button>
      </div>

      <SociosTabla
        socios={sociosFiltrados}
        onVerFicha={handleVerFicha}
        onRegistrarPago={handleRegistrarPago}
        onEditar={handleEditar}
      />

      <NuevoSocioModal
        open={modalAbierto}
        onClose={() => setModalAbierto(false)}
        onSave={handleGuardarSocio}
      />
    </div>
  )
}

export default Socios
