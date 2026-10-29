// Clases de una sola vez (classes.fecha_unica, ver supabase_migration_clase_una_
// sola_vez.sql). Una clase con fecha_unica existe SOLO ese día -- y su
// days_of_week es siempre {día de semana de esa fecha} (CHECK en la base), así
// que todo lo que ya filtraba por día de semana la sigue encontrando el día
// correcto; lo único que falta es descartarla las OTRAS semanas.
//
// Fechas como texto "YYYY-MM-DD" (día calendario de Argentina). La aritmética
// va en UTC para que la zona horaria de la PC no corra ningún día.

const DIAS_LARGOS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
]

function partes(iso) {
  const [anio, mes, dia] = iso.split('-').map(Number)
  return { anio, mes, dia }
}

// 0 = domingo ... 6 = sábado (mismo criterio que classes.days_of_week).
export function diaSemanaDeFecha(iso) {
  const { anio, mes, dia } = partes(iso)
  return new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay()
}

// Fila cruda de `classes` (days_of_week / fecha_unica). Una fila sin
// fecha_unica (o sin la columna, ej. fixtures viejos) es semanal: igual que antes.
export function filaSeDictaElDia(fila, fechaISO) {
  if (!(fila.days_of_week ?? []).includes(diaSemanaDeFecha(fechaISO))) return false
  return !fila.fecha_unica || fila.fecha_unica === fechaISO
}

// Clase ya mapeada por mapearClasesDesdeBookings (diasSemana / fechaUnica).
export function claseSeDictaElDia(clase, fechaISO) {
  return filaSeDictaElDia({ days_of_week: clase.diasSemana, fecha_unica: clase.fechaUnica }, fechaISO)
}

// Una clase de una sola vez cuya fecha ya pasó: solo lectura (igual que los
// días viejos del calendario) -- no se edita ni se ofrece en Anunciar.
export function esUnaSolaVezPasada(fechaUnica, hoy) {
  return Boolean(fechaUnica) && fechaUnica < hoy
}

// "Miércoles 4 de noviembre"
export function textoFechaUnica(iso) {
  const { mes, dia } = partes(iso)
  return `${DIAS_LARGOS[diaSemanaDeFecha(iso)]} ${dia} de ${MESES[mes - 1]}`
}

// "04/11"
export function fechaUnicaCorta(iso) {
  const { mes, dia } = partes(iso)
  return `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}`
}

// Días + fecha a guardar según el switch del modal. Devuelve { error } o
// { days_of_week, fecha_unica }. La base vuelve a validar todo (CHECK +
// trigger): esto es para mostrar el mensaje antes de mandar nada.
export function diasYFechaParaGuardar({ modo, diasSemana, fechaUnica }, hoy) {
  if (modo === 'unica') {
    if (!fechaUnica) return { error: 'Elegí la fecha de la clase.' }
    if (fechaUnica < hoy) return { error: 'La fecha no puede ser anterior a hoy.' }
    return { days_of_week: [diaSemanaDeFecha(fechaUnica)], fecha_unica: fechaUnica }
  }
  if (diasSemana.length === 0) return { error: 'Seleccioná al menos un día de la semana.' }
  return { days_of_week: diasSemana, fecha_unica: null }
}

// Los rechazos del trigger ya vienen escritos para Seba (qué fechas tienen
// reservas y qué hacer): se muestran tal cual. El resto, el mensaje genérico.
const MENSAJES_DEL_TRIGGER = ['Hay reservas de hoy en adelante', 'La fecha de una clase de una sola vez']

export function mensajeErrorGuardarClase(dbError) {
  const mensaje = dbError?.message ?? ''
  if (MENSAJES_DEL_TRIGGER.some((inicio) => mensaje.startsWith(inicio))) return mensaje
  return 'No se pudo guardar la clase. Intentá nuevamente.'
}
