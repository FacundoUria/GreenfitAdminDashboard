// Fecha, hora y día de la semana de AHORA en hora de Argentina, sin depender
// de la zona horaria de la PC. Por ahora la usa SOLO el Check-in Rápido
// (buscarSociosClaseActiva en fichaSocioPwa.js).
//
// Bug real: el Check-in armaba la fecha de "hoy" con toISOString() (UTC) --
// entre las 21:00 y las 23:59 de Argentina eso ya es mañana, así que buscaba
// las reservas del día siguiente para la clase de esa noche.
//
// hoyISO() (fecha.js) tiene el mismo problema pero la usan Pagos/Socios para
// cobros y vencimientos -- se corrige en otra tanda, no se reemplaza acá.

const ZONA_ARGENTINA = 'America/Argentina/Mendoza'

const formateador = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_ARGENTINA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  // h23 explícito: con hour12:false algunos motores devuelven "24" a la
  // medianoche en vez de "00".
  hourCycle: 'h23',
})

// `ahora`: inyectable para tests; por defecto, el instante actual.
// Devuelve { fecha: 'YYYY-MM-DD', hora: 'HH:MM:SS', diaSemana: 0-6 } --
// diaSemana con el mismo criterio que Date.getDay() y classes.days_of_week
// (0 = domingo).
export function ahoraEnArgentina(ahora = new Date()) {
  const partes = Object.fromEntries(formateador.formatToParts(ahora).map((p) => [p.type, p.value]))
  const fecha = `${partes.year}-${partes.month}-${partes.day}`
  const hora = `${partes.hour}:${partes.minute}:${partes.second}`
  // Día de la semana de ESA fecha calendario, calculado en UTC para que la
  // zona de la PC no lo corra.
  const diaSemana = new Date(Date.UTC(Number(partes.year), Number(partes.month) - 1, Number(partes.day))).getUTCDay()
  return { fecha, hora, diaSemana }
}
