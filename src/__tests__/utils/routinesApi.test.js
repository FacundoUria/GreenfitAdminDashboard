import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import {
  CODIGO_EJERCICIO_EN_USO,
  CODIGO_RUTINA_HISTORIAL,
  agruparSesiones,
  asignarRutina,
  deleteExercise,
  duplicateRoutine,
  fetchEntrenamientosPorRutina,
  fetchRoutineFull,
  fetchRutinasDelSocio,
  fetchSocioActiveRoutine,
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
  const base = { id: null, title: 'Fuerza', notes: '', userId: null }
  const bloque = (campos) => ({ exerciseId: 'ex-1', exerciseName: 'Remo', sets: 3, notes: '', ...campos })
  const ejerciciosEnviados = () => mockedRpc.mock.calls[0][1].p_rutina.days.flatMap((d) => d.exercises)

  it('"" y solo-espacios -> null (nunca "" ni el texto de ejemplo)', async () => {
    mockedRpc.mockResolvedValue({ data: 'r-1', error: null })
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

    const filas = ejerciciosEnviados()
    expect(filas).toHaveLength(2)
    for (const fila of filas) {
      expect(fila.weight_suggestion).toBeNull()
      expect(fila.reps).toBeNull()
      expect(fila.rest_seconds).toBeNull()
    }
  })

  it('con valores, se guardan tal cual (recortados)', async () => {
    mockedRpc.mockResolvedValue({ data: 'r-1', error: null })
    await saveRoutineFull({
      ...base,
      days: [{ title: 'Día 1', exercises: [bloque({ reps: ' 10-12 ', restSeconds: '60', weightSuggestion: ' 20kg ' })] }],
    })
    expect(ejerciciosEnviados()[0]).toMatchObject({ reps: '10-12', rest_seconds: 60, weight_suggestion: '20kg' })
  })
})

// -- Historial de rutinas (F1): guardar y asignar van en UNA transacción del servidor --

describe('saveRoutineFull -> admin_guardar_rutina (una sola llamada, nunca INSERTs sueltos)', () => {
  const dias = [
    {
      id: 'd-1',
      title: ' Día A ',
      exercises: [
        { id: 're-1', exerciseId: 'ex-1', exerciseName: 'Remo', sets: '4', reps: '10', restSeconds: 60, weightSuggestion: '', notes: '' },
        { exerciseId: null, exerciseName: ' Hip thrust ', muscleGroup: 'Glúteos', exerciseDescription: '', exerciseVideoUrl: ' ', sets: 3, reps: '12', restSeconds: '', weightSuggestion: '40kg', notes: ' lento ' },
      ],
    },
    { title: '', exercises: [{ exerciseId: 'ex-2', exerciseName: 'Press', sets: 3, reps: '8' }] },
  ]

  it('"Guardar cambios": manda los ids de días y ejercicios (el servidor actualiza en el lugar)', async () => {
    mockedRpc.mockResolvedValue({ data: 'r-1', error: null })
    const id = await saveRoutineFull({ id: 'r-1', title: ' Fuerza ', notes: '', userId: 'u-1', days: dias })

    expect(id).toBe('r-1')
    expect(mockedFrom).not.toHaveBeenCalled()
    expect(mockedRpc).toHaveBeenCalledTimes(1)
    const [fn, { p_rutina }] = mockedRpc.mock.calls[0]
    expect(fn).toBe('admin_guardar_rutina')
    expect(p_rutina).toMatchObject({ id: 'r-1', user_id: 'u-1', como_nueva: false, title: 'Fuerza', notes: null })
    expect(p_rutina.days[0]).toMatchObject({ id: 'd-1', title: 'Día A' })
    expect(p_rutina.days[0].exercises[0]).toEqual({
      id: 're-1', exercise_id: 'ex-1', nuevo: null, sets: 4, reps: '10', rest_seconds: 60, weight_suggestion: null, notes: null,
    })
    // Día sin título -> "Día N"; día nuevo -> id null.
    expect(p_rutina.days[1]).toMatchObject({ id: null, title: 'Día 2' })
  })

  it('un ejercicio que no está en la biblioteca viaja como "nuevo" (lo crea el servidor en la misma transacción)', async () => {
    mockedRpc.mockResolvedValue({ data: 'r-1', error: null })
    await saveRoutineFull({ id: 'r-1', title: 'Fuerza', notes: '', userId: 'u-1', days: dias })
    const nuevo = mockedRpc.mock.calls[0][1].p_rutina.days[0].exercises[1]
    expect(nuevo).toMatchObject({
      id: null,
      exercise_id: null,
      nuevo: { name: 'Hip thrust', muscle_group: 'Glúteos', description: null, video_url: null },
      notes: 'lento',
    })
  })

  it('"Guardar como rutina nueva" manda como_nueva: true', async () => {
    mockedRpc.mockResolvedValue({ data: 'r-2', error: null })
    const id = await saveRoutineFull({ id: 'r-1', title: 'Fuerza', notes: '', userId: 'u-1', days: dias, comoNueva: true })
    expect(id).toBe('r-2')
    expect(mockedRpc.mock.calls[0][1].p_rutina.como_nueva).toBe(true)
  })

  it('el coach solo viaja si se pasa (el editor no lo edita: no lo borra al guardar)', async () => {
    mockedRpc.mockResolvedValue({ data: 'r-1', error: null })
    await saveRoutineFull({ id: 'r-1', title: 'Fuerza', notes: '', userId: null, days: dias })
    expect(mockedRpc.mock.calls[0][1].p_rutina).not.toHaveProperty('coach_name')

    await saveRoutineFull({ id: null, title: 'Fuerza', coachName: ' Seba ', notes: '', userId: null, days: dias })
    expect(mockedRpc.mock.calls[1][1].p_rutina.coach_name).toBe('Seba')
  })

  it('rutina del historial (GFR01): lanza con el mensaje del servidor y el código', async () => {
    mockedRpc.mockResolvedValue({
      data: null,
      error: { code: 'GFR01', message: 'Esta rutina es del historial del socio: es de solo lectura.' },
    })
    const err = await saveRoutineFull({ id: 'r-vieja', title: 'X', notes: '', userId: 'u-1', days: dias }).catch((e) => e)
    expect(err.message).toBe('Esta rutina es del historial del socio: es de solo lectura.')
    expect(err.code).toBe(CODIGO_RUTINA_HISTORIAL)
  })
})

