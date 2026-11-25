import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Editor de rutinas -- Reps/Carga/Descanso. El "20kg" de Carga era un
// placeholder con la misma letra que un valor real: los profes intentaban
// "borrarlo" y no podían (el campo ya estaba vacío). Ahora el placeholder dice
// "ej: ... (opcional)" en itálica y tenue, y vaciar el campo guarda null.

vi.mock('../../utils/routinesApi', () => ({
  CODIGO_BORRARIA_REGISTRO: 'GFR04',
  fetchExercises: vi.fn(),
  fetchRoutineFull: vi.fn(),
  saveRoutineFull: vi.fn(),
}))

import * as api from '../../utils/routinesApi'
import RutinaEditorModal from '../../components/rutinas/RutinaEditorModal'

const RUTINA = {
  id: 'r-1',
  title: 'Fuerza',
  notes: '',
  isTemplate: true,
  days: [
    {
      title: 'Día 1',
      exercises: [
        {
          id: 're-1',
          exerciseId: 'ex-1',
          exerciseName: 'Sentadilla',
          muscleGroup: 'Piernas',
          exerciseDescription: '',
          exerciseVideoUrl: '',
          sets: 4,
          reps: '8',
          restSeconds: 90,
          weightSuggestion: '60kg',
          notes: '',
        },
      ],
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchExercises.mockResolvedValue([{ id: 'ex-1', name: 'Sentadilla', muscle_group: 'Piernas' }])
  api.fetchRoutineFull.mockResolvedValue(RUTINA)
  api.saveRoutineFull.mockResolvedValue('r-1')
})

async function abrirNueva() {
  render(<RutinaEditorModal routineId={null} socioPreset={null} onClose={vi.fn()} onSaved={vi.fn()} />)
  return screen.findByLabelText('Carga')
}

describe('RutinaEditorModal -- placeholders de Reps/Carga/Descanso', () => {
  it('Carga arranca VACÍA: el ejemplo es placeholder "ej: 20kg (opcional)", nunca un "20kg" a secas', async () => {
    const carga = await abrirNueva()
    expect(carga).toHaveValue('')
    expect(carga).toHaveAttribute('placeholder', 'ej: 20kg (opcional)')
    expect(screen.queryByPlaceholderText('20kg')).toBeNull()
    expect(screen.queryByDisplayValue('20kg')).toBeNull()
  })

  it('los tres placeholders son de ejemplo, en itálica y tenues', async () => {
    await abrirNueva()
    const campos = [
      [screen.getByLabelText('Reps'), 'ej: 10-12 (opcional)'],
      [screen.getByLabelText('Carga'), 'ej: 20kg (opcional)'],
      [screen.getByLabelText('Descanso (s)'), 'ej: 60 (opcional)'],
    ]
    for (const [input, texto] of campos) {
      expect(input).toHaveAttribute('placeholder', texto)
      expect(input.className).toContain('placeholder:italic')
      expect(input.className).toContain('placeholder:text-gray-500/60')
    }
  })

  it('Reps y Descanso de un bloque nuevo siguen arrancando con valores reales (10-12 y 60)', async () => {
    await abrirNueva()
    expect(screen.getByLabelText('Reps')).toHaveValue('10-12')
    expect(screen.getByLabelText('Descanso (s)')).toHaveValue(60)
  })
})

describe('RutinaEditorModal -- vaciar un campo lo manda vacío a guardar (saveRoutineFull lo pasa a null)', () => {
  it('editando una rutina: vaciar Carga, Reps y Descanso manda "" en los tres', async () => {
    render(<RutinaEditorModal routineId="r-1" socioPreset={null} onClose={vi.fn()} onSaved={vi.fn()} />)
    const carga = await screen.findByLabelText('Carga')
    expect(carga).toHaveValue('60kg')

    fireEvent.change(carga, { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Reps'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Descanso (s)'), { target: { value: '' } })

    // vacío de verdad: se ve el placeholder de ejemplo, no un valor
    expect(carga).toHaveValue('')
    expect(carga).toHaveAttribute('placeholder', 'ej: 20kg (opcional)')

    fireEvent.click(screen.getByRole('button', { name: /guardar rutina/i }))
    await waitFor(() => expect(api.saveRoutineFull).toHaveBeenCalled())

    const bloque = api.saveRoutineFull.mock.calls[0][0].days[0].exercises[0]
    expect(bloque.weightSuggestion).toBe('')
    expect(bloque.reps).toBe('')
    expect(bloque.restSeconds).toBe('')
  })

  it('una rutina con carga/reps/descanso en null (llegan como "") se muestra con los campos vacíos y sin warnings', async () => {
    api.fetchRoutineFull.mockResolvedValue({
      ...RUTINA,
      days: [{ ...RUTINA.days[0], exercises: [{ ...RUTINA.days[0].exercises[0], weightSuggestion: '', reps: '', restSeconds: '' }] }],
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<RutinaEditorModal routineId="r-1" socioPreset={null} onClose={vi.fn()} onSaved={vi.fn()} />)
    const carga = await screen.findByLabelText('Carga')

    expect(carga).toHaveValue('')
    expect(screen.getByLabelText('Reps')).toHaveValue('')
    expect(screen.getByLabelText('Descanso (s)')).toHaveValue(null)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
