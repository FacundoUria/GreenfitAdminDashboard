import { describe, it, expect } from 'vitest'
import { estaEnUso, textoNoSePuedeBorrar, textoUsoCorto } from '../../utils/usoEjercicios'

const uso = (extra) => ({ rutinasAsignadas: 0, plantillas: 0, socios: 0, pesos: 0, ...extra })

describe('estaEnUso (lo que la base no deja borrar: FK RESTRICT)', () => {
  it('sin rutinas, plantillas ni pesos: no está en uso', () => {
    expect(estaEnUso(uso())).toBe(false)
  })

  it('en una rutina de un socio, en una plantilla, o con pesos de un socio: está en uso', () => {
    expect(estaEnUso(uso({ rutinasAsignadas: 1, socios: 1 }))).toBe(true)
    expect(estaEnUso(uso({ plantillas: 1 }))).toBe(true)
    expect(estaEnUso(uso({ pesos: 1 }))).toBe(true)
  })

  it('sin datos de uso no se asume nada', () => {
    expect(estaEnUso(undefined)).toBe(false)
    expect(estaEnUso(null)).toBe(false)
  })
})

describe('textoNoSePuedeBorrar', () => {
  it('rutinas de socios', () => {
    expect(textoNoSePuedeBorrar(uso({ rutinasAsignadas: 3, socios: 2 }))).toBe('No se puede borrar: lo usan 3 rutinas de 2 socios.')
  })

  it('singular', () => {
    expect(textoNoSePuedeBorrar(uso({ rutinasAsignadas: 1, socios: 1 }))).toBe('No se puede borrar: lo usa 1 rutina de 1 socio.')
  })

  it('rutinas y plantillas', () => {
    expect(textoNoSePuedeBorrar(uso({ rutinasAsignadas: 3, socios: 2, plantillas: 1 }))).toBe(
      'No se puede borrar: lo usan 3 rutinas de 2 socios y 1 plantilla.',
    )
  })

  it('solo plantillas', () => {
    expect(textoNoSePuedeBorrar(uso({ plantillas: 2 }))).toBe('No se puede borrar: lo usan 2 plantillas.')
  })

  it('solo pesos de socios (sin estar en ninguna rutina)', () => {
    expect(textoNoSePuedeBorrar(uso({ pesos: 4 }))).toBe('No se puede borrar: tiene pesos cargados por 4 socios.')
  })

  it('rutinas y pesos', () => {
    expect(textoNoSePuedeBorrar(uso({ rutinasAsignadas: 1, socios: 1, pesos: 1 }))).toBe(
      'No se puede borrar: lo usa 1 rutina de 1 socio, y tiene pesos cargados por 1 socio.',
    )
  })
})

describe('textoUsoCorto (etiqueta de la fila)', () => {
  it('lista solo lo que tiene', () => {
    expect(textoUsoCorto(uso({ rutinasAsignadas: 3, socios: 2, plantillas: 1 }))).toBe('En uso: 3 rutinas, 1 plantilla')
    expect(textoUsoCorto(uso({ pesos: 2 }))).toBe('En uso: pesos de 2 socios')
  })
})
