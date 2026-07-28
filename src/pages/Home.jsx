import { Link, useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  Clock,
  Percent,
  UserPlus,
  Users,
} from 'lucide-react'
import { colorOcupacion } from '../utils/ocupacion'

const usuario = 'Seba'

const clasesHoy = [
  { disciplina: 'Funcional', horaInicio: '07:00', horaFin: '08:00', profesor: 'Rodrigo Pereyra', inscriptos: 12, cupoMaximo: 18 },
  { disciplina: 'Crossfit', horaInicio: '08:00', horaFin: '09:00', profesor: 'Franco Díaz', inscriptos: 18, cupoMaximo: 20 },
  { disciplina: 'Musculación', horaInicio: '09:30', horaFin: '10:30', profesor: 'Ana Belén Castro', inscriptos: 9, cupoMaximo: 15 },
  { disciplina: 'Yoga', horaInicio: '11:00', horaFin: '12:00', profesor: 'Martina Ruiz', inscriptos: 14, cupoMaximo: 20 },
  { disciplina: 'Funcional', horaInicio: '17:00', horaFin: '18:00', profesor: 'Rodrigo Pereyra', inscriptos: 16, cupoMaximo: 18 },
  { disciplina: 'Crossfit', horaInicio: '18:30', horaFin: '19:30', profesor: 'Franco Díaz', inscriptos: 20, cupoMaximo: 20 },
  { disciplina: 'Yoga', horaInicio: '19:00', horaFin: '20:00', profesor: 'Martina Ruiz', inscriptos: 11, cupoMaximo: 20 },
  { disciplina: 'Musculación', horaInicio: '20:00', horaFin: '21:00', profesor: 'Ana Belén Castro', inscriptos: 6, cupoMaximo: 15 },
]

const sociosPorVencer = [
  { nombre: 'Camila', apellido: 'Ibáñez', diasRestantes: 1 },
  { nombre: 'Diego', apellido: 'Molina', diasRestantes: 2 },
  { nombre: 'Sofía', apellido: 'Ramírez', diasRestantes: 2 },
  { nombre: 'Tomás', apellido: 'Herrera', diasRestantes: 3 },
]

const ultimasAsistencias = [
  { nombre: 'Lucía', apellido: 'Gómez', hora: '09:15' },
  { nombre: 'Nicolás', apellido: 'Torres', hora: '09:08' },
  { nombre: 'Valentina', apellido: 'Suárez', hora: '08:57' },
  { nombre: 'Federico', apellido: 'Álvarez', hora: '08:42' },
  { nombre: 'Bruno', apellido: 'Acosta', hora: '08:30' },
]

function urgenciaVencimiento(dias) {
  return dias <= 1 ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'
}

function horaActualStr() {
  const ahora = new Date()
  return `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`
}

