import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// Historial de rutinas (F1) -- el editor:
// * "Guardar cambios" manda los ids de días y ejercicios: el servidor actualiza en el
//   lugar (los tildes de hoy del socio sobreviven), ya no borra y vuelve a crear.
// * "Guardar como rutina nueva" (solo editando la rutina de un socio): pide confirmación
//   y manda comoNueva; la actual pasa a su historial tal como estaba.
// * Plantillas y rutinas nuevas: un solo botón "Guardar rutina", como siempre.
// * Ya no está el checkbox "Guardar como plantilla base": sin socio = plantilla.

vi.mock('../../utils/routinesApi', () => ({
  CODIGO_BORRARIA_REGISTRO: 'GFR04',
  fetchExercises: vi.fn(),
  fetchRoutineFull: vi.fn(),
  saveRoutineFull: vi.fn(),
}))

import * as api from '../../utils/routinesApi'
import RutinaEditorModal from '../../components/rutinas/RutinaEditorModal'

const SOCIO = { id: 'u-1', full_name: 'Facundo Uria', dni: '44537978' }
const RUTINA = {
  id: 'r-1',
  title: 'Fuerza',
  notes: '',
  isTemplate: false,
  days: [
    {
      id: 'd-1',
      title: 'Día 1',
      exercises: [
        { id: 're-1', exerciseId: 'ex-1', exerciseName: 'Sentadilla', muscleGroup: 'Piernas', exerciseDescription: '', exerciseVideoUrl: '', sets: 4, reps: '8', restSeconds: 90, weightSuggestion: '60kg', notes: '' },
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

describe('RutinaEditorModal -- guardar sin perder el historial', () => {
  it('rutina de un socio: "Guardar cambios" manda ids de días y ejercicios, sin comoNueva', async () => {
    const onSaved = vi.fn()
    render(<RutinaEditorModal routineId="r-1" socioPreset={SOCIO} onClose={vi.fn()} onSaved={onSaved} />)
    fireEvent.change(await screen.findByLabelText('Reps'), { target: { value: '10' } })

    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => expect(api.saveRoutineFull).toHaveBeenCalledTimes(1))
    const args = api.saveRoutineFull.mock.calls[0][0]
    expect(args).toMatchObject({ id: 'r-1', userId: 'u-1', comoNueva: false })
    expect(args.days[0].id).toBe('d-1')
    expect(args.days[0].exercises[0]).toMatchObject({ id: 're-1', exerciseId: 'ex-1', reps: '10' })
    expect(args).not.toHaveProperty('coachName')
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('"Guardar como rutina nueva": confirma y manda comoNueva', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<RutinaEditorModal routineId="r-1" socioPreset={SOCIO} onClose={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar como rutina nueva' }))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('La rutina actual pasa a su historial tal como estaba'))
    await waitFor(() => expect(api.saveRoutineFull).toHaveBeenCalledWith(expect.objectContaining({ id: 'r-1', comoNueva: true })))
    confirmSpy.mockRestore()
  })

  it('"Guardar como rutina nueva" cancelado: no guarda', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<RutinaEditorModal routineId="r-1" socioPreset={SOCIO} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar como rutina nueva' }))
    expect(api.saveRoutineFull).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('plantilla (sin socio): un solo botón "Guardar rutina", sin "como nueva" y sin el checkbox de plantilla', async () => {
    render(<RutinaEditorModal routineId="r-1" socioPreset={null} onClose={vi.fn()} onSaved={vi.fn()} />)
    await screen.findByLabelText('Reps')
    expect(screen.getByRole('button', { name: 'Guardar rutina' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Guardar como rutina nueva' })).toBeNull()
    expect(screen.queryByText(/Guardar como plantilla base/)).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('rutina NUEVA para un socio: "Guardar rutina", sin "como nueva"', async () => {
    render(<RutinaEditorModal routineId={null} socioPreset={SOCIO} onClose={vi.fn()} onSaved={vi.fn()} />)
    await screen.findByLabelText('Reps')
    expect(screen.getByRole('heading', { name: 'Nueva rutina para Facundo Uria' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Guardar rutina' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Guardar como rutina nueva' })).toBeNull()
  })

  it('GFR04 (borraría tildes del socio): muestra el mensaje del servidor y ofrece "Guardar como rutina nueva" ahí mismo', async () => {
    const MENSAJE = 'Este cambio borraría el registro de la alumna. Usá «Guardar como rutina nueva».'
    api.saveRoutineFull
      .mockRejectedValueOnce(Object.assign(new Error(MENSAJE), { code: 'GFR04' }))
      .mockResolvedValueOnce('r-2')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onSaved = vi.fn()
    render(<RutinaEditorModal routineId="r-1" socioPreset={SOCIO} onClose={vi.fn()} onSaved={onSaved} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar cambios' }))

    const aviso = await screen.findByRole('alert')
    expect(within(aviso).getByText(MENSAJE)).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()

    fireEvent.click(within(aviso).getByRole('button', { name: 'Guardar como rutina nueva' }))

    await waitFor(() => expect(api.saveRoutineFull).toHaveBeenCalledTimes(2))
    expect(api.saveRoutineFull.mock.calls[0][0]).toMatchObject({ comoNueva: false })
    expect(api.saveRoutineFull.mock.calls[1][0]).toMatchObject({ id: 'r-1', comoNueva: true })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    confirmSpy.mockRestore()
  })

  it('cualquier otro error se muestra sin ofrecer "Guardar como rutina nueva" en el aviso', async () => {
    api.saveRoutineFull.mockRejectedValue(Object.assign(new Error('timeout'), { code: undefined }))
    render(<RutinaEditorModal routineId="r-1" socioPreset={SOCIO} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar cambios' }))
    expect(await screen.findByText('timeout')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('si el servidor la rechaza (rutina del historial), muestra su mensaje y no cierra', async () => {
    api.saveRoutineFull.mockRejectedValue(
      Object.assign(new Error('Esta rutina es del historial del socio: es de solo lectura.'), { code: 'GFR01' }),
    )
    const onSaved = vi.fn()
    render(<RutinaEditorModal routineId="r-1" socioPreset={SOCIO} onClose={vi.fn()} onSaved={onSaved} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar cambios' }))
    expect(await screen.findByText('Esta rutina es del historial del socio: es de solo lectura.')).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })
})
