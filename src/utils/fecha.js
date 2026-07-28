export function formatFecha(valor) {
  if (!valor) return '-'

  // Un valor "solo fecha" (YYYY-MM-DD, como devuelven las columnas `date` de
  // Postgres) se interpreta como medianoche UTC si se lo pasa tal cual a
  // `Date`; en husos horarios detrás de UTC (ej. Argentina) eso muestra el
  // día anterior. Forzamos que se interprete en el huso horario local.
  const esSoloFecha = typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)
  const fecha = valor instanceof Date ? valor : new Date(esSoloFecha ? `${valor}T00:00:00` : valor)

  if (Number.isNaN(fecha.getTime())) return '-'
  return fecha.toLocaleDateString('es-AR')
}

export function hoyISO() {
  return new Date().toISOString().slice(0, 10)
}

export function esDelMesActual(valor) {
  if (!valor) return false
  const fecha = valor instanceof Date ? valor : new Date(valor)
  if (Number.isNaN(fecha.getTime())) return false
  const hoy = new Date()
  return fecha.getMonth() === hoy.getMonth() && fecha.getFullYear() === hoy.getFullYear()
}

export function toISODate(valor) {
  const fecha = valor instanceof Date ? valor : new Date(`${valor}T00:00:00`)
  const anio = fecha.getFullYear()
  const mes = String(fecha.getMonth() + 1).padStart(2, '0')
  const dia = String(fecha.getDate()).padStart(2, '0')
  return `${anio}-${mes}-${dia}`
}

// Avanza 1 mes desde `fechaBase`, ajustando siempre al mismo `diaCorte` (ciclo fijo).
// Así, si pagan tarde, el próximo vencimiento no se calcula desde HOY sino desde el
// vencimiento anterior, evitando que el ciclo de cobro se corra mes a mes.
export function proximoVencimiento(fechaBase, diaCorte) {
  const base = fechaBase instanceof Date ? fechaBase : new Date(`${fechaBase}T00:00:00`)
  const anio = base.getFullYear()
  const mesSiguiente = base.getMonth() + 1
  const ultimoDiaDelMesSiguiente = new Date(anio, mesSiguiente + 1, 0).getDate()
  const dia = Math.min(diaCorte, ultimoDiaDelMesSiguiente)
  return new Date(anio, mesSiguiente, dia)
}

// Estado visual de la cuota según la fecha de vencimiento fija. `diasTolerancia`
// viene de la Configuración del gimnasio (por defecto 5, igual que en la base).
// `fechaReferencia` permite evaluar "¿cómo estaba esta cuota en tal fecha?" en vez
// de siempre comparar contra hoy — lo usan los reportes históricos, ya que no
// guardamos un historial de vencimientos pasados, solo el ciclo vigente.
export function calcularEstadoCuota(fechaVencimiento, diasTolerancia = 5, fechaReferencia = new Date()) {
  if (!fechaVencimiento) return null

  const vencimiento = fechaVencimiento instanceof Date ? fechaVencimiento : new Date(`${fechaVencimiento}T00:00:00`)
  if (Number.isNaN(vencimiento.getTime())) return null

  const referencia = new Date(fechaReferencia)
  referencia.setHours(0, 0, 0, 0)
  vencimiento.setHours(0, 0, 0, 0)

  const msPorDia = 1000 * 60 * 60 * 24
  const diasVencido = Math.round((referencia.getTime() - vencimiento.getTime()) / msPorDia)

  if (diasVencido <= 0) return 'activo'
  if (diasVencido <= diasTolerancia) return 'tolerancia'
  return 'vencido'
}
