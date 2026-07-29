import { useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { AlertCircle, Clock, Download, Loader2, UserPlus, Users } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { calcularEstadoCuota, esDelMesActual } from '../utils/fecha'
import { useConfiguracion } from '../context/useConfiguracion'

const DIAS_SEMANA_LABELS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']

const RANGOS = [
  { value: '6m', label: 'Últimos 6 meses' },
  { value: '12m', label: 'Últimos 12 meses' },
  { value: '3a', label: 'Últimos 3 años' },
  { value: 'origen', label: 'Desde el origen' },
]

function calcularInicioRango(rango, fechaOrigen) {
  const ahora = new Date()

  switch (rango) {
    case '12m':
      return new Date(ahora.getFullYear(), ahora.getMonth() - 11, 1)
    case '3a':
      return new Date(ahora.getFullYear(), ahora.getMonth() - 35, 1)
    case 'origen':
      return fechaOrigen ?? new Date(ahora.getFullYear(), ahora.getMonth() - 5, 1)
    case '6m':
    default:
      return new Date(ahora.getFullYear(), ahora.getMonth() - 5, 1)
  }
}

function generarMeses(inicio) {
  const ahora = new Date()
  const meses = []
  const cursor = new Date(inicio.getFullYear(), inicio.getMonth(), 1)
  const limite = new Date(ahora.getFullYear(), ahora.getMonth(), 1)

  while (cursor <= limite) {
    meses.push(new Date(cursor))
    cursor.setMonth(cursor.getMonth() + 1)
  }

  return meses
}

function formatearMes(fecha, conAnio) {
  const nombre = fecha.toLocaleDateString('es-AR', { month: 'short' }).replace('.', '')
  const capitalizado = nombre.charAt(0).toUpperCase() + nombre.slice(1)
  return conAnio ? `${capitalizado} '${String(fecha.getFullYear()).slice(-2)}` : capitalizado
}

function downloadCSV(filename, rows, columnaEtiqueta) {
  const encabezado = columnaEtiqueta === 'dia' ? 'Día' : 'Mes'
  const header = `${encabezado},Valor\n`
  const body = rows.map((row) => `${row[columnaEtiqueta]},${row.valor}`).join('\n')
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()

  URL.revokeObjectURL(url)
}

function KpiCard({ label, value, icon: Icon }) {
  return (
    <div className="flex items-center gap-4 rounded-xl bg-greenfit-card p-5">
      <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-greenfit-primary/15">
        <Icon className="h-5 w-5 text-greenfit-primary" />
      </div>
      <div>
        <p className="text-sm text-gray-400">{label}</p>
        <p className="text-2xl font-semibold text-white">{value}</p>
      </div>
    </div>
  )
}

function ChartCard({ title, data, exportFilename, tipo = 'line', dataKeyX = 'mes' }) {
  const [exporting, setExporting] = useState(false)

  const handleExport = () => {
    setExporting(true)
    downloadCSV(exportFilename, data, dataKeyX)
    setTimeout(() => setExporting(false), 1200)
  }

  const intervaloEjeX = data.length > 24 ? Math.ceil(data.length / 12) : 0

  return (
    <div className="rounded-xl bg-greenfit-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <button
          type="button"
          onClick={handleExport}
          className="flex min-h-[44px] items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-60"
          disabled={exporting}
        >
          <Download className="h-4 w-4" />
          {exporting ? 'Exportando...' : 'Exportar Excel'}
        </button>
      </div>

      <ResponsiveContainer width="100%" height={260}>
        {tipo === 'bar' ? (
          <BarChart data={data} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
            <XAxis dataKey={dataKeyX} stroke="rgba(255,255,255,0.4)" tick={{ fill: '#9CA3AF', fontSize: 12 }} />
            <YAxis
              stroke="rgba(255,255,255,0.4)"
              tick={{ fill: '#9CA3AF', fontSize: 12 }}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1E1E1E',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                color: '#ffffff',
              }}
              labelStyle={{ color: '#9CA3AF' }}
              cursor={{ fill: 'rgba(255,255,255,0.05)' }}
            />
            <Bar dataKey="valor" fill="#80C026" radius={[6, 6, 0, 0]} />
          </BarChart>
        ) : (
          <LineChart data={data} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
            <XAxis
              dataKey={dataKeyX}
              stroke="rgba(255,255,255,0.4)"
              tick={{ fill: '#9CA3AF', fontSize: 12 }}
              interval={intervaloEjeX}
            />
            <YAxis stroke="rgba(255,255,255,0.4)" tick={{ fill: '#9CA3AF', fontSize: 12 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1E1E1E',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                color: '#ffffff',
              }}
              labelStyle={{ color: '#9CA3AF' }}
            />
            <Line
              type="monotone"
              dataKey="valor"
              stroke="#80C026"
              strokeWidth={2}
              dot={data.length <= 24}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

function Reportes() {
  const { configuracion } = useConfiguracion()
  const diasTolerancia = configuracion?.dias_tolerancia ?? 5
  const [socios, setSocios] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [rango, setRango] = useState('6m')

  const fetchSocios = async () => {
    setLoading(true)
    setError(null)

    const { data, error: fetchError } = await supabase.from('socios').select('*')

    if (fetchError) {
      console.error('Error al cargar socios para Reportes:', fetchError.message)
      setError('No se pudieron cargar los datos. Verificá la conexión con Supabase.')
      setSocios([])
    } else {
      setSocios(data ?? [])
    }

    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSocios()
  }, [])

  const kpis = useMemo(
    () => [
      {
        label: 'Socios Activos',
        value: socios.filter((s) => calcularEstadoCuota(s.fecha_vencimiento, diasTolerancia) === 'activo')
          .length,
        icon: Users,
      },
      {
        label: 'Cuota Vencida',
        value: socios.filter((s) => calcularEstadoCuota(s.fecha_vencimiento, diasTolerancia) === 'vencido')
          .length,
        icon: AlertCircle,
      },
      {
        label: 'En Tolerancia',
        value: socios.filter(
          (s) => calcularEstadoCuota(s.fecha_vencimiento, diasTolerancia) === 'tolerancia',
        ).length,
        icon: Clock,
      },
      {
        label: 'Nuevos del mes',
        value: socios.filter((s) => esDelMesActual(s.created_at)).length,
        icon: UserPlus,
      },
    ],
    [socios, diasTolerancia],
  )

  // Fecha de alta del socio más antiguo (para "Desde el origen").
  const fechaOrigen = useMemo(() => {
    const fechas = socios
      .map((s) => s.created_at)
      .filter(Boolean)
      .map((valor) => new Date(valor))
      .filter((f) => !Number.isNaN(f.getTime()))

    if (fechas.length === 0) return null

    const minTime = Math.min(...fechas.map((f) => f.getTime()))
    const min = new Date(minTime)
    return new Date(min.getFullYear(), min.getMonth(), 1)
  }, [socios])

  const meses = useMemo(
    () => generarMeses(calcularInicioRango(rango, fechaOrigen)),
    [rango, fechaOrigen],
  )
  const conAnio = meses.length > 12

  // "Activos por mes": no guardamos un historial de vencimientos pasados, solo
  // el ciclo vigente de cada socio. Como mejor aproximación, para cada mes
  // evaluamos si SU fecha_vencimiento actual ya estaba vencida a esa altura
  // (respetando la tolerancia configurada) en vez de comparar siempre contra
  // hoy — así un socio que dejó de pagar en 2024 deja de contar como activo
  // a partir de ese mes, en lugar de sumarse para siempre al total acumulado.
  const sociosActivosData = useMemo(
    () =>
      meses.map((fecha) => {
        const finDeMes = new Date(fecha.getFullYear(), fecha.getMonth() + 1, 0, 23, 59, 59)

        const valor = socios.filter((s) => {
          if (!s.created_at) return false
          const alta = new Date(s.created_at)
          if (alta > finDeMes) return false

          const estadoEnEsePeriodo = calcularEstadoCuota(s.fecha_vencimiento, diasTolerancia, finDeMes)
          if (estadoEnEsePeriodo) return estadoEnEsePeriodo === 'activo'
          return (s.estado ?? '').toLowerCase() === 'activo'
        }).length

        return { mes: formatearMes(fecha, conAnio), valor }
      }),
    [socios, meses, conAnio, diasTolerancia],
  )

  const sociosNuevosData = useMemo(
    () =>
      meses.map((fecha) => {
        const valor = socios.filter((s) => {
          if (!s.created_at) return false
          const inicio = new Date(s.created_at)
          return inicio.getFullYear() === fecha.getFullYear() && inicio.getMonth() === fecha.getMonth()
        }).length
        return { mes: formatearMes(fecha, conAnio), valor }
      }),
    [socios, meses, conAnio],
  )

  // Altas agrupadas por día de la semana, dentro del rango seleccionado.
  const altasPorDiaSemana = useMemo(() => {
    const inicioRango = meses[0]
    const conteos = new Array(7).fill(0)

    socios.forEach((s) => {
      if (!s.created_at) return
      const fecha = new Date(s.created_at)
      if (Number.isNaN(fecha.getTime())) return
      if (inicioRango && fecha < inicioRango) return

      const diaJs = fecha.getDay() // 0 = domingo ... 6 = sábado
      const indice = diaJs === 0 ? 6 : diaJs - 1 // remapeado: 0 = lunes ... 6 = domingo
      conteos[indice] += 1
    })

    return DIAS_SEMANA_LABELS.map((dia, i) => ({ dia, valor: conteos[i] }))
  }, [socios, meses])

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-greenfit-card p-10 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Cargando reportes...
      </div>
    )
  }

  if (error) {
    return (
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
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.label} {...kpi} />
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-base font-semibold text-white">Evolución histórica</h2>
        <select
          value={rango}
          onChange={(event) => setRango(event.target.value)}
          className="min-h-[44px] rounded-lg border border-white/10 bg-greenfit-card px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
        >
          {RANGOS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.value === 'origen' && fechaOrigen ? `Desde el origen (${fechaOrigen.getFullYear()})` : r.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard
          title="Socios Activos (mensual)"
          data={sociosActivosData}
          exportFilename="socios-activos.csv"
        />
        <ChartCard
          title="Socios Nuevos (mensual)"
          data={sociosNuevosData}
          exportFilename="socios-nuevos.csv"
        />
      </div>

      <ChartCard
        title="Altas de Socios por Día de la Semana"
        data={altasPorDiaSemana}
        exportFilename="altas-por-dia-semana.csv"
        tipo="bar"
        dataKeyX="dia"
      />
    </div>
  )
}

export default Reportes
