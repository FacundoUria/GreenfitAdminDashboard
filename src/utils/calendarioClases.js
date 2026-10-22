import { supabase } from '../lib/supabaseClient'
import { ahoraEnArgentina } from './ahoraArgentina'
import { fetchTodasLasFilas } from './fichaSocioPwa'

// Pantalla Clases -- días pasados + calendario del mes. Todas las fechas son
// textos "YYYY-MM-DD" (día calendario de Argentina, mismo formato que
// bookings.booking_date). La aritmética se hace con Date.UTC para que la zona
// horaria de la PC no corra ningún día. "Hoy" sale siempre de
// ahoraEnArgentina().fecha.
//
// Este archivo lo usa SOLO la pantalla Clases (Clases.jsx y
// CalendarioClases.jsx) -- utils/clases.js no se toca porque también lo usa Home.

const MS_POR_DIA = 86_400_000
const DIAS_ABREVIADOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']

function partes(iso) {
  const [anio, mes, dia] = iso.split('-').map(Number)
  return { anio, mes, dia }
}

function aMs(iso) {
  const { anio, mes, dia } = partes(iso)
  return Date.UTC(anio, mes - 1, dia)
}

function desdeMs(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

export function sumarDiasISO(iso, dias) {
  return desdeMs(aMs(iso) + dias * MS_POR_DIA)
}

export function diferenciaDiasISO(desde, hasta) {
  return Math.round((aMs(hasta) - aMs(desde)) / MS_POR_DIA)
}

// 0 = domingo ... 6 = sábado (mismo criterio que classes.days_of_week).
export function diaSemanaISO(iso) {
  return new Date(aMs(iso)).getUTCDay()
}

export function numeroDiaISO(iso) {
  return partes(iso).dia
}

// "18/08"
export function fechaCortaISO(iso) {
  const { mes, dia } = partes(iso)
  return `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}`
}

// Tira de días de Clases: los 7 anteriores + hoy + los 6 siguientes.
export const DIAS_ATRAS = 7
export const DIAS_ADELANTE = 6
export function diasDeLaTira(hoy) {
  return Array.from({ length: DIAS_ATRAS + 1 + DIAS_ADELANTE }, (_, i) => sumarDiasISO(hoy, i - DIAS_ATRAS))
}

export function etiquetaDiaISO(fecha, hoy) {
  const diferencia = diferenciaDiasISO(hoy, fecha)
  if (diferencia === -1) return 'Ayer'
  if (diferencia === 0) return 'Hoy'
  if (diferencia === 1) return 'Mañana'
  return DIAS_ABREVIADOS[diaSemanaISO(fecha)]
}

// Días anteriores a "ayer": solo lectura (ni anotar, ni quitar, ni marcar
// asistencia, ni editar/cancelar) -- cancelar una reserva pasada mueve
// créditos. "Ayer", hoy y los días futuros quedan como siempre.
export function esSoloLectura(fecha, hoy) {
  return fecha < sumarDiasISO(hoy, -1)
}

// ── Mes ──────────────────────────────────────────────────────────────────

// "2026-10-22" -> "2026-10-01"
export function mesDe(iso) {
  return `${iso.slice(0, 7)}-01`
}

export function sumarMeses(mesISO, meses) {
  const { anio, mes } = partes(mesISO)
  return desdeMs(Date.UTC(anio, mes - 1 + meses, 1))
}

export function ultimoDiaDelMes(mesISO) {
  const { anio, mes } = partes(mesISO)
  return desdeMs(Date.UTC(anio, mes, 0))
}

// Semanas de lunes a domingo; `null` en los huecos antes del 1 y después del último día.
export function semanasDelMes(mesISO) {
  const ultimo = numeroDiaISO(ultimoDiaDelMes(mesISO))
  const huecoInicial = (diaSemanaISO(mesISO) + 6) % 7
  const celdas = [
    ...Array.from({ length: huecoInicial }, () => null),
    ...Array.from({ length: ultimo }, (_, i) => sumarDiasISO(mesISO, i)),
  ]
  while (celdas.length % 7 !== 0) celdas.push(null)
  const semanas = []
  for (let i = 0; i < celdas.length; i += 7) semanas.push(celdas.slice(i, i + 7))
  return semanas
}

// "Octubre 2026"
export function nombreMes(mesISO) {
  const texto = new Intl.DateTimeFormat('es-AR', { month: 'long', timeZone: 'UTC' }).format(new Date(aMs(mesISO)))
  return `${texto.charAt(0).toUpperCase()}${texto.slice(1)} ${partes(mesISO).anio}`
}

// ── Datos ────────────────────────────────────────────────────────────────

export function contarPorDia(filas, campo) {
  const conteo = new Map()
  for (const fila of filas ?? []) {
    const fecha = fila[campo]
    if (fecha) conteo.set(fecha, (conteo.get(fecha) ?? 0) + 1)
  }
  return conteo
}

// Inscriptos (reservas ACTIVAS) por día del mes + días con alguna clase
// cancelada. Una consulta por rango para cada tabla, paginada.
export async function fetchResumenMes(mesISO) {
  const desde = mesISO
  const hasta = ultimoDiaDelMes(mesISO)
  const [reservas, cancelaciones] = await Promise.all([
    fetchTodasLasFilas(() =>
      supabase.from('bookings').select('id, booking_date').gte('booking_date', desde).lte('booking_date', hasta).order('id'),
    ),
    fetchTodasLasFilas(() =>
      supabase
        .from('class_occurrence_cancellations')
        .select('id, occurrence_date')
        .gte('occurrence_date', desde)
        .lte('occurrence_date', hasta)
        .order('id'),
    ),
  ])
  if (reservas.error) throw new Error(reservas.error.message)
  if (cancelaciones.error) throw new Error(cancelaciones.error.message)
  return {
    inscriptosPorDia: contarPorDia(reservas.data, 'booking_date'),
    diasConCancelacion: new Set((cancelaciones.data ?? []).map((c) => c.occurrence_date)),
  }
}

// Fecha de la reserva más vieja (límite hacia atrás del calendario), o null.
export async function fetchPrimeraReserva() {
  const { data, error } = await supabase.from('bookings').select('booking_date').order('booking_date', { ascending: true }).limit(1)
  if (error) throw new Error(error.message)
  return data?.[0]?.booking_date ?? null
}

// ── Días anteriores a "ayer" ─────────────────────────────────────────────

function creadaHastaEseDia(fila, fecha) {
  if (!fila.created_at) return true
  return ahoraEnArgentina(new Date(fila.created_at)).fecha <= fecha
}

// Clases (filas de `classes`) de un día anterior a "ayer". Se arma a partir
// de lo que pasó ESE día, no solo de la plantilla actual:
//  a) plantillas reservables que hoy se dictan ese día de la semana y ya
//     existían ese día;
//  b) cualquier clase con al menos una reserva activa ese día (aunque hoy no
//     se dicte ese día de la semana o su disciplina esté oculta de la agenda);
//  c) cualquier clase cancelada puntualmente ese día.
export function clasesDeUnDiaPasado({ fecha, plantillas, todasLasClases, classIdsConReserva, classIdsCanceladas }) {
  const dia = diaSemanaISO(fecha)
  const porId = new Map()
  for (const fila of plantillas) {
    if ((fila.days_of_week ?? []).includes(dia) && creadaHastaEseDia(fila, fecha)) porId.set(fila.id, fila)
  }
  for (const fila of todasLasClases) {
    if (classIdsConReserva.has(fila.id) || classIdsCanceladas.has(fila.id)) porId.set(fila.id, fila)
  }
  return [...porId.values()]
}

function listarDias(dias) {
  const nombres = [...dias].sort((a, b) => a - b).map((d) => DIAS_ABREVIADOS[d])
  if (nombres.length <= 1) return nombres.join('')
  return `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`
}

// Aviso para la tarjeta de un día pasado (clase ya mapeada por
// mapearClasesDesdeBookings), o null. No hay historial de cambios de
// `classes`: solo se avisa lo que se puede detectar.
export function avisoDiaPasado(clase, fecha) {
  const avisos = []
  if (!clase.diasSemana.includes(diaSemanaISO(fecha))) {
    avisos.push(
      clase.diasSemana.length > 0
        ? `Hoy esta clase se dicta ${listarDias(clase.diasSemana)}: el título, el horario o el cupo de ese día pueden haber sido otros.`
        : 'Hoy esta clase no tiene días asignados: el título, el horario o el cupo de ese día pueden haber sido otros.',
    )
  }
  if (clase.inscriptos.length > clase.cupoMaximo) {
    avisos.push('Hubo más inscriptos que el cupo actual: el cupo cambió.')
  }
  return avisos.length > 0 ? avisos.join(' ') : null
}
