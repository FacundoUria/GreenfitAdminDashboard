import { describe, it, expect, vi, afterEach } from 'vitest'
import { ahoraEnArgentina } from '../../utils/ahoraArgentina'
import { hoyISO } from '../../utils/fecha'

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

  // Prueba de que el reemplazo de hoyISO() no cambia nada fuera de la franja:
  // de 00:00 a 20:59 de Argentina, UTC sigue en el mismo día calendario, así
  // que las dos dan el mismo texto; de 21:00 a 23:59, hoyISO() ya da mañana.
  it('recorrido de un año cada 15 min: igual a hoyISO() de 00:00 a 20:59, un día antes de 21:00 a 23:59', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const inicio = Date.parse('2026-01-01T03:00:00Z') // 01/01/2026 00:00 en Argentina
    const fin = Date.parse('2027-01-01T03:00:00Z')
    const diferencias = { fueraDeFranja: 0, enFranjaNoEsManana: 0 }
    for (let t = inicio; t < fin; t += 15 * 60_000) {
      vi.setSystemTime(t)
      const { fecha, hora } = ahoraEnArgentina()
      const utc = hoyISO()
      if (hora < '21:00:00') {
        if (utc !== fecha) diferencias.fueraDeFranja += 1
      } else {
        const manana = new Date(Date.parse(`${fecha}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
        if (utc !== manana) diferencias.enFranjaNoEsManana += 1
      }
    }
    expect(diferencias).toEqual({ fueraDeFranja: 0, enFranjaNoEsManana: 0 })
  })

  it('sin argumento usa el reloj actual', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T00:00:00Z'))
    expect(ahoraEnArgentina()).toEqual({ fecha: '2026-10-22', hora: '21:00:00', diaSemana: 4 })
  })
})
