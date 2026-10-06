import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// Biblioteca de ejercicios -- borrar ya no cascadea: un ejercicio en uso (en
// alguna rutina o plantilla, o con pesos de algún socio) no se puede borrar
// (FK RESTRICT en la base) y la pantalla lo dice ANTES, con los conteos de
// admin_uso_ejercicios. Antes un borrado lo sacaba de todas las rutinas de
// todos los socios, con sus pesos, detrás de un confirm que decía otra cosa.

vi.mock('../../utils/routinesApi', async () => {
  const real = await vi.importActual('../../utils/routinesApi')
  return {
    CODIGO_EJERCICIO_EN_USO: real.CODIGO_EJERCICIO_EN_USO,
    fetchExercises: vi.fn(),
    fetchUsoEjercicios: vi.fn(),
    saveExercise: vi.fn(),
    deleteExercise: vi.fn(),
  }
})

import * as api from '../../utils/routinesApi'
import EjerciciosLibreriaModal from '../../components/rutinas/EjerciciosLibreriaModal'

const EJERCICIOS = [
  { id: 'ex-peso', name: 'Peso muerto', muscle_group: 'Espalda', description: null, video_url: null },
  { id: 'ex-remo', name: 'Remo', muscle_group: 'Espalda', description: null, video_url: null },
  { id: 'ex-libre', name: 'Plancha lateral', muscle_group: 'Core', description: null, video_url: null },
]

const USO = new Map([
  ['ex-peso', { rutinasAsignadas: 3, plantillas: 1, socios: 2, pesos: 0 }],
  ['ex-remo', { rutinasAsignadas: 0, plantillas: 0, socios: 0, pesos: 4 }],
  ['ex-libre', { rutinasAsignadas: 0, plantillas: 0, socios: 0, pesos: 0 }],
])
const SIN_USO = { rutinasAsignadas: 0, plantillas: 0, socios: 0, pesos: 0 }

let confirmSpy

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchExercises.mockResolvedValue(EJERCICIOS)
  api.fetchUsoEjercicios.mockImplementation(async (ids) =>
    ids ? new Map(ids.map((id) => [id, USO.get(id)]).filter(([, u]) => u)) : USO,
  )
  api.deleteExercise.mockResolvedValue()
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  confirmSpy.mockRestore()
})

async function abrir() {
  render(<EjerciciosLibreriaModal onClose={vi.fn()} />)
  await screen.findByText('Peso muerto')
}

function fila(nombre) {
  return screen.getByText(nombre).closest('li')
}

describe('Biblioteca -- qué se ofrece borrar', () => {
  it('un ejercicio en rutinas/plantillas NO tiene botón de borrar y muestra dónde se usa', async () => {
    await abrir()
    expect(within(fila('Peso muerto')).getByText('En uso: 3 rutinas, 1 plantilla')).toBeInTheDocument()
    expect(screen.queryByLabelText('Eliminar Peso muerto')).toBeNull()
  })

  it('un ejercicio con solo pesos de socios también cuenta como en uso', async () => {
    await abrir()
    expect(within(fila('Remo')).getByText('En uso: pesos de 4 socios')).toBeInTheDocument()
    expect(screen.queryByLabelText('Eliminar Remo')).toBeNull()
  })

  it('un ejercicio sin uso sí tiene botón de borrar', async () => {
    await abrir()
    expect(screen.getByLabelText('Eliminar Plancha lateral')).toBeInTheDocument()
  })

  it('si no se pudo saber dónde se usa cada uno, no se ofrece borrar NINGUNO y se avisa', async () => {
    api.fetchUsoEjercicios.mockRejectedValue(new Error('Esta acción requiere permisos de administrador.'))
    await abrir()

    expect(screen.getByRole('alert')).toHaveTextContent('no se puede borrar ninguno')
    expect(screen.getByRole('alert')).toHaveTextContent('requiere permisos de administrador')
    expect(screen.queryByLabelText(/^Eliminar /)).toBeNull()
    // La lista se ve igual.
    expect(screen.getByText('Plancha lateral')).toBeInTheDocument()
  })
})

describe('Biblioteca -- borrar un ejercicio sin uso', () => {
  it('pide confirmación con un texto que dice la verdad, y al aceptar lo borra y recarga', async () => {
    await abrir()
    fireEvent.click(screen.getByLabelText('Eliminar Plancha lateral'))

    await waitFor(() => expect(api.deleteExercise).toHaveBeenCalledWith('ex-libre'))
    expect(confirmSpy).toHaveBeenCalledWith(
      '¿Borrar "Plancha lateral" de la biblioteca? No lo usa ninguna rutina ni plantilla, y no tiene pesos cargados. No se puede deshacer.',
    )
    // Antes de confirmar se volvió a preguntar dónde se usa (la lista pudo quedar vieja).
    expect(api.fetchUsoEjercicios).toHaveBeenCalledWith(['ex-libre'])
    expect(await screen.findByRole('status')).toHaveTextContent('Se borró "Plancha lateral".')
    expect(api.fetchExercises).toHaveBeenCalledTimes(2)
  })

  it('cancelar la confirmación no borra nada', async () => {
    confirmSpy.mockReturnValue(false)
    await abrir()
    fireEvent.click(screen.getByLabelText('Eliminar Plancha lateral'))

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(api.deleteExercise).not.toHaveBeenCalled()
  })

  it('si al momento de borrar ya está en uso (la lista estaba vieja): no pregunta, no borra y dice por qué', async () => {
    await abrir()
    api.fetchUsoEjercicios.mockResolvedValueOnce(
      new Map([['ex-libre', { ...SIN_USO, rutinasAsignadas: 1, socios: 1 }]]),
    )
    fireEvent.click(screen.getByLabelText('Eliminar Plancha lateral'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"Plancha lateral": No se puede borrar: lo usa 1 rutina de 1 socio.',
    )
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(api.deleteExercise).not.toHaveBeenCalled()
  })

  it('si el chequeo previo falla, no borra a ciegas y avisa', async () => {
    await abrir()
    api.fetchUsoEjercicios.mockRejectedValueOnce(new Error('sin conexión'))
    fireEvent.click(screen.getByLabelText('Eliminar Plancha lateral'))

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo verificar si "Plancha lateral" está en uso')
    expect(api.deleteExercise).not.toHaveBeenCalled()
  })

  it('si la base lo rechaza igual con 23503 (se empezó a usar entre medio), avisa claro y recarga', async () => {
    await abrir()
    const err = new Error('update or delete on table "exercises" violates foreign key constraint')
    err.code = '23503'
    api.deleteExercise.mockRejectedValueOnce(err)
    fireEvent.click(screen.getByLabelText('Eliminar Plancha lateral'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se puede borrar "Plancha lateral": se empezó a usar mientras tanto. Actualizamos la lista.',
    )
    expect(screen.getByRole('alert')).not.toHaveTextContent('foreign key')
    await waitFor(() => expect(api.fetchExercises).toHaveBeenCalledTimes(2))
  })

  it('cualquier otro error al borrar se muestra con su mensaje (nunca en silencio)', async () => {
    await abrir()
    api.deleteExercise.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: '42501' }))
    fireEvent.click(screen.getByLabelText('Eliminar Plancha lateral'))

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo borrar "Plancha lateral": permission denied')
  })
})
