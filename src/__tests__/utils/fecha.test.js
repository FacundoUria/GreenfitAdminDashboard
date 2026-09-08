import { describe, it, expect } from 'vitest'
import { formatFecha, formatFechaHora } from '../../utils/fecha'

// formatFecha() es la fuente de verdad de "cómo se ve una fecha" en todo el
// Admin -- antes llamaba a toLocaleDateString('es-AR') SIN opciones, cuyo
// resultado exacto (con o sin cero a la izquierda) dependía del motor JS.
// Estos tests fijan el contrato real: dd/mm/yyyy, siempre con cero a la
// izquierda, siempre con año de 4 dígitos.
describe('formatFecha (dd/mm/yyyy explícito -- no depende del motor JS)', () => {
  it('sin valor, devuelve "-"', () => {
    expect(formatFecha(null)).toBe('-')
    expect(formatFecha(undefined)).toBe('-')
    expect(formatFecha('')).toBe('-')
  })

  it('con un valor inválido, devuelve "-" en vez de "Invalid Date"', () => {
    expect(formatFecha('no-es-una-fecha')).toBe('-')
  })

  it('día y mes de un solo dígito quedan con cero a la izquierda', () => {
    expect(formatFecha('2026-01-05')).toBe('05/01/2026')
  })

  it('día y mes de dos dígitos', () => {
    expect(formatFecha('2026-09-15')).toBe('15/09/2026')
  })

  it('acepta un objeto Date directo', () => {
    expect(formatFecha(new Date(2026, 8, 5))).toBe('05/09/2026') // mes 8 = septiembre (0-indexed)
  })

  it('un valor "solo fecha" (YYYY-MM-DD) se interpreta en huso horario local, no UTC -- no corre un día para atrás', () => {
    // 2026-01-01 interpretado como UTC medianoche mostraría 31/12/2025 en
    // cualquier huso detrás de UTC (Argentina, UTC-3) si no se corrigiera.
    expect(formatFecha('2026-01-01')).toBe('01/01/2026')
  })
})

describe('formatFechaHora (fecha + hora -- reusa formatFecha(), no reimplementa el formato de fecha)', () => {
  it('sin valor, devuelve "-"', () => {
    expect(formatFechaHora(null)).toBe('-')
  })

  it('con un valor inválido, devuelve "-"', () => {
    expect(formatFechaHora('no-es-una-fecha')).toBe('-')
  })

  it('arma "dd/mm/yyyy HH:mm", en formato 24hs', () => {
    // Hora en el propio huso horario del entorno de test -- se arma con
    // Date directamente (no un string con offset) para no depender del
    // huso horario de la máquina que corre el test.
    const fecha = new Date(2026, 8, 5, 14, 5) // 5 de septiembre 2026, 14:05 local
    expect(formatFechaHora(fecha)).toBe('05/09/2026 14:05')
  })

  it('la parte de la fecha es idéntica a la que devuelve formatFecha() para el mismo valor', () => {
    const fecha = new Date(2026, 0, 5, 9, 0)
    expect(formatFechaHora(fecha).startsWith(formatFecha(fecha))).toBe(true)
  })
})
