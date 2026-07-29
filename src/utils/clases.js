export const DIAS_SEMANA = [
  { numero: 1, nombre: 'Lunes' },
  { numero: 2, nombre: 'Martes' },
  { numero: 3, nombre: 'Miércoles' },
  { numero: 4, nombre: 'Jueves' },
  { numero: 5, nombre: 'Viernes' },
  { numero: 6, nombre: 'Sábado' },
]

const WEEKDAYS_ABBR = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']

// classes.days_of_week usa 0=Dom...6=Sáb (mismo criterio que Date.getDay()
// en JS) — las clases son plantillas recurrentes, no turnos puntuales, así
// que "ver el Martes" necesita resolverse a una fecha concreta (la de este
// Martes, semana actual) para poder filtrar `bookings.booking_date`.
// Se mantiene para el widget de "Próximas Clases de Hoy" del Home -- la
// sección de Clases usa `proximosDias`/`formatDateOnly` (fechas reales) en
// su lugar, ver más abajo.
export function fechaDeEstaSemana(numeroDia) {
  const hoy = new Date()
  const fecha = new Date(hoy)
  fecha.setDate(hoy.getDate() + (numeroDia - hoy.getDay()))
  return formatDateOnly(fecha)
}

export function diaActualPorDefecto() {
  const indiceHoy = new Date().getDay()
  return DIAS_SEMANA.some((d) => d.numero === indiceHoy) ? indiceHoy : DIAS_SEMANA[0].numero
}

// "YYYY-MM-DD" en horario local -- mismo criterio que usa la PWA para
// booking_date, así ambas apps arman la misma clave de fecha para el mismo
// día calendario.
export function formatDateOnly(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Combina la fecha seleccionada con un horario "HH:mm" de la plantilla de
// clase en un Date real, para poder comparar contra "ahora" y saber si una
// clase ya está en curso o todavía no arrancó.
export function combinarFechaYHora(fechaISO, horaHHmm) {
  if (!horaHHmm) return null
  return new Date(`${fechaISO}T${horaHHmm}:00`)
}

// Hoy + los próximos `cantidad` días, como fechas reales (no "día de la
// semana" que se resuelve distinto según cuándo se mire) -- mismo criterio
// que el DaySelector de la PWA, para que ambas apps hablen el mismo idioma
// de "Hoy" / "Mañana" / etc. A diferencia de DIAS_SEMANA, esto SÍ incluye
// domingo (una fecha real es una fecha real, no hay motivo para saltarla).
export function proximosDias(cantidad = 7) {
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  return Array.from({ length: cantidad }, (_, i) => {
    const fecha = new Date(hoy)
    fecha.setDate(fecha.getDate() + i)
    return fecha
  })
}

export function etiquetaDia(fecha, index) {
  if (index === 0) return 'Hoy'
  if (index === 1) return 'Mañana'
  return WEEKDAYS_ABBR[fecha.getDay()]
}

// `bookingsRows` trae bookings de UNA fecha puntual (la del día seleccionado),
// cada uno con su profile embebido (id, full_name, dni).
export function mapearClasesDesdeBookings(clasesRows, bookingsRows) {
  const inscriptosPorClase = new Map()

  for (const fila of bookingsRows) {
    const lista = inscriptosPorClase.get(fila.class_id) ?? []
    lista.push({
      id: fila.id,
      userId: fila.user_id,
      nombre: fila.profiles?.full_name ?? 'Socio',
      dni: fila.profiles?.dni ?? null,
      asistio: fila.attended,
    })
    inscriptosPorClase.set(fila.class_id, lista)
  }

  return clasesRows.map((row) => ({
    id: row.id,
    disciplina: row.title,
    disciplinaId: row.discipline_id,
    profesor: row.instructor ?? 'Sin asignar',
    horaInicio: (row.start_time ?? '').slice(0, 5),
    horaFin: (row.end_time ?? '').slice(0, 5),
    cupoMaximo: row.capacity,
    diasSemana: row.days_of_week ?? [],
    inscriptos: inscriptosPorClase.get(row.id) ?? [],
  }))
}
