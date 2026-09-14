import { describe, it, expect } from 'vitest'
import { diaAnterior, etiquetaDia, proximosDias } from '../../utils/clases'

// Ticket "Ayer" en Clases.jsx -- agregar un día antes de "Hoy" a la
// navegación (DIAS_VISIBLES) corría el índice que etiquetaDia() usaba para
// decidir "Hoy"/"Mañana" (antes: index 0 = Hoy, index 1 = Mañana). Se pasó
// a comparar la fecha real contra hoy en vez de la posición en el array --
// estos tests cubren ese cálculo aparte de la navegación en sí (ver
// e2e/clases-dia-anterior.spec.js para el flujo completo en la UI).
describe('diaAnterior()', () => {
  it('devuelve el día calendario justo antes, a las 00:00 local', () => {
    const hoy = proximosDias(1)[0]
    const ayer = diaAnterior(hoy)

    expect(ayer.getTime()).toBeLessThan(hoy.getTime())
    expect(hoy.getTime() - ayer.getTime()).toBe(24 * 60 * 60 * 1000)
    expect(ayer.getHours()).toBe(0)
    expect(ayer.getMinutes()).toBe(0)
  })
})

describe('etiquetaDia() -- ya no depende del índice dentro de DIAS_VISIBLES', () => {
  const hoy = proximosDias(1)[0]
  const ayer = diaAnterior(hoy)
  const mañana = new Date(hoy)
  mañana.setDate(mañana.getDate() + 1)
  const enTresDias = new Date(hoy)
  enTresDias.setDate(enTresDias.getDate() + 3)

  it('devuelve "Ayer" para el día calendario anterior', () => {
    expect(etiquetaDia(ayer)).toBe('Ayer')
  })

  it('devuelve "Hoy" para el día de hoy', () => {
    expect(etiquetaDia(hoy)).toBe('Hoy')
  })

  it('devuelve "Mañana" para el día siguiente', () => {
    expect(etiquetaDia(mañana)).toBe('Mañana')
  })

  it('para cualquier otro día, cae al nombre corto de la semana (mismo criterio que antes)', () => {
    const etiqueta = etiquetaDia(enTresDias)
    expect(etiqueta).not.toBe('Ayer')
    expect(etiqueta).not.toBe('Hoy')
    expect(etiqueta).not.toBe('Mañana')
    expect(etiqueta.length).toBeGreaterThan(0)
  })
})
