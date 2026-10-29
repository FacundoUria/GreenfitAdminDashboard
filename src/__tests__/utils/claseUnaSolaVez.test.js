import { describe, it, expect } from 'vitest'
import {
  claseSeDictaElDia,
  diaSemanaDeFecha,
  diasYFechaParaGuardar,
  esUnaSolaVezPasada,
  fechaUnicaCorta,
  filaSeDictaElDia,
  mensajeErrorGuardarClase,
  textoFechaUnica,
} from '../../utils/claseUnaSolaVez'
import { avisoDiaPasado, clasesDeUnDiaPasado } from '../../utils/calendarioClases'

// Pedido de Seba: una clase especial de un miércoles se repetía todas las
// semanas. classes.fecha_unica = la clase existe SOLO ese día.
// 2026-11-04 y 2026-11-11 son miércoles (3); 2026-11-05 es jueves.
const SEMANAL_MIE = { id: 's', days_of_week: [3], fecha_unica: null }
const UNICA_4_11 = { id: 'u', days_of_week: [3], fecha_unica: '2026-11-04' }

describe('claseUnaSolaVez -- en qué días se dicta', () => {
  it('día de semana con la misma regla que classes.days_of_week (0 = domingo)', () => {
    expect(diaSemanaDeFecha('2026-11-04')).toBe(3)
    expect(diaSemanaDeFecha('2026-11-08')).toBe(0)
  })

  it('una semanal se dicta todas las semanas de su día, igual que antes', () => {
    expect(filaSeDictaElDia(SEMANAL_MIE, '2026-11-04')).toBe(true)
    expect(filaSeDictaElDia(SEMANAL_MIE, '2026-11-11')).toBe(true)
    expect(filaSeDictaElDia(SEMANAL_MIE, '2026-11-05')).toBe(false)
  })

  it('una de una sola vez SOLO su fecha -- no el miércoles siguiente (el bug de Seba)', () => {
    expect(filaSeDictaElDia(UNICA_4_11, '2026-11-04')).toBe(true)
    expect(filaSeDictaElDia(UNICA_4_11, '2026-11-11')).toBe(false)
    expect(filaSeDictaElDia(UNICA_4_11, '2026-10-28')).toBe(false)
  })

  it('una fila sin la columna (fixtures viejos / antes de migrar) es semanal', () => {
    expect(filaSeDictaElDia({ days_of_week: [3] }, '2026-11-11')).toBe(true)
  })

  it('una clase con days_of_week vacío (como Kick) no se dicta ningún día', () => {
    expect(filaSeDictaElDia({ days_of_week: [], fecha_unica: null }, '2026-11-04')).toBe(false)
  })

  it('misma regla sobre la clase ya mapeada (diasSemana / fechaUnica)', () => {
    const clase = { diasSemana: [3], fechaUnica: '2026-11-04' }
    expect(claseSeDictaElDia(clase, '2026-11-04')).toBe(true)
    expect(claseSeDictaElDia(clase, '2026-11-11')).toBe(false)
  })

  it('pasada = fecha anterior a hoy; hoy todavía no', () => {
    expect(esUnaSolaVezPasada('2026-10-27', '2026-10-28')).toBe(true)
    expect(esUnaSolaVezPasada('2026-10-28', '2026-10-28')).toBe(false)
    expect(esUnaSolaVezPasada(null, '2026-10-28')).toBe(false)
  })

  it('textos de fecha', () => {
    expect(textoFechaUnica('2026-11-04')).toBe('Miércoles 4 de noviembre')
    expect(fechaUnicaCorta('2026-11-04')).toBe('04/11')
  })
})

