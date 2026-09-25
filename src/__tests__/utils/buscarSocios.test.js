import { describe, it, expect } from 'vitest'
import { filtrarSocios, mensajeErrorAnotar, normalizarTexto, pareceDni, soloDigitos } from '../../utils/buscarSocios'

const SOCIOS = [
  { id: 'u1', full_name: 'Martina Ríos', dni: '30111222' },
  { id: 'u2', full_name: 'Mariano Ibáñez', dni: '28999888' },
  { id: 'u3', full_name: 'José Ángel Núñez', dni: '44537978' },
  { id: 'u4', full_name: 'Lucía Martínez', dni: '31.222.333' },
  { id: 'u5', full_name: 'Socio Sin Dni', dni: null },
]

const ids = (lista) => lista.map((s) => s.id)

describe('normalizarTexto / soloDigitos / pareceDni', () => {
  it('ignora tildes, mayúsculas y espacios sobrantes', () => {
    expect(normalizarTexto('  JOSÉ   Ángel Núñez ')).toBe('jose angel nunez')
    expect(normalizarTexto(null)).toBe('')
  })

  it('soloDigitos saca puntos y todo lo que no sea número', () => {
    expect(soloDigitos('44.537.978')).toBe('44537978')
    expect(soloDigitos(null)).toBe('')
  })

  it('pareceDni: números con o sin puntos/espacios sí; nombres o mezclas no', () => {
    expect(pareceDni('44537978')).toBe(true)
    expect(pareceDni('44.537.978')).toBe(true)
    expect(pareceDni(' 44 537 978 ')).toBe(true)
    expect(pareceDni('martina')).toBe(false)
    expect(pareceDni('martina 30')).toBe(false)
    expect(pareceDni('')).toBe(false)
    expect(pareceDni('...')).toBe(false)
  })
})

describe('filtrarSocios', () => {
  it('sin texto no devuelve nada (la lista solo aparece al escribir)', () => {
    expect(filtrarSocios(SOCIOS, '')).toEqual([])
    expect(filtrarSocios(SOCIOS, '   ')).toEqual([])
    expect(filtrarSocios(null, 'mar')).toEqual([])
  })

  it('por nombre o apellido, ignorando tildes y mayúsculas', () => {
    expect(ids(filtrarSocios(SOCIOS, 'rios'))).toEqual(['u1'])
    expect(ids(filtrarSocios(SOCIOS, 'RÍOS'))).toEqual(['u1'])
    expect(ids(filtrarSocios(SOCIOS, 'nunez'))).toEqual(['u3'])
    expect(ids(filtrarSocios(SOCIOS, 'ibanez'))).toEqual(['u2']) // también la ñ se busca como n
    expect(ids(filtrarSocios(SOCIOS, 'ibañez'))).toEqual(['u2'])
  })

  it('por DNI parcial o completo, con o sin puntos, en cualquiera de los dos lados', () => {
    expect(ids(filtrarSocios(SOCIOS, '44537978'))).toEqual(['u3'])
    expect(ids(filtrarSocios(SOCIOS, '44.537.978'))).toEqual(['u3'])
    expect(ids(filtrarSocios(SOCIOS, '4453'))).toEqual(['u3'])
    // DNI guardado con puntos ("31.222.333") también se encuentra sin puntos:
    expect(ids(filtrarSocios(SOCIOS, '31222333'))).toEqual(['u4'])
  })

  it('varias palabras: todas tienen que aparecer (nombre + apellido, en cualquier orden)', () => {
    expect(ids(filtrarSocios(SOCIOS, 'martina rios'))).toEqual(['u1'])
    expect(ids(filtrarSocios(SOCIOS, 'rios martina'))).toEqual(['u1'])
    expect(ids(filtrarSocios(SOCIOS, 'martina lopez'))).toEqual([])
    // nombre + parte del DNI
    expect(ids(filtrarSocios(SOCIOS, 'martina 3011'))).toEqual(['u1'])
  })

  it('un mismo texto puede traer varios: primero los que EMPIEZAN con lo escrito, después el resto, alfabético', () => {
    // "mar": los tres tienen una palabra que empieza con "mar" (Martina, Mariano, Martínez) -> alfabético
    expect(ids(filtrarSocios(SOCIOS, 'mar'))).toEqual(['u4', 'u2', 'u1'])
    // "tin" no empieza ninguna palabra: quedan por orden alfabético
    expect(ids(filtrarSocios(SOCIOS, 'tin'))).toEqual(['u4', 'u1'])
  })

  it('un socio sin DNI se encuentra por nombre pero nunca por número', () => {
    expect(ids(filtrarSocios(SOCIOS, 'sin dni'))).toEqual(['u5'])
    expect(ids(filtrarSocios(SOCIOS, '0'))).not.toContain('u5')
  })

  it('no modifica la lista original', () => {
    const copia = JSON.stringify(SOCIOS)
    filtrarSocios(SOCIOS, 'mar')
    expect(JSON.stringify(SOCIOS)).toBe(copia)
  })
})

describe('mensajeErrorAnotar', () => {
  it('duplicado (código 23505 de Postgres) -> "ya está anotado", sin el texto crudo', () => {
    const msg = mensajeErrorAnotar({ code: '23505', message: 'duplicate key value violates unique constraint "bookings_user_id_class_id_booking_date_key"' }, 'Martina Ríos')
    expect(msg).toBe('Ya anotado: Martina Ríos ya está en esta clase.')
    expect(msg).not.toMatch(/duplicate|constraint|key/i)
  })

  it('duplicado detectado solo por el texto (sin code)', () => {
    expect(mensajeErrorAnotar({ message: 'duplicate key value violates unique constraint "x"' }, 'Ana')).toBe(
      'Ya anotado: Ana ya está en esta clase.',
    )
    expect(mensajeErrorAnotar({ code: '23505', message: '' }, null)).toBe('Ya anotado: el socio ya está en esta clase.')
  })

  it('cualquier otro error conserva el mensaje del backend, igual que antes', () => {
    for (const texto of ['Sin cupo', 'No tenés créditos disponibles', 'La clase está cancelada ese día', 'Solo el admin puede hacer esto']) {
      expect(mensajeErrorAnotar({ code: 'P0001', message: texto }, 'Ana')).toBe(`No se pudo anotar al socio: ${texto}`)
    }
  })
})