function Home() {
  const navigate = useNavigate()
  const horaActual = horaActualStr()

  const restantesHoy = clasesHoy
    .filter((clase) => clase.horaInicio >= horaActual)
    .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio))
  const proximasClases = (restantesHoy.length > 0 ? restantesHoy : clasesHoy).slice(0, 4)

  const ocupacionPromedio = Math.round(
    clasesHoy.reduce((total, clase) => total + (clase.inscriptos / clase.cupoMaximo) * 100, 0) /
      clasesHoy.length,
  )

  const kpis = [
    { label: 'Socios Presentes Hoy', value: '42 asistencias', icon: Users },
    { label: 'Clases Programadas Hoy', value: `${clasesHoy.length} clases`, icon: CalendarDays },
    { label: 'Cuotas Vencidas este Mes', value: '15', icon: AlertCircle, alerta: true },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-xl border border-white/5 bg-greenfit-card p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">¡Hola, {usuario}! 👋</h2>
          <p className="text-sm text-gray-400">Cierre de turno y resumen de hoy.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => navigate('/socios')}
            className="flex items-center gap-2 rounded-lg bg-greenfit-primary px-3.5 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
          >
            <UserPlus className="h-4 w-4" />
            Registrar Socio
          </button>
          <button
            type="button"
            onClick={() => navigate('/clases')}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3.5 py-2 text-sm font-medium text-gray-200 transition-colors hover:bg-white/5 hover:text-white"
          >
            <CalendarPlus className="h-4 w-4" />
            Crear Clase
          </button>
          <button
            type="button"
            onClick={() => navigate('/reportes')}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3.5 py-2 text-sm font-medium text-gray-200 transition-colors hover:bg-white/5 hover:text-white"
          >
            <BarChart3 className="h-4 w-4" />
            Ver Reportes
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map(({ label, value, icon: Icon, alerta }) => (
          <div
            key={label}
            className="flex items-center gap-4 rounded-xl border border-white/5 bg-greenfit-card p-5"
          >
            <div
              className={`flex h-11 w-11 items-center justify-center rounded-lg ${
                alerta ? 'bg-red-500/15' : 'bg-greenfit-primary/15'
              }`}
            >
              <Icon className={`h-5 w-5 ${alerta ? 'text-red-400' : 'text-greenfit-primary'}`} />
            </div>
            <div>
              <p className="text-sm text-gray-400">{label}</p>
              <p className={`text-2xl font-semibold ${alerta ? 'text-red-400' : 'text-white'}`}>
                {value}
              </p>
            </div>
          </div>
        ))}

        <div className="rounded-xl border border-white/5 bg-greenfit-card p-5">
          <div className="mb-3 flex items-center gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-greenfit-primary/15">
              <Percent className="h-5 w-5 text-greenfit-primary" />
            </div>
            <div>
              <p className="text-sm text-gray-400">Ocupación Promedio de Hoy</p>
              <p className="text-2xl font-semibold text-white">{ocupacionPromedio}%</p>
            </div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full transition-all ${colorOcupacion(ocupacionPromedio).barra}`}
              style={{ width: `${ocupacionPromedio}%` }}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-white/5 bg-greenfit-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-base font-semibold text-white">Próximas Clases de Hoy</h3>
            <Link
              to="/clases"
              className="flex items-center gap-1 text-xs font-medium text-greenfit-primary hover:opacity-80"
            >
              Ver todas en Clases
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <ul className="divide-y divide-white/5">
            {proximasClases.map((clase, index) => {
              const porcentaje = Math.round((clase.inscriptos / clase.cupoMaximo) * 100)
              const { texto } = colorOcupacion(porcentaje)

              return (
                <li
                  key={`${clase.disciplina}-${clase.horaInicio}-${index}`}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-14 flex-col items-center justify-center rounded-lg bg-white/5 text-xs text-gray-300">
                      <Clock className="mb-0.5 h-3.5 w-3.5 text-gray-500" />
                      {clase.horaInicio}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">{clase.disciplina}</p>
                      <p className="text-xs text-gray-400">Prof. {clase.profesor}</p>
                    </div>
                  </div>
                  <span className={`text-sm font-medium ${texto}`}>
                    {clase.inscriptos}/{clase.cupoMaximo}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="flex flex-col gap-6">
          <div className="rounded-xl border border-white/5 bg-greenfit-card p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">Cuotas por Vencer (3 días)</h3>
              <Link
                to="/socios"
                className="flex items-center gap-1 text-xs font-medium text-greenfit-primary hover:opacity-80"
              >
                Ir a Socios
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            <ul className="divide-y divide-white/5">
              {sociosPorVencer.map((socio) => (
                <li
                  key={`${socio.nombre}-${socio.apellido}`}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <span className="text-sm text-white">
                    {socio.nombre} {socio.apellido}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${urgenciaVencimiento(
                      socio.diasRestantes,
                    )}`}
                  >
                    Vence en {socio.diasRestantes} día{socio.diasRestantes > 1 ? 's' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-white/5 bg-greenfit-card p-5">
            <h3 className="mb-4 text-base font-semibold text-white">Últimas Asistencias</h3>
            <ul className="divide-y divide-white/5">
              {ultimasAsistencias.map((asistencia) => (
                <li
                  key={`${asistencia.nombre}-${asistencia.hora}`}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-greenfit-primary" />
                    <span className="text-sm text-white">
                      {asistencia.nombre} {asistencia.apellido}
                    </span>
                  </div>
                  <span className="text-xs text-gray-400">{asistencia.hora}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Home
