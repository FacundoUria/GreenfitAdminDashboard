import { describe, it, expect } from 'vitest'
import { formatearRangoDias, agruparClasesPorBloqueHorario, formatearFranjaHoraria } from '../../utils/horarios'

describe('formatearRangoDias', () => {
  it('colapsa 3+ días consecutivos en un rango', () => {
    expect(formatearRangoDias(new Set([1, 2, 3, 4, 5]))).toBe('Lun a Vie')
  })

  it('días sueltos se separan por coma', () => {
    expect(formatearRangoDias(new Set([1, 3, 5]))).toBe('Lun, Mié, Vie')
  })

  it('mezcla un rango con un día suelto', () => {
    expect(formatearRangoDias(new Set([1, 2, 3, 6]))).toBe('Lun a Mié, Sáb')
  })

  it('domingo se ordena al final de la semana (arranca en lunes)', () => {
    expect(formatearRangoDias(new Set([0, 1]))).toBe('Lun, Dom')
  })

  it('set vacío -> string vacío', () => {
    expect(formatearRangoDias(new Set())).toBe('')
  })
})

describe('agruparClasesPorBloqueHorario', () => {
  it('agrupa clases con el mismo horario exacto, uniendo sus días', () => {
    const clases = [
      { start_time: '18:00:00', end_time: '19:00:00', days_of_week: [1, 3] },
      { start_time: '18:00:00', end_time: '19:00:00', days_of_week: [5] },
      { start_time: '09:00:00', end_time: '10:00:00', days_of_week: [1, 2, 3, 4, 5] },
    ]
    const bloques = agruparClasesPorBloqueHorario(clases)
    expect(bloques).toHaveLength(2)
    // Ordenados por hora de inicio.
    expect(bloques[0].start).toBe('09:00:00')
    expect(bloques[1].start).toBe('18:00:00')
    expect([...bloques[1].dias].sort()).toEqual([1, 3, 5])
  })

  it('lista vacía -> sin bloques', () => {
    expect(agruparClasesPorBloqueHorario([])).toEqual([])
  })
})

describe('formatearFranjaHoraria', () => {
  it('arma el texto final "días — rango"', () => {
    const bloque = { start: '17:00:00', end: '18:00:00', dias: new Set([1, 3, 5]) }
    expect(formatearFranjaHoraria(bloque)).toBe('Lun, Mié, Vie — 17:00 a 18:00 hs')
  })

  it('sin hora de fin, muestra solo la hora de inicio', () => {
    const bloque = { start: '09:00:00', end: null, dias: new Set([1]) }
    expect(formatearFranjaHoraria(bloque)).toBe('Lun — 09:00 hs')
  })
})
