import { describe, it, expect } from 'vitest'
import { planesDeVencimiento, planesDeCreditos, tienePlanDeVencimiento } from '../../utils/planes'

describe('planesDeVencimiento (subconjunto de plan que es "por vencimiento", no créditos)', () => {
  it('devuelve solo los planes de vencimiento en una cuenta multi-disciplina', () => {
    expect(planesDeVencimiento(['Aparatos / Musculación', 'Boxeo', 'CrossFit'])).toEqual(['Aparatos / Musculación'])
  })

  it('devuelve un array vacío si el socio es 100% créditos', () => {
    expect(planesDeVencimiento(['Boxeo', 'CrossFit'])).toEqual([])
  })

  it('reconoce "Pase Libre" como plan de vencimiento también', () => {
    expect(planesDeVencimiento(['Pase Libre'])).toEqual(['Pase Libre'])
  })

  it('nunca se superpone con planesDeCreditos para el mismo plan', () => {
    const plan = ['Aparatos / Musculación', 'Boxeo', 'CrossFit', 'Kickboxing', 'Pase Libre']
    const vencimiento = planesDeVencimiento(plan)
    const creditos = planesDeCreditos(plan)
    expect(vencimiento.some((p) => creditos.includes(p))).toBe(false)
    expect(vencimiento.length + creditos.length).toBe(plan.length)
  })

  it('coincide con tienePlanDeVencimiento (uno es la versión booleana del otro)', () => {
    expect(planesDeVencimiento(['Boxeo']).length > 0).toBe(tienePlanDeVencimiento(['Boxeo']))
    expect(planesDeVencimiento(['Aparatos / Musculación']).length > 0).toBe(
      tienePlanDeVencimiento(['Aparatos / Musculación']),
    )
  })
})
