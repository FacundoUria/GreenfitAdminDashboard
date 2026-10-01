import { describe, it, expect, vi } from 'vitest'
import { clasificarFilas, normalizarDni, upsertPorLotes } from '../../../scripts/filasImportacion'

// La base ya no acepta socios sin DNI válido (trigger socios_validar_dni).
// Una sola fila con el DNI mal hacía fallar el lote ENTERO del upsert (200
// socios): ahora esas filas se descartan y se listan ANTES de importar, y si
// igual un lote falla, se reintenta fila por fila.

const fila = (nombre, dni, extra = {}) => ({
  Nombre: nombre,
  Apellido: 'Test',
  'DNI o CI': dni,
  Email: `${nombre.toLowerCase()}@mail.com`,
  Estado: 'Activo',
  'Clases disponibles': '4',
  'Fecha de registro': '5/3/2024',
  ...extra,
})

describe('normalizarDni', () => {
  it('saca puntos y espacios de formato; no adivina nada más', () => {
    expect(normalizarDni('30.111.222')).toBe('30111222')
    expect(normalizarDni(' 30 111 222 ')).toBe('30111222')
    expect(normalizarDni('30111222')).toBe('30111222')
    expect(normalizarDni('1.234.567-8')).toBe('1234567-8')
    expect(normalizarDni('.')).toBeNull()
    expect(normalizarDni('')).toBeNull()
    expect(normalizarDni(undefined)).toBeNull()
  })
})

describe('clasificarFilas', () => {
  it('descarta y lista las filas con DNI inválido o sin DNI; las buenas quedan para importar', () => {
    const { aImportar, descartadas } = clasificarFilas([
      fila('Ana', '30111222'),
      fila('Beto', '.'),
      fila('Carla', ''),
      fila('Dora', '30.222.333'), // con puntos: se normaliza y entra
      fila('Eva', '12345'), // 5 dígitos
      fila('Fede', 'ABC12345'),
      fila('', '30999888'),
      fila('Gabi', '12345678901'), // 11 dígitos
    ])

    expect(aImportar.map((f) => [f.nombre, f.dni])).toEqual([
      ['Ana', '30111222'],
      ['Dora', '30222333'],
    ])
    expect(descartadas).toEqual([
      { linea: 3, nombre: 'Beto Test', dni: '.', email: 'beto@mail.com', motivo: 'sin DNI' },
      { linea: 4, nombre: 'Carla Test', dni: null, email: 'carla@mail.com', motivo: 'sin DNI' },
      { linea: 6, nombre: 'Eva Test', dni: '12345', email: 'eva@mail.com', motivo: 'DNI inválido (tiene que tener entre 6 y 10 dígitos)' },
      { linea: 7, nombre: 'Fede Test', dni: 'ABC12345', email: 'fede@mail.com', motivo: 'DNI inválido (tiene que tener entre 6 y 10 dígitos)' },
      { linea: 8, nombre: 'Test', dni: '30999888', email: '@mail.com', motivo: 'sin nombre' },
      { linea: 9, nombre: 'Gabi Test', dni: '12345678901', email: 'gabi@mail.com', motivo: 'DNI inválido (tiene que tener entre 6 y 10 dígitos)' },
    ])
  })

  it('un socio sin DNI pero con email YA NO se importa por email: se descarta y se lista', () => {
    const { aImportar, descartadas } = clasificarFilas([fila('Lucía', '', { Email: 'LUCIA@mail.com' })])
    expect(aImportar).toEqual([])
    expect(descartadas).toEqual([{ linea: 2, nombre: 'Lucía Test', dni: null, email: 'lucia@mail.com', motivo: 'sin DNI' }])
  })

  it('DNI repetido (también si uno viene con puntos): queda la última aparición', () => {
    const { aImportar, descartadas } = clasificarFilas([
      fila('Ana', '30111222', { 'Clases disponibles': '1' }),
      fila('Ana', '30.111.222', { 'Clases disponibles': '9' }),
    ])
    expect(descartadas).toEqual([])
    expect(aImportar).toHaveLength(1)
    expect(aImportar[0]).toMatchObject({ dni: '30111222', creditos: 9, created_at: '2024-03-05', estado: 'Activo' })
  })

  it('sin filas no rompe', () => {
    expect(clasificarFilas([])).toEqual({ aImportar: [], descartadas: [] })
    expect(clasificarFilas(null)).toEqual({ aImportar: [], descartadas: [] })
  })
})

describe('upsertPorLotes', () => {
  const filas = (n) => Array.from({ length: n }, (_, i) => ({ nombre: `S${i}`, apellido: '', dni: String(30000000 + i) }))

  it('todo bien: un pedido por lote', async () => {
    const upsertLote = vi.fn(async (lote) => ({ cantidad: lote.length, error: null }))
    const r = await upsertPorLotes(filas(450), upsertLote, 200)
    expect(r).toEqual({ importados: 450, rechazadas: [] })
    expect(upsertLote.mock.calls.map(([lote]) => lote.length)).toEqual([200, 200, 50])
  })

  it('si un lote falla, reintenta fila por fila: se pierde SOLO la fila mala, no los 200', async () => {
    const MALA = '30000250'
    const upsertLote = vi.fn(async (lote) =>
      lote.some((f) => f.dni === MALA) ? { cantidad: 0, error: 'duplicate key value' } : { cantidad: lote.length, error: null },
    )
    const r = await upsertPorLotes(filas(450), upsertLote, 200)

    expect(r.importados).toBe(449)
    expect(r.rechazadas).toEqual([{ fila: { nombre: 'S250', apellido: '', dni: MALA }, error: 'duplicate key value' }])
    // 3 lotes + las 200 filas del lote que falló, una por una.
    expect(upsertLote).toHaveBeenCalledTimes(203)
  })
})