describe('claseUnaSolaVez -- qué se guarda según el switch', () => {
  const HOY = '2026-10-28'

  it('"Una sola vez": days_of_week = {día de la fecha} + fecha_unica (lo que exige el CHECK)', () => {
    expect(diasYFechaParaGuardar({ modo: 'unica', diasSemana: [1, 2], fechaUnica: '2026-11-05' }, HOY)).toEqual({
      days_of_week: [4],
      fecha_unica: '2026-11-05',
    })
  })

  it('"Una sola vez" hoy se puede; antes de hoy no', () => {
    expect(diasYFechaParaGuardar({ modo: 'unica', diasSemana: [], fechaUnica: HOY }, HOY).fecha_unica).toBe(HOY)
    expect(diasYFechaParaGuardar({ modo: 'unica', diasSemana: [], fechaUnica: '2026-10-27' }, HOY)).toEqual({
      error: 'La fecha no puede ser anterior a hoy.',
    })
    expect(diasYFechaParaGuardar({ modo: 'unica', diasSemana: [], fechaUnica: '' }, HOY).error).toBe('Elegí la fecha de la clase.')
  })

  it('"Todas las semanas": los días elegidos y fecha_unica en null (aunque haya una fecha cargada)', () => {
    expect(diasYFechaParaGuardar({ modo: 'semanal', diasSemana: [1, 3], fechaUnica: '2026-11-04' }, HOY)).toEqual({
      days_of_week: [1, 3],
      fecha_unica: null,
    })
    expect(diasYFechaParaGuardar({ modo: 'semanal', diasSemana: [], fechaUnica: null }, HOY).error).toBe(
      'Seleccioná al menos un día de la semana.',
    )
  })

  it('los rechazos del trigger se muestran tal cual; el resto, el mensaje genérico', () => {
    const reservas = 'Hay reservas de hoy en adelante en fechas donde la clase ya no se dictaría: 11/11 (2). Cancelá primero la clase en esas fechas (reintegra el crédito y avisa a los socios).'
    expect(mensajeErrorGuardarClase({ message: reservas })).toBe(reservas)
    const pasada = 'La fecha de una clase de una sola vez no puede ser anterior a hoy (28/10/2026).'
    expect(mensajeErrorGuardarClase({ message: pasada })).toBe(pasada)
    expect(mensajeErrorGuardarClase({ message: 'permission denied' })).toBe('No se pudo guardar la clase. Intentá nuevamente.')
    expect(mensajeErrorGuardarClase(null)).toBe('No se pudo guardar la clase. Intentá nuevamente.')
  })
})

describe('calendario -- días pasados con clases de una sola vez', () => {
  const base = { todasLasClases: [], classIdsConReserva: new Set(), classIdsCanceladas: new Set() }

  it('un día pasado del mismo día de semana NO muestra la de una sola vez de otra fecha', () => {
    const delDia = clasesDeUnDiaPasado({ ...base, fecha: '2026-10-21', plantillas: [SEMANAL_MIE, UNICA_4_11] })
    expect(delDia.map((c) => c.id)).toEqual(['s'])
  })

  it('en SU fecha sí aparece', () => {
    const delDia = clasesDeUnDiaPasado({ ...base, fecha: '2026-11-04', plantillas: [SEMANAL_MIE, UNICA_4_11] })
    expect(delDia.map((c) => c.id)).toEqual(['s', 'u'])
  })

  it('una reserva vieja de otra fecha la sigue mostrando (historial), con aviso', () => {
    const delDia = clasesDeUnDiaPasado({
      ...base,
      fecha: '2026-10-21',
      plantillas: [UNICA_4_11],
      todasLasClases: [UNICA_4_11],
      classIdsConReserva: new Set(['u']),
    })
    expect(delDia.map((c) => c.id)).toEqual(['u'])
    const clase = { diasSemana: [3], fechaUnica: '2026-11-04', inscriptos: [], cupoMaximo: 10 }
    expect(avisoDiaPasado(clase, '2026-10-21')).toMatch(/una sola vez \(04\/11\)/)
  })

  it('en su propia fecha no hay aviso', () => {
    const clase = { diasSemana: [3], fechaUnica: '2026-11-04', inscriptos: [], cupoMaximo: 10 }
    expect(avisoDiaPasado(clase, '2026-11-04')).toBeNull()
  })
})
