// dd/mm/yyyy siempre -- con opciones explícitas, no dependiente de qué
// formato por defecto le dé el motor JS a 'es-AR' sin especificar nada
// (antes `toLocaleDateString('es-AR')` a secas -- en la práctica solía dar
// "5/9/2026", sin cero a la izquierda, en vez del "05/09/2026" que se
// espera en todo el sistema).
export function formatFecha(valor) {
  if (!valor) return '-'

  // Un valor "solo fecha" (YYYY-MM-DD, como devuelven las columnas `date` de
  // Postgres) se interpreta como medianoche UTC si se lo pasa tal cual a
  // `Date`; en husos horarios detrás de UTC (ej. Argentina) eso muestra el
  // día anterior. Forzamos que se interprete en el huso horario local.
  const esSoloFecha = typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)
  const fecha = valor instanceof Date ? valor : new Date(esSoloFecha ? `${valor}T00:00:00` : valor)

  if (Number.isNaN(fecha.getTime())) return '-'
  return fecha.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Fecha + hora -- reusa formatFecha() para la parte de fecha (misma
// garantía de dd/mm/yyyy, mismo criterio de "solo fecha" vs. timestamp
// completo) en vez de reimplementarla -- así hay una sola fuente de verdad
// para cómo se ve una fecha en todo el Admin. `hour12: false` explícito por
// el mismo motivo que ya documenta la PWA (classTime.ts): no confiar en que
// el motor JS respete el formato 24hs de 'es-AR' por default.
export function formatFechaHora(valor) {
  const fechaTexto = formatFecha(valor)
  if (fechaTexto === '-') return '-'

  const esSoloFecha = typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)
  const fecha = valor instanceof Date ? valor : new Date(esSoloFecha ? `${valor}T00:00:00` : valor)
  const horaTexto = fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })

  return `${fechaTexto} ${horaTexto}`
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

// Suma `dias` días de calendario a `fechaBase` (string YYYY-MM-DD o Date).
// Usado para sugerir un vencimiento a partir de los "días de vigencia" de
// una disciplina por vencimiento (ver RegistrarPagoModal.jsx) -- a
// diferencia de `proximoVencimiento`, esto no ancla a un día de mes fijo,
// simplemente cuenta N días desde la fecha de inicio elegida.
export function sumarDias(fechaBase, dias) {
  const base = fechaBase instanceof Date ? fechaBase : new Date(`${fechaBase}T00:00:00`)
  const resultado = new Date(base)
  resultado.setDate(resultado.getDate() + dias)
  return resultado
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
