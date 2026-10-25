import { describe, it, expect, afterEach } from 'vitest'
import process from 'node:process'
import { formatFecha, formatFechaHora, fechaMasUnAnio } from '../../utils/fecha'

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

// T2 (regla D) -- el corte de un vencimiento elegido por Seba es el FIN de ese
// día en Argentina: 23:59:59.999999 (UTC-3) = 02:59:59.999999 UTC del día
// SIGUIENTE (así lo devuelve PostgREST). Un valor en texto se muestra siempre
// con el día/hora de Argentina, sin importar el huso de la PC.
describe('formatFecha/formatFechaHora -- ancladas a hora Argentina, sin importar el huso de la PC (T2)', () => {
  const TZ_ORIGINAL = process.env.TZ
  const FIN_DEL_31_10_AR = '2026-11-01T02:59:59.999999+00:00'

  afterEach(() => {
    if (TZ_ORIGINAL === undefined) delete process.env.TZ
    else process.env.TZ = TZ_ORIGINAL
  })

  it('un corte a fin del día se ve con el día elegido, con la PC en Argentina, en UTC o en Tokio', () => {
    for (const tz of ['America/Argentina/Buenos_Aires', 'UTC', 'Asia/Tokyo']) {
      process.env.TZ = tz
      expect(formatFecha(FIN_DEL_31_10_AR)).toBe('31/10/2026')
    }
  })

  it('un lote viejo a las 00:00 de Argentina se ve con su fecha de siempre', () => {
    process.env.TZ = 'UTC'
    expect(formatFecha('2026-10-31T03:00:00+00:00')).toBe('31/10/2026')
  })

  it('un valor "solo fecha" es ese día, también con la PC en UTC o en Tokio', () => {
    for (const tz of ['UTC', 'Asia/Tokyo']) {
      process.env.TZ = tz
      expect(formatFecha('2026-10-31')).toBe('31/10/2026')
    }
  })

  it('formatFechaHora de un timestamp muestra la hora de Argentina', () => {
    process.env.TZ = 'UTC'
    expect(formatFechaHora(FIN_DEL_31_10_AR)).toBe('31/10/2026 23:59')
    expect(formatFechaHora('2026-10-25T17:05:00Z')).toBe('25/10/2026 14:05')
  })
})

describe('fechaMasUnAnio (tope del editor de "Vencimiento del plan", mismo criterio que Postgres)', () => {
  it('suma un año calendario', () => {
    expect(fechaMasUnAnio('2026-10-25')).toBe('2027-10-25')
    expect(fechaMasUnAnio('2026-12-31')).toBe('2027-12-31')
  })

  it('el 29/02 pasa al 28/02 del año siguiente, como (fecha + interval \'1 year\')::date', () => {
    expect(fechaMasUnAnio('2028-02-29')).toBe('2029-02-28')
  })
})
