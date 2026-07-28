import { useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Users, AlertCircle, Clock, UserPlus, Download } from 'lucide-react'

const kpis = [
  { label: 'Socios Activos', value: '482', icon: Users },
  { label: 'Cuota Vencida', value: '37', icon: AlertCircle },
  { label: 'Socios Pendientes', value: '12', icon: Clock },
  { label: 'Nuevos del mes', value: '28', icon: UserPlus },
]

const sociosActivosData = [
  { mes: 'Feb', valor: 398 },
  { mes: 'Mar', valor: 412 },
  { mes: 'Abr', valor: 405 },
  { mes: 'May', valor: 430 },
  { mes: 'Jun', valor: 461 },
  { mes: 'Jul', valor: 482 },
]

const sociosNuevosData = [
  { mes: 'Feb', valor: 14 },
  { mes: 'Mar', valor: 19 },
  { mes: 'Abr', valor: 11 },
  { mes: 'May', valor: 22 },
  { mes: 'Jun', valor: 17 },
  { mes: 'Jul', valor: 28 },
]

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