describe('asignarRutina -> admin_asignar_rutina', () => {
  it('pasa socio y rutina de origen, devuelve el id de la rutina nueva', async () => {
    mockedRpc.mockResolvedValue({ data: 'r-nueva', error: null })
    await expect(asignarRutina('u-1', 'plantilla-1')).resolves.toBe('r-nueva')
    expect(mockedRpc).toHaveBeenCalledWith('admin_asignar_rutina', { p_user_id: 'u-1', p_origen_id: 'plantilla-1' })
    expect(mockedFrom).not.toHaveBeenCalled()
  })

  it('si el servidor la rechaza, lanza con su mensaje', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'Esa ya es la rutina vigente del socio.' } })
    await expect(asignarRutina('u-1', 'r-1')).rejects.toThrow('Esa ya es la rutina vigente del socio.')
  })
})

describe('duplicateRoutine (Biblioteca): copia la plantilla sin sus ids', () => {
  it('trae la plantilla y la guarda como plantilla nueva, con ids en null', async () => {
    const routine = { id: 'p-1', user_id: null, title: 'Base', coach_name: 'Seba', notes: null, is_template: true }
    const days = [{ id: 'd-1', title: 'Día 1', order_index: 0, routine_exercises: [{ id: 're-1', exercise_id: 'ex-1', sets: 3, reps: '10', order_index: 0, exercise: { name: 'Remo' } }] }]
    mockedFrom.mockImplementation((tabla) =>
      tabla === 'routines' ? cadenaSelect({ data: routine, error: null }) : cadenaSelect({ data: days, error: null }),
    )
    mockedRpc.mockResolvedValue({ data: 'p-2', error: null })

    await duplicateRoutine('p-1', { title: 'Base (copia)' })

    const p = mockedRpc.mock.calls[0][1].p_rutina
    expect(p).toMatchObject({ id: null, user_id: null, title: 'Base (copia)', coach_name: 'Seba' })
    expect(p.days[0].id).toBeNull()
    expect(p.days[0].exercises[0]).toMatchObject({ id: null, exercise_id: 'ex-1' })
  })
})

function cadenaLista(resultado) {
  const chain = {}
  for (const m of ['select', 'eq', 'is', 'order', 'limit']) chain[m] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(() => Promise.resolve(resultado))
  chain.then = (ok, ko) => Promise.resolve(resultado).then(ok, ko)
  return chain
}

