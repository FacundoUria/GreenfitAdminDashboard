import { describe, it, expect, vi, afterEach } from 'vitest'
import { ahoraEnArgentina } from '../../utils/ahoraArgentina'

// Instantes en UTC (con Z): el resultado no puede depender de la zona de la
// PC que corre los tests. Argentina = UTC-3, sin horario de verano.
describe('ahoraEnArgentina -- fecha/hora/día de la semana en hora de Argentina', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    ['2026-10-22T23:59:00Z', { fecha: '2026-10-22', hora: '20:59:00', diaSemana: 4 }], // jueves 20:59
    ['2026-10-23T00:00:00Z', { fecha: '2026-10-22', hora: '21:00:00', diaSemana: 4 }], // jueves 21:00 (UTC ya es viernes)
    ['2026-10-23T02:59:00Z', { fecha: '2026-10-22', hora: '23:59:00', diaSemana: 4 }], // jueves 23:59
    ['2026-10-23T03:00:00Z', { fecha: '2026-10-23', hora: '00:00:00', diaSemana: 5 }], // viernes 00:00 (no "24:00")
  ])('%s', (instante, esperado) => {
    expect(ahoraEnArgentina(new Date(instante))).toEqual(esperado)
  })

  it('cambio de año: 02:30Z del 1/1 todavía es 31/12 a las 23:30 en Argentina', () => {
    expect(ahoraEnArgentina(new Date('2027-01-01T02:30:00Z'))).toEqual({ fecha: '2026-12-31', hora: '23:30:00', diaSemana: 4 })
  })

  it('sin argumento usa el reloj actual', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T00:00:00Z'))
    expect(ahoraEnArgentina()).toEqual({ fecha: '2026-10-22', hora: '21:00:00', diaSemana: 4 })
  })
})
