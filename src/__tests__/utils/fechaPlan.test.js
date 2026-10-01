import { describe, it, expect } from 'vitest'
import { diasHastaVencimientoPlan, fechaPlanSocio, fechaVencimientoParaCobro } from '../../utils/fechaPlan'

// ETAPA 4, PARTE B -- el vencimiento general del socio se calcula desde
// user_credits (créditos y Aparatos reales), no desde socios.fecha_vencimiento:
// para un socio de SOLO CRÉDITOS esa columna queda vieja o vacía.

// Mediodía UTC = 09:00 en Argentina: mismo día calendario en los dos lados.
const ts = (dia) => `${dia}T12:00:00.000Z`
const lotes = (...dias) => [{ disciplineId: 'cf', disciplineName: 'CrossFit', remainingCredits: 4, lotes: dias.map((d) => ({ id: d, remainingCredits: 2, expiresAt: ts(d) })) }]

describe('fechaPlanSocio', () => {
  it('socio de SOLO CRÉDITOS con la columna vieja: gana la fecha real de sus créditos', () => {
    const socio = { fecha_vencimiento: '2026-07-10', aparatosVigenteReal: false, creditosPwaPorDisciplina: lotes('2026-10-20') }
    expect(fechaPlanSocio(socio)).toBe('2026-10-20')
  })

  it('socio de solo créditos con la columna VACÍA: igual tiene fecha', () => {
    expect(fechaPlanSocio({ fecha_vencimiento: null, aparatosVigenteReal: false, creditosPwaPorDisciplina: lotes('2026-10-20') })).toBe('2026-10-20')
  })

  it('con cuenta y SIN nada activo: null, aunque la columna tenga una fecha futura fantasma', () => {
    expect(fechaPlanSocio({ fecha_vencimiento: '2052-08-21', aparatosVigenteReal: false, creditosPwaPorDisciplina: [] })).toBeNull()
  })

  it('toma la fecha MÁS LEJANA entre créditos y Aparatos reales (mismo criterio que la PWA)', () => {
    const socio = {
      fecha_vencimiento: '2026-01-01',
      aparatosVigenteReal: true,
      membresiasVigentes: [{ disciplineId: 'ap', disciplineName: 'Aparatos', expiresAt: ts('2026-11-05') }],
      creditosPwaPorDisciplina: lotes('2026-10-20', '2026-10-28'),
    }
    expect(fechaPlanSocio(socio)).toBe('2026-11-05')
  })

  it('Aparatos vigente confirmado pero sin su fecha real cargada: respaldo en la columna', () => {
    expect(fechaPlanSocio({ fechaVencimiento: '2026-10-15', aparatosVigenteReal: true, creditosPwaPorDisciplina: [] })).toBe('2026-10-15')
  })

  it('SIN cuenta en la app: la columna es la única fuente (vigente o ya pasada)', () => {
    expect(fechaPlanSocio({ fecha_vencimiento: '2026-10-15' })).toBe('2026-10-15')
    expect(fechaPlanSocio({ fechaVencimiento: '2026-03-01', creditosPwaPorDisciplina: [] })).toBe('2026-03-01')
    expect(fechaPlanSocio({ fecha_vencimiento: null })).toBeNull()
  })

  it('pasa el timestamp al día calendario de ARGENTINA (un lote que vence a las 02:00 UTC es del día anterior)', () => {
    const socio = { aparatosVigenteReal: false, creditosPwaPorDisciplina: [{ lotes: [{ expiresAt: '2026-10-21T02:00:00.000Z' }] }] }
    expect(fechaPlanSocio(socio)).toBe('2026-10-20')
  })

  it('sin socio no rompe', () => {
    expect(fechaPlanSocio(null)).toBeNull()
  })
})

describe('diasHastaVencimientoPlan -- "Por vencer"', () => {
  const ahora = new Date('2026-10-17T15:00:00')

  it('un socio de solo créditos al que le faltan 3 días aparece, aunque la columna diga otra cosa', () => {
    const socio = { fecha_vencimiento: '2026-07-10', aparatosVigenteReal: false, creditosPwaPorDisciplina: lotes('2026-10-20') }
    expect(diasHastaVencimientoPlan(socio, ahora)).toBe(3)
  })

  it('sin ninguna fecha: null (no entra en "Por vencer")', () => {
    expect(diasHastaVencimientoPlan({ aparatosVigenteReal: false, creditosPwaPorDisciplina: [] }, ahora)).toBeNull()
  })

  it('sin cuenta en la app: igual que siempre, desde la columna', () => {
    expect(diasHastaVencimientoPlan({ fecha_vencimiento: '2026-10-19' }, ahora)).toBe(2)
  })
})

describe('fechaVencimientoParaCobro', () => {
  const HOY = '2026-10-17'

  it('socio de solo créditos al día con la columna vieja: se parte de su vencimiento REAL (no "está vencido")', () => {
    const socio = { fechaVencimiento: '2026-07-10', aparatosVigenteReal: false, creditosPwaPorDisciplina: lotes('2026-10-20') }
    expect(fechaVencimientoParaCobro(socio, HOY)).toBe('2026-10-20')
  })

  it('con cuenta, nada vigente y la columna ya pasada: esa fecha ("venció el ...")', () => {
    expect(fechaVencimientoParaCobro({ fechaVencimiento: '2026-09-01', aparatosVigenteReal: false, creditosPwaPorDisciplina: [] }, HOY)).toBe('2026-09-01')
  })

  it('con cuenta, nada vigente y la columna con una fecha FUTURA fantasma: null (el cobro arranca hoy)', () => {
    expect(fechaVencimientoParaCobro({ fechaVencimiento: '2052-08-21', aparatosVigenteReal: false, creditosPwaPorDisciplina: [] }, HOY)).toBeNull()
  })

  it('sin cuenta en la app: la columna, igual que siempre', () => {
    expect(fechaVencimientoParaCobro({ fechaVencimiento: '2026-11-02' }, HOY)).toBe('2026-11-02')
    expect(fechaVencimientoParaCobro({ fechaVencimiento: '2026-09-01' }, HOY)).toBe('2026-09-01')
    expect(fechaVencimientoParaCobro({ fechaVencimiento: null }, HOY)).toBeNull()
  })
})