describe('fetchRutinasDelSocio (rutina actual + historial)', () => {
  it('separa la vigente de las anteriores (más nueva primero), sin plantillas y sin archivadas', async () => {
    const chain = cadenaLista({
      data: [
        { id: 'r-1', title: 'Vieja', is_template: false, created_at: '2026-01-01T10:00:00Z', vigente_desde: '2026-01-01T10:00:00Z', vigente_hasta: '2026-03-01T10:00:00Z' },
        { id: 'r-3', title: 'Actual', is_template: false, created_at: '2026-06-01T10:00:00Z', vigente_desde: '2026-06-01T10:00:00Z', vigente_hasta: null },
        { id: 'r-2', title: 'Media', is_template: false, created_at: '2026-03-01T10:00:00Z', vigente_desde: '2026-03-01T10:00:00Z', vigente_hasta: '2026-06-01T10:00:00Z' },
        { id: 'rara', title: 'Plantilla con socio', is_template: true, created_at: '2026-02-01T10:00:00Z', vigente_desde: null, vigente_hasta: null },
      ],
      error: null,
    })
    mockedFrom.mockReturnValue(chain)

    const { vigente, anteriores } = await fetchRutinasDelSocio('u-1')

    expect(mockedFrom).toHaveBeenCalledWith('routines')
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'u-1')
    expect(chain.is).toHaveBeenCalledWith('archivada_en', null)
    expect(vigente).toMatchObject({ id: 'r-3', title: 'Actual', vigenteHasta: null })
    expect(anteriores.map((r) => r.id)).toEqual(['r-2', 'r-1'])
    expect(anteriores[0]).toMatchObject({ vigenteDesde: '2026-03-01T10:00:00Z', vigenteHasta: '2026-06-01T10:00:00Z' })
  })

  it('sin rutinas: vigente null y sin anteriores', async () => {
    mockedFrom.mockReturnValue(cadenaLista({ data: [], error: null }))
    await expect(fetchRutinasDelSocio('u-1')).resolves.toEqual({ vigente: null, anteriores: [] })
  })
})

describe('fetchSocioActiveRoutine: la VIGENTE (vigente_hasta null), no "la más nueva"', () => {
  it('filtra por vigente_hasta null', async () => {
    const chain = cadenaLista({ data: null, error: null })
    mockedFrom.mockReturnValue(chain)
    await expect(fetchSocioActiveRoutine('u-1')).resolves.toBeNull()
    expect(chain.is).toHaveBeenCalledWith('vigente_hasta', null)
  })
})

describe('fetchEntrenamientosPorRutina / agruparSesiones', () => {
  it('cuenta sesiones distintas por rutina; las viejas sin rutina no cuentan', async () => {
    mockedFrom.mockReturnValue(
      cadenaLista({
        data: [
          { routine_id: 'r-1', sesion_id: 's-1' },
          { routine_id: 'r-1', sesion_id: 's-1' },
          { routine_id: 'r-1', sesion_id: 's-2' },
          { routine_id: 'r-2', sesion_id: 's-3' },
          { routine_id: null, sesion_id: 's-vieja' },
        ],
        error: null,
      }),
    )
    const conteos = await fetchEntrenamientosPorRutina('u-1')
    expect(conteos.get('r-1')).toBe(2)
    expect(conteos.get('r-2')).toBe(1)
    expect(conteos.size).toBe(2)
  })

  it('agrupa filas por sesión (más nueva primero), ordena ejercicios y marca las ocultas', () => {
    const sesiones = agruparSesiones([
      { id: 'a', sesion_id: 's-1', created_at: '2026-06-01T10:00:00Z', nombre_ejercicio: 'Press', orden: 1, oculta_en: null, total_ejercicios: 3 },
      { id: 'b', sesion_id: 's-1', created_at: '2026-06-01T10:00:00Z', nombre_ejercicio: 'Remo', orden: 0, oculta_en: null, total_ejercicios: 3 },
      { id: 'c', sesion_id: 's-2', created_at: '2026-06-03T10:00:00Z', nombre_ejercicio: 'Remo', orden: 0, oculta_en: '2026-06-04T10:00:00Z', total_ejercicios: 1 },
    ])
    expect(sesiones.map((s) => s.sesionId)).toEqual(['s-2', 's-1'])
    expect(sesiones[0].oculta).toBe(true)
    expect(sesiones[1].ejercicios.map((e) => e.nombre)).toEqual(['Remo', 'Press'])
  })
})
