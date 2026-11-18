import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import {
  CODIGO_EJERCICIO_EN_USO,
  deleteExercise,
  fetchRoutineFull,
  fetchUsoEjercicios,
  saveRoutineFull,
} from '../../utils/routinesApi'

const mockedFrom = supabase.from
const mockedRpc = supabase.rpc

beforeEach(() => vi.clearAllMocks())

function cadenaDelete(resultado) {
  const chain = { delete: vi.fn(() => chain), eq: vi.fn(() => Promise.resolve(resultado)) }
  return chain
}

describe('deleteExercise (conserva el código de Postgres)', () => {
  it('borra por id', async () => {
    const chain = cadenaDelete({ error: null })
    mockedFrom.mockReturnValue(chain)

    await deleteExercise('ex-1')

    expect(mockedFrom).toHaveBeenCalledWith('exercises')
    expect(chain.delete).toHaveBeenCalled()
    expect(chain.eq).toHaveBeenCalledWith('id', 'ex-1')
  })

  it('ejercicio en uso: lanza con code 23503 (FK RESTRICT) para que la pantalla lo distinga', async () => {
    mockedFrom.mockReturnValue(
      cadenaDelete({ error: { code: '23503', message: 'update or delete on table "exercises" violates foreign key constraint' } }),
    )
    const err = await deleteExercise('ex-1').catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe(CODIGO_EJERCICIO_EN_USO)
    expect(CODIGO_EJERCICIO_EN_USO).toBe('23503')
  })

  it('cualquier otro error se lanza con su mensaje y su código', async () => {
    mockedFrom.mockReturnValue(cadenaDelete({ error: { code: '42501', message: 'permission denied' } }))
    const err = await deleteExercise('ex-1').catch((e) => e)

    expect(err.message).toBe('permission denied')
    expect(err.code).toBe('42501')
  })
})

describe('fetchUsoEjercicios (función admin_uso_ejercicios del servidor)', () => {
  it('sin ids pide todos (p_exercise_ids: null) y arma un Map por ejercicio', async () => {
    mockedRpc.mockResolvedValue({
      data: [
        { exercise_id: 'ex-1', rutinas_asignadas: 3, plantillas: 1, socios: 2, pesos: 4 },
        { exercise_id: 'ex-2', rutinas_asignadas: 0, plantillas: 0, socios: 0, pesos: 0 },
      ],
      error: null,
    })

    const uso = await fetchUsoEjercicios()

    expect(mockedRpc).toHaveBeenCalledWith('admin_uso_ejercicios', { p_exercise_ids: null })
    expect(uso.get('ex-1')).toEqual({ rutinasAsignadas: 3, plantillas: 1, socios: 2, pesos: 4 })
    expect(uso.get('ex-2')).toEqual({ rutinasAsignadas: 0, plantillas: 0, socios: 0, pesos: 0 })
  })

  it('con ids, pide solo esos', async () => {
    mockedRpc.mockResolvedValue({ data: [], error: null })
    await fetchUsoEjercicios(['ex-1'])
    expect(mockedRpc).toHaveBeenCalledWith('admin_uso_ejercicios', { p_exercise_ids: ['ex-1'] })
  })

  it('si la función falla, lanza (nunca devuelve "sin uso" por las dudas)', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { message: 'Esta acción requiere permisos de administrador.' } })
    await expect(fetchUsoEjercicios()).rejects.toThrow('requiere permisos de administrador')
  })
})

// -- Reps/Carga/Descanso vacíos: null en la base <-> '' en el formulario --
// El editor muestra un placeholder de ejemplo ("ej: 20kg (opcional)") cuando el
// campo está vacío; lo que se guarda tiene que ser null, nunca '' ni el ejemplo.

function cadenaSelect(resultado) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve(resultado)),
    then: (ok, ko) => Promise.resolve(resultado).then(ok, ko),
  }
  return chain
}

describe('fetchRoutineFull -- campos null llegan al editor como "" (input controlado)', () => {
  it('carga/reps/descanso/series null -> ""; con valor, se respetan', async () => {
    const routine = { id: 'r-1', user_id: null, title: 'Fuerza', coach_name: null, notes: null, is_template: true }
    const days = [
      {
        id: 'd-1',
        title: 'Día 1',
        order_index: 0,
        routine_exercises: [
          { id: 're-1', exercise_id: 'ex-1', sets: null, reps: null, rest_seconds: null, weight_suggestion: null, notes: null, order_index: 0, exercise: { id: 'ex-1', name: 'Remo', muscle_group: 'Espalda' } },
          { id: 're-2', exercise_id: 'ex-2', sets: 4, reps: '8', rest_seconds: 90, weight_suggestion: '20kg', notes: null, order_index: 1, exercise: { id: 'ex-2', name: 'Press', muscle_group: 'Pecho' } },
        ],
      },
    ]
    mockedFrom.mockImplementation((tabla) =>
      tabla === 'routines' ? cadenaSelect({ data: routine, error: null }) : cadenaSelect({ data: days, error: null }),
    )

    const r = await fetchRoutineFull('r-1')
    const [vacio, lleno] = r.days[0].exercises

    expect(vacio).toMatchObject({ sets: '', reps: '', restSeconds: '', weightSuggestion: '' })
    expect(lleno).toMatchObject({ sets: 4, reps: '8', restSeconds: 90, weightSuggestion: '20kg' })
  })
})

describe('saveRoutineFull -- vaciar Reps/Carga/Descanso guarda null', () => {
  function mockInserts() {
    const inserts = []
    mockedFrom.mockImplementation((tabla) => {
      const chain = {
        insert: vi.fn((fila) => {
          inserts.push({ tabla, fila })
          return chain
        }),
        select: vi.fn(() => chain),
        single: vi.fn(() => Promise.resolve({ data: { id: `${tabla}-id` }, error: null })),
        then: (ok, ko) => Promise.resolve({ error: null }).then(ok, ko),
      }
      return chain
    })
    return inserts
  }

  const base = { id: null, title: 'Fuerza', coachName: null, notes: '', isTemplate: true, userId: null }
  const bloque = (campos) => ({ exerciseId: 'ex-1', exerciseName: 'Remo', sets: 3, notes: '', ...campos })

  it('"" y solo-espacios -> null (nunca "" ni el texto de ejemplo)', async () => {
    const inserts = mockInserts()
    await saveRoutineFull({
      ...base,
      days: [
        {
          title: 'Día 1',
          exercises: [
            bloque({ reps: '', restSeconds: '', weightSuggestion: '' }),
            bloque({ reps: '   ', restSeconds: '', weightSuggestion: '   ' }),
          ],
        },
      ],
    })

    const filas = inserts.filter((i) => i.tabla === 'routine_exercises').map((i) => i.fila)
    expect(filas).toHaveLength(2)
    for (const fila of filas) {
      expect(fila.weight_suggestion).toBeNull()
      expect(fila.reps).toBeNull()
      expect(fila.rest_seconds).toBeNull()
    }
  })

  it('con valores, se guardan tal cual (recortados)', async () => {
    const inserts = mockInserts()
    await saveRoutineFull({
      ...base,
      days: [{ title: 'Día 1', exercises: [bloque({ reps: ' 10-12 ', restSeconds: '60', weightSuggestion: ' 20kg ' })] }],
    })
    const fila = inserts.find((i) => i.tabla === 'routine_exercises').fila
    expect(fila).toMatchObject({ reps: '10-12', rest_seconds: 60, weight_suggestion: '20kg' })
  })
})
