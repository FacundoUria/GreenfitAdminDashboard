import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import { CODIGO_EJERCICIO_EN_USO, deleteExercise, fetchUsoEjercicios } from '../../utils/routinesApi'

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
