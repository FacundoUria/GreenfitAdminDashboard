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
import { AlertCircle, Download, Loader2, UserPlus } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { esDelMesActual } from '../utils/fecha'
import { estadoOperativoSocio, getSocioMetrics } from '../utils/socioMetrics'
import { fetchCreditosPorDisciplina, fetchMembresiasVigentesPorDni, fetchTodosLosSocios } from '../utils/fichaSocioPwa'
import { desglosePorDisciplina } from '../utils/reporteDisciplinas'
import { COLOR_NEUTRO, colorDisciplina } from '../utils/coloresDisciplina'

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

function iniciales(nombre) {
  const partes = (nombre ?? '').trim().split(/\s+/).filter(Boolean)
  if (partes.length === 0) return '?'
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase()
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase()
}

const colorDeCategoria = (categoria) => (categoria.esDisciplina ? colorDisciplina(categoria.nombre) : COLOR_NEUTRO)

// Bloque principal del rediseño: héroe "Socios Activos" + barra de
// distribución + una tarjeta por disciplina (del catálogo real) + la lista de
// socios (nombre y DNI) de la disciplina elegida.
function DesgloseDisciplinas({ activos, categorias }) {
  const [seleccionId, setSeleccionId] = useState(null)
  const seleccionada =
    categorias.find((c) => c.id === seleccionId) ?? categorias.find((c) => c.cantidad > 0) ?? categorias[0] ?? null
  const sumaTarjetas = categorias.reduce((suma, c) => suma + c.cantidad, 0)
  const conSocios = categorias.filter((c) => c.cantidad > 0)

  return (
    <>
      <section className="flex flex-col gap-4">
        <div className="flex items-baseline gap-4">
          <span
            data-testid="reportes-socios-activos"
            className="text-7xl font-light leading-none tracking-tight text-white lg:text-8xl"
          >
            {activos}
          </span>
          <div className="inline-flex items-center gap-2 pb-1">
            <span className="h-2 w-2 animate-pulse rounded-full bg-greenfit-primary" />
            <span className="text-xs font-medium uppercase tracking-wider text-gray-400">Socios Activos</span>
          </div>
        </div>

        {/* Barra de distribución: cada tramo es la parte de esa disciplina
            sobre la SUMA de las tarjetas (así siempre llena el 100%). */}
        <div className="flex flex-col gap-2 pt-2">
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/5" data-testid="reportes-barra">
            {conSocios.map((c) => (
              <div
                key={c.id}
                className={`h-full transition-all duration-300 ${colorDeCategoria(c).dot}`}
                style={{ width: `${(c.cantidad / sumaTarjetas) * 100}%` }}
                title={`${c.nombre}: ${c.cantidad} (${c.porcentaje}% de los activos)`}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-0.5 text-[11px] text-gray-400">
            {conSocios.map((c) => (
              <span key={c.id} className="inline-flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${colorDeCategoria(c).dot}`} />
                {c.nombre} {c.porcentaje}%
              </span>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            Un socio con más de una disciplina cuenta en cada una: la suma de las tarjetas puede superar el total de
            Socios Activos. El porcentaje es sobre el total de activos.
          </p>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {categorias.map((c) => {
          const color = colorDeCategoria(c)
          const activa = seleccionada?.id === c.id
          return (
            <button
              key={c.id}
              type="button"
              data-testid={`reportes-tarjeta-${c.id}`}
              aria-pressed={activa}
              onClick={() => setSeleccionId(c.id)}
              className={`rounded-xl bg-greenfit-card p-5 text-left transition-all duration-200 hover:bg-white/5 ${
                activa ? 'bg-gradient-to-b from-greenfit-primary/[0.06] to-transparent ring-1 ring-greenfit-primary/40' : ''
              }`}
            >
              <div className="mb-4 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color.dot}`} />
                  <span className="truncate text-sm font-semibold tracking-wide text-white">{c.nombre}</span>
                </div>
                <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${color.texto} ${color.chip}`}>
                  {c.porcentaje}%
                </span>
              </div>
              <div className="text-4xl font-light tracking-tight text-white">{c.cantidad}</div>
            </button>
          )
        })}
      </section>

      {seleccionada && (
        <section className="rounded-2xl bg-greenfit-card p-6 sm:p-8" data-testid="reportes-tabla">
          <div className="mb-2 flex items-center justify-between border-b border-white/5 pb-6">
            <div className="flex items-center gap-2.5">
              <span className={`h-2 w-2 rounded-full ${colorDeCategoria(seleccionada).dot}`} />
              <span className="text-sm font-medium tracking-wide text-white">{seleccionada.nombre}</span>
            </div>
            <span className="text-xs text-gray-500">
              {seleccionada.cantidad === 1 ? '1 socio' : `${seleccionada.cantidad} socios`}
            </span>
          </div>

          {!seleccionada.esDisciplina && (
            <p className="pt-4 text-xs leading-relaxed text-gray-500" data-testid="reportes-nota-plan">
              El plan que figura debajo de cada nombre es el plan administrativo cargado en el panel: no está
              verificado contra créditos reales de la app.
            </p>
          )}

          {seleccionada.cantidad === 0 ? (
            <p className="py-6 text-center text-sm text-gray-500">Ningún socio activo en esta disciplina.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-white/5 text-[11px] uppercase tracking-wider text-gray-500">
                    <th className="px-2 py-3 font-normal">Socio</th>
                    <th className="px-4 py-3 font-normal">DNI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {seleccionada.socios.map((socio) => (
                    <tr key={socio.id ?? socio.dni} className="transition-colors hover:bg-white/5">
                      <td className="px-2 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-white/5 text-[11px] font-medium text-gray-300">
                            {iniciales(socio.nombre)}
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[13px] font-medium text-white">{socio.nombre}</span>
                            {!seleccionada.esDisciplina && (socio.planAdministrativo || socio.sinCuentaApp) && (
                              <span className="text-[11px] text-gray-500">
                                {[socio.planAdministrativo, socio.sinCuentaApp ? 'sin cuenta en la app' : null]
                                  .filter(Boolean)
                                  .join(' — ')}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">{socio.dni ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  )
}

function Reportes() {
  const [socios, setSocios] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [rango, setRango] = useState('6m')
  // Créditos REALES de la PWA por disciplina -- mismo dato/mismo criterio que
  // Home.jsx/Socios.jsx (estadoOperativoSocio() lo necesita para decidir bien
  // un socio 100% créditos, sin fecha_vencimiento).
  const [creditosPorDni, setCreditosPorDni] = useState(new Map())
  // Aparatos/membresías REALMENTE vigentes por DNI: el Map tri-estado de
  // siempre (ver socioMetrics.js, caso Agustina Aguero) + QUÉ disciplina de
  // membresía tiene cada socio, para el desglose.
  const [membresias, setMembresias] = useState({ vigentePorDni: new Map(), disciplinasPorDni: new Map() })
  // Catálogo real de disciplinas (tabla `disciplines`).
  const [disciplinas, setDisciplinas] = useState([])

  // Todo se carga ANTES de dibujar un solo número. Si CUALQUIERA de las
  // consultas falla, se muestra el error con "Reintentar": nunca números
  // armados con datos incompletos (antes, un fallo de créditos/Aparatos
  // dejaba a todos como "Inactivo" en silencio).
  const fetchDatos = async () => {
    setLoading(true)
    setError(null)

    try {
      const { data: filasSocios, error: sociosError } = await fetchTodosLosSocios()
      if (sociosError) throw new Error(`No se pudieron cargar los socios: ${sociosError.message}`)

      const dnis = (filasSocios ?? []).map((s) => s.dni)
      const [creditos, membresiasVigentes, catalogo] = await Promise.all([
        fetchCreditosPorDisciplina(dnis, { lanzarSiFalla: true }),
        fetchMembresiasVigentesPorDni(dnis, { lanzarSiFalla: true }),
        supabase.from('disciplines').select('id, name, kind, is_active').order('name', { ascending: true }),
      ])
      if (catalogo.error) throw new Error(`No se pudo cargar el catálogo de disciplinas: ${catalogo.error.message}`)

      setSocios(filasSocios ?? [])
      setCreditosPorDni(creditos)
      setMembresias(membresiasVigentes)
      setDisciplinas(catalogo.data ?? [])
    } catch (err) {
      console.error('Error al cargar Reportes:', err.message)
      setError(
        'No se pudieron cargar todos los datos de los socios. No se muestran los números para no dar un total incompleto. Verificá la conexión con Supabase.',
      )
      setSocios([])
    }

    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchDatos()
  }, [])

  const sociosConCreditos = useMemo(
    () =>
      socios.map((s) => ({
        ...s,
        creditosPwaPorDisciplina: creditosPorDni.get(s.dni) ?? [],
        // TRI-ESTADO -- NUNCA coercionar a booleano acá (`=== true`
        // perdería la diferencia entre `false` -- tiene cuenta PWA
        // confirmada sin nada real -- y `undefined` -- sin cuenta PWA, cae
        // a fecha_vencimiento directa, ver fetchAparatosVigentePorDni en
        // fichaSocioPwa.js). Se pasa el valor CRUDO tal cual.
        aparatosVigenteReal: membresias.vigentePorDni.get(s.dni),
        membresiasVigentes: membresias.disciplinasPorDni.get(s.dni) ?? [],
      })),
    [socios, creditosPorDni, membresias],
  )

  // Mismo criterio EXACTO que ya usan Home.jsx y Socios.jsx -- antes acá se
  // llamaba a calcularEstadoCuota() directo, que solo mira fecha_vencimiento
  // y no sabe nada de `socio.activo`. Un socio dado de baja con
  // fecha_vencimiento todavía futura contaba como "Activo" en Reportes,
  // mientras Home/Socios ya lo excluían (lo cuentan aparte, como
  // "inactivo"). getSocioMetrics() es la fuente única para estos números
  // en todo el panel -- si cambia el criterio de negocio en el futuro,
  // alcanza con tocarlo ahí una sola vez.
  const metricasVigentes = useMemo(() => getSocioMetrics(sociosConCreditos), [sociosConCreditos])

  // Desglose por disciplina de esos mismos activos (catálogo real).
  const desglose = useMemo(() => desglosePorDisciplina(sociosConCreditos, disciplinas), [sociosConCreditos, disciplinas])

  const kpis = useMemo(
    () => [
      { label: 'Cuota Vencida', value: metricasVigentes.vencidos, icon: AlertCircle },
      {
        label: 'Nuevos del mes',
        value: socios.filter((s) => esDelMesActual(s.created_at)).length,
        icon: UserPlus,
      },
    ],
    [metricasVigentes, socios],
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
  //
  // Mismo criterio que el KPI de arriba -- estadoOperativoSocio() excluye a
  // un socio dado de baja (activo=false) SIEMPRE, en cualquier mes del
  // gráfico, no solo en el estado vigente de hoy: tampoco guardamos un
  // historial real de altas/bajas, así que no hay forma honesta de saber
  // desde cuándo estuvo de baja -- se lo excluye de punta a punta del rango,
  // mismo espíritu que ya tenía esta reconstrucción retroactiva para la
  // fecha de vencimiento.
  const sociosActivosData = useMemo(
    () =>
      meses.map((fecha) => {
        const finDeMes = new Date(fecha.getFullYear(), fecha.getMonth() + 1, 0, 23, 59, 59)

        const valor = sociosConCreditos.filter((s) => {
          if (!s.created_at) return false
          const alta = new Date(s.created_at)
          if (alta > finDeMes) return false

          return estadoOperativoSocio(s, finDeMes) === 'activo'
        }).length

        return { mes: formatearMes(fecha, conAnio), valor }
      }),
    [sociosConCreditos, meses, conAnio],
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
          onClick={fetchDatos}
          className="rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10"
        >
          Reintentar
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10">
      <DesgloseDisciplinas activos={metricasVigentes.activos} categorias={desglose.categorias} />

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
