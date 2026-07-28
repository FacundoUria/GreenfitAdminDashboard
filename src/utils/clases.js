export const DIAS_SEMANA = [
  { numero: 1, nombre: 'Lunes' },
  { numero: 2, nombre: 'Martes' },
  { numero: 3, nombre: 'Miércoles' },
  { numero: 4, nombre: 'Jueves' },
  { numero: 5, nombre: 'Viernes' },
  { numero: 6, nombre: 'Sábado' },
]

export function mapearClases(clasesRows, asistenciasRows) {
  const inscriptosPorClase = new Map()

  for (const fila of asistenciasRows) {
    const lista = inscriptosPorClase.get(fila.clase_id) ?? []
    lista.push({
      id: fila.id,
      nombre: fila.socios?.nombre ?? 'Socio',
      apellido: fila.socios?.apellido ?? '',
      asistio: fila.asistio,
    })
    inscriptosPorClase.set(fila.clase_id, lista)
  }

  return clasesRows.map((row) => ({
    id: row.id,
    disciplina: row.title,
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
