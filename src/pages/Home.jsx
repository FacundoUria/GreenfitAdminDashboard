import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  Clock,
  Loader2,
  UserPlus,
  Users,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { colorOcupacion } from '../utils/ocupacion'
import { diaActualPorDefecto, fechaDeEstaSemana, mapearClasesDesdeBookings } from '../utils/clases'
import { calcularEstadoCuota } from '../utils/fecha'
import { useConfiguracion } from '../context/useConfiguracion'

const usuario = 'Seba'

function urgenciaVencimiento(dias) {
  return dias <= 1 ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'
}

function horaActualStr() {
  const ahora = new Date()
  return `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`
}

function diasHastaVencimiento(socio) {
  if (!socio.fecha_vencimiento) return null

  const vencimiento = new Date(`${socio.fecha_vencimiento}T00:00:00`)
  const msPorDia = 1000 * 60 * 60 * 24
  return Math.ceil((vencimiento.getTime() - Date.now()) / msPorDia)
}

function Home() {
  const navigate = useNavigate()
  const { configuracion } = useConfiguracion()
  const diasTolerancia = configuracion?.dias_tolerancia ?? 5
  const [socios, setSocios] = useState([])
  const [clasesHoy, setClasesHoy] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchDatos = async () => {
    setLoading(true)
    setError(null)

    const diaHoy = diaActualPorDefecto()
    const fechaHoy = fechaDeEstaSemana(diaHoy)

    const [sociosResult, clasesResult, bookingsResult] = await Promise.all([
      supabase.from('socios').select('*'),
      supabase
        .from('classes')
        .select('*')
        .contains('days_of_week', [diaHoy])
        .order('start_time', { ascending: true }),
      supabase.from('bookings').select('id, user_id, class_id, attended, profiles(full_name, dni)').eq('booking_date', fechaHoy),
    ])

    if (sociosResult.error || clasesResult.error) {
      console.error(
        'Error al cargar métricas desde Supabase:',
        sociosResult.error?.message ?? clasesResult.error?.message,
      )
      setError('No se pudieron cargar las métricas. Verificá la conexión con Supabase.')
      setLoading(false)
      return
    }

    if (bookingsResult.error) {
      console.error('Error al cargar inscriptos en Home:', bookingsResult.error.message)
    }

    setSocios(sociosResult.data ?? [])
    setClasesHoy(mapearClasesDesdeBookings(clasesResult.data ?? [], bookingsResult.data ?? []))
    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchDatos()
  }, [])

  const sociosActivos = socios.filter(
    (s) => calcularEstadoCuota(s.fecha_vencimiento, diasTolerancia) === 'activo',
  ).length
  const cuotasVencidas = socios.filter(
    (s) => calcularEstadoCuota(s.fecha_vencimiento, diasTolerancia) === 'vencido',
  ).length
  const sociosTolerancia = socios.filter(
    (s) => calcularEstadoCuota(s.fecha_vencimiento, diasTolerancia) === 'tolerancia',
  ).length

  const proximasClases = useMemo(() => {
    const horaActual = horaActualStr()
    const restantes = clasesHoy
      .filter((clase) => clase.horaInicio >= horaActual)
      .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio))
    return (restantes.length > 0 ? restantes : clasesHoy).slice(0, 4)
  }, [clasesHoy])

  const sociosPorVencerCompleto = useMemo(
    () =>
      socios
        .map((s) => ({ nombre: s.nombre, apellido: s.apellido, diasRestantes: diasHastaVencimiento(s) }))
        .filter((s) => s.diasRestantes !== null && s.diasRestantes >= 0 && s.diasRestantes <= 7)
        .sort((a, b) => a.diasRestantes - b.diasRestantes),
    [socios],
  )
  const sociosPorVencer = useMemo(() => sociosPorVencerCompleto.slice(0, 5), [sociosPorVencerCompleto])

  const ultimasAsistencias = useMemo(
    () =>
      clasesHoy
        .slice()
        .sort((a, b) => b.horaInicio.localeCompare(a.horaInicio))
        .flatMap((clase) =>
          clase.inscriptos
            .filter((i) => i.asistio === true)
            .map((i) => ({
              nombre: i.nombre,
              disciplina: clase.disciplina,
              horaInicio: clase.horaInicio,
            })),
        )
        .slice(0, 5),
    [clasesHoy],
  )

  const kpis = [
    { label: 'Socios Activos', value: `${sociosActivos}`, icon: Users },
    {
      label: 'Cuotas Vencidas',
      value: `${cuotasVencidas}`,
      icon: AlertCircle,
      alerta: cuotasVencidas > 0,
    },
    { label: 'En Tolerancia', value: `${sociosTolerancia}`, icon: Clock },
    {
      label: 'Próximos a Vencer (7 días)',
      value: `${sociosPorVencerCompleto.length}`,
      icon: CalendarClock,
      alerta: sociosPorVencerCompleto.length > 0,
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-xl border border-white/5 bg-greenfit-card p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">¡Hola, {usuario}! 👋</h2>
          <p className="text-sm text-gray-400">Resumen general del estado de GreenFit al día de hoy.</p>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <button
            type="button"
            onClick={() => navigate('/socios')}
            className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-3.5 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
          >
            <UserPlus className="h-4 w-4" />
            Registrar Socio
          </button>
          <button
            type="button"
            onClick={() => navigate('/clases')}
            className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-white/10 px-3.5 py-2 text-sm font-medium text-gray-200 transition-colors hover:bg-white/5 hover:text-white"
          >
            <CalendarPlus className="h-4 w-4" />
            Crear Clase
          </button>
          <button
            type="button"
            onClick={() => navigate('/reportes')}
            className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-white/10 px-3.5 py-2 text-sm font-medium text-gray-200 transition-colors hover:bg-white/5 hover:text-white"
          >
            <BarChart3 className="h-4 w-4" />
            Ver Reportes
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-greenfit-card p-10 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Cargando métricas...
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-10 text-center text-sm text-red-400">
          <p>{error}</p>
          <button
            type="button"
            onClick={fetchDatos}
            className="rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10"
          >
            Reintentar
          </button>
        </div>
      ) : (
        <>
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

              {proximasClases.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400">
                  No hay clases programadas para hoy.
                </p>
              ) : (
                <ul className="divide-y divide-white/5">
                  {proximasClases.map((clase) => {
                    const porcentaje = Math.round((clase.inscriptos.length / clase.cupoMaximo) * 100)
                    const { texto } = colorOcupacion(porcentaje)

                    return (
                      <li key={clase.id} className="flex items-center justify-between gap-3 py-3">
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
                          {clase.inscriptos.length}/{clase.cupoMaximo}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <div className="flex flex-col gap-6">
              <div className="rounded-xl border border-white/5 bg-greenfit-card p-5">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-white">Cuotas por Vencer (7 días)</h3>
                  <Link
                    to="/socios"
                    className="flex items-center gap-1 text-xs font-medium text-greenfit-primary hover:opacity-80"
                  >
                    Ir a Socios
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>

                {sociosPorVencer.length === 0 ? (
                  <p className="py-8 text-center text-sm text-gray-400">
                    No hay cuotas por vencer en los próximos 7 días.
                  </p>
                ) : (
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
                          Vence en {socio.diasRestantes} día{socio.diasRestantes === 1 ? '' : 's'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="rounded-xl border border-white/5 bg-greenfit-card p-5">
                <h3 className="mb-4 text-base font-semibold text-white">Últimas Asistencias</h3>
                {ultimasAsistencias.length === 0 ? (
                  <p className="py-8 text-center text-sm text-gray-400">
                    Todavía no se registraron asistencias hoy.
                  </p>
                ) : (
                  <ul className="divide-y divide-white/5">
                    {ultimasAsistencias.map((asistencia, index) => (
                      <li
                        key={`${asistencia.nombre}-${index}`}
                        className="flex items-center justify-between gap-3 py-2.5"
                      >
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-greenfit-primary" />
                          <span className="text-sm text-white">{asistencia.nombre}</span>
                        </div>
                        <span className="text-xs text-gray-400">
                          {asistencia.disciplina} · {asistencia.horaInicio}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default Home
