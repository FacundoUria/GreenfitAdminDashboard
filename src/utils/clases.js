export const DIAS_SEMANA = [
  { numero: 1, nombre: 'Lunes' },
  { numero: 2, nombre: 'Martes' },
  { numero: 3, nombre: 'Miércoles' },
  { numero: 4, nombre: 'Jueves' },
  { numero: 5, nombre: 'Viernes' },
  { numero: 6, nombre: 'Sábado' },
]

// classes.days_of_week usa 0=Dom...6=Sáb (mismo criterio que Date.getDay()
// en JS) — las clases son plantillas recurrentes, no turnos puntuales, así
// que "ver el Martes" necesita resolverse a una fecha concreta (la de este
// Martes, semana actual) para poder filtrar `bookings.booking_date`.
export function fechaDeEstaSemana(numeroDia) {
  const hoy = new Date()
  const fecha = new Date(hoy)
  fecha.setDate(hoy.getDate() + (numeroDia - hoy.getDay()))
  const y = fecha.getFullYear()
  const m = String(fecha.getMonth() + 1).padStart(2, '0')
  const d = String(fecha.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// `bookingsRows` trae bookings de UNA fecha puntual (la del día seleccionado
// en esta semana), cada uno con su profile embebido (id, full_name, dni).
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

export function diaActualPorDefecto() {
  const indiceHoy = new Date().getDay()
  return DIAS_SEMANA.some((d) => d.numero === indiceHoy) ? indiceHoy : DIAS_SEMANA[0].numero
}
