import { useEffect, useMemo, useState } from 'react'
import {
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

function ultimosNMeses(n) {
  const meses = []
  const ahora = new Date()
  for (let i = n - 1; i >= 0; i--) {
    meses.push(new Date(ahora.getFullYear(), ahora.getMonth() - i, 1))
  }
  return meses
}

function nombreMes(fecha) {
  const nombre = fecha.toLocaleDateString('es-AR', { month: 'short' }).replace('.', '')
  return nombre.charAt(0).toUpperCase() + nombre.slice(1)
}

function downloadCSV(filename, rows) {
  const header = 'Mes,Valor\n'
  const body = rows.map((row) => `${row.mes},${row.valor}`).join('\n')
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

function ChartCard({ title, data, exportFilename }) {
  const [exporting, setExporting] = useState(false)

  const handleExport = () => {
    setExporting(true)
    downloadCSV(exportFilename, data)
    setTimeout(() => setExporting(false), 1200)
  }

  return (
    <div className="rounded-xl bg-greenfit-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <button
          type="button"
          onClick={handleExport}
          className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-60"
          disabled={exporting}
        >
          <Download className="h-4 w-4" />
          {exporting ? 'Exportando...' : 'Exportar Excel'}
        </button>
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
          <XAxis dataKey="mes" stroke="rgba(255,255,255,0.4)" tick={{ fill: '#9CA3AF', fontSize: 12 }} />
          <YAxis stroke="rgba(255,255,255,0.4)" tick={{ fill: '#9CA3AF', fontSize: 12 }} />
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
            dot={{ r: 3, fill: '#80C026' }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
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

  const sociosActivosData = useMemo(
    () =>
      ultimosNMeses(6).map((fecha) => {
        const finDeMes = new Date(fecha.getFullYear(), fecha.getMonth() + 1, 0, 23, 59, 59)
        const valor = socios.filter(
          (s) => s.created_at && new Date(s.created_at) <= finDeMes,
        ).length
        return { mes: nombreMes(fecha), valor }
      }),
    [socios],
  )

  const sociosNuevosData = useMemo(
    () =>
      ultimosNMeses(6).map((fecha) => {
        const valor = socios.filter((s) => {
          if (!s.created_at) return false
          const inicio = new Date(s.created_at)
          return inicio.getFullYear() === fecha.getFullYear() && inicio.getMonth() === fecha.getMonth()
        }).length
        return { mes: nombreMes(fecha), valor }
      }),
    [socios],
  )

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
    </div>
  )
}

export default Reportes
