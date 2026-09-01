import { describe, it, expect } from 'vitest'
import { planesDeVencimiento, planesDeCreditos, tienePlanDeVencimiento, normalizarPlanes, formatearPlanes } from '../../utils/planes'

// Bug real reportado: la grilla de Socios mostraba disciplinas duplicadas
// visualmente (ej. "Aparatos Aparatos", "Crossfit Crossfit") -- causa real:
// un socio con "CrossFit" Y "Crosstraining" en su plan quedó con
// plan=["CrossFit","CrossFit"] LITERAL después de la unificación de
// nomenclatura (cada string se normalizó por separado, sin deduplicar el
// array resultante). normalizarPlanes() es el único punto por el que pasa
// CUALQUIER lectura de `plan` en el panel -- dedupear ahí corta el problema
// de raíz para toda la UI (grilla, formularios, sincronización de créditos)
// de una sola vez, sin importar si el dato en la base ya está limpio o no
// (ver supabase_migration_limpiar_duplicados_plan.sql para el backfill).
describe('normalizarPlanes (dedupe -- fix del bug "Aparatos Aparatos" en la grilla)', () => {
  it('elimina duplicados exactos preservando el resto del array', () => {
    expect(normalizarPlanes(['CrossFit', 'CrossFit'])).toEqual(['CrossFit'])
    expect(normalizarPlanes(['Aparatos', 'Boxeo', 'Aparatos'])).toEqual(['Aparatos', 'Boxeo'])
  })

  it('sin duplicados, no cambia nada (no-op)', () => {
    expect(normalizarPlanes(['CrossFit', 'Boxeo'])).toEqual(['CrossFit', 'Boxeo'])
  })

  it('preserva el orden de la PRIMERA aparición de cada valor', () => {
    expect(normalizarPlanes(['Boxeo', 'CrossFit', 'Boxeo', 'Aparatos'])).toEqual(['Boxeo', 'CrossFit', 'Aparatos'])
  })

  it('sigue soportando `plan` como texto suelto (dato legacy) y null/vacío', () => {
    expect(normalizarPlanes('CrossFit')).toEqual(['CrossFit'])
    expect(normalizarPlanes(null)).toEqual([])
    expect(normalizarPlanes([])).toEqual([])
  })

  it('formatearPlanes ya no muestra el duplicado en la grilla de Socios', () => {
    expect(formatearPlanes(['Aparatos', 'Aparatos'])).toBe('Aparatos')
    expect(formatearPlanes(['CrossFit', 'CrossFit', 'Boxeo'])).toBe('CrossFit, Boxeo')
  })
})

describe('planesDeVencimiento (subconjunto de plan que es "por vencimiento", no créditos)', () => {
  it('devuelve solo los planes de vencimiento en una cuenta multi-disciplina', () => {
    expect(planesDeVencimiento(['Aparatos', 'Boxeo', 'CrossFit'])).toEqual(['Aparatos'])
  })

  it('devuelve un array vacío si el socio es 100% créditos', () => {
    expect(planesDeVencimiento(['Boxeo', 'CrossFit'])).toEqual([])
  })

  it('reconoce "Pase Libre" como plan de vencimiento también', () => {
    expect(planesDeVencimiento(['Pase Libre'])).toEqual(['Pase Libre'])
  })

  it('nunca se superpone con planesDeCreditos para el mismo plan', () => {
    const plan = ['Aparatos', 'Boxeo', 'CrossFit', 'Kickstrike', 'Pase Libre']
    const vencimiento = planesDeVencimiento(plan)
    const creditos = planesDeCreditos(plan)
    expect(vencimiento.some((p) => creditos.includes(p))).toBe(false)
    expect(vencimiento.length + creditos.length).toBe(plan.length)
  })

  it('coincide con tienePlanDeVencimiento (uno es la versión booleana del otro)', () => {
    expect(planesDeVencimiento(['Boxeo']).length > 0).toBe(tienePlanDeVencimiento(['Boxeo']))
    expect(planesDeVencimiento(['Aparatos']).length > 0).toBe(
      tienePlanDeVencimiento(['Aparatos']),
    )
  })
})
