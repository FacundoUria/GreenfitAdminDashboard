import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Rutinas > Asignación a Socios (historial de rutinas F1): asignar una plantilla ya no
// pisa nada -- se hace en el servidor (admin_asignar_rutina) y la rutina actual pasa al
// historial. Si el socio ya tiene una, se pide confirmación nombrándola.

vi.mock('../../utils/routinesApi', () => ({
  asignarRutina: vi.fn(),
  fetchRoutinesList: vi.fn(),
  searchSocios: vi.fn(),
}))

// RutinasDelSocio tiene sus propios tests: acá se simula que avisa cuál es la vigente.
let vigenteSimulada = null
vi.mock('../../components/rutinas/RutinasDelSocio', async () => {
  const { useEffect } = await import('react')
  return {
    default: function RutinasDelSocioFalso({ onCargado, recargar }) {
      useEffect(() => {
        onCargado?.(vigenteSimulada)
      }, [onCargado, recargar])
      return <div>{`historial (recarga ${recargar})`}</div>
    },
  }
})
vi.mock('../../components/rutinas/RutinaEditorModal', () => ({ default: () => null }))

import * as api from '../../utils/routinesApi'
import AsignacionSocios from '../../components/rutinas/AsignacionSocios'

const SOCIO = { id: 'u-1', full_name: 'Facundo Uria', dni: '44537978' }

async function elegirSocio() {
  render(<AsignacionSocios />)
  fireEvent.change(screen.getByPlaceholderText('Buscar socio por nombre o DNI...'), { target: { value: 'Facu' } })
  fireEvent.click(await screen.findByText('Facundo Uria', {}, { timeout: 2000 }))
  await screen.findByText('historial (recarga 0)')
}

beforeEach(() => {
  vi.clearAllMocks()
  vigenteSimulada = null
  api.fetchRoutinesList.mockResolvedValue([{ id: 'p-1', title: 'Adaptación 4 días' }])
  api.searchSocios.mockResolvedValue([SOCIO])
  api.asignarRutina.mockResolvedValue('r-nueva')
})

describe('AsignacionSocios -- asignar desde plantilla', () => {
  it('con rutina vigente: confirma nombrando la actual, asigna en el servidor y recarga el historial', async () => {
    vigenteSimulada = { id: 'r-1', title: 'Fuerza' }
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await elegirSocio()

    fireEvent.change(screen.getByRole('combobox', { name: 'Asignar desde plantilla' }), { target: { value: 'p-1' } })

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Su rutina actual ("Fuerza") pasa a su historial'))
    await waitFor(() => expect(api.asignarRutina).toHaveBeenCalledWith('u-1', 'p-1'))
    expect(await screen.findByText('historial (recarga 1)')).toBeTruthy()
    confirmSpy.mockRestore()
  })

  it('con rutina vigente y confirmación cancelada: no asigna', async () => {
    vigenteSimulada = { id: 'r-1', title: 'Fuerza' }
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await elegirSocio()
    fireEvent.change(screen.getByRole('combobox', { name: 'Asignar desde plantilla' }), { target: { value: 'p-1' } })
    expect(api.asignarRutina).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('sin rutina vigente: asigna sin preguntar', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    await elegirSocio()
    fireEvent.change(screen.getByRole('combobox', { name: 'Asignar desde plantilla' }), { target: { value: 'p-1' } })
    await waitFor(() => expect(api.asignarRutina).toHaveBeenCalledWith('u-1', 'p-1'))
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('si el servidor rechaza la asignación, muestra el error', async () => {
    api.asignarRutina.mockRejectedValue(new Error('Esa rutina no tiene ejercicios: no se asigna vacía.'))
    await elegirSocio()
    fireEvent.change(screen.getByRole('combobox', { name: 'Asignar desde plantilla' }), { target: { value: 'p-1' } })
    expect(await screen.findByText('Esa rutina no tiene ejercicios: no se asigna vacía.')).toBeTruthy()
  })
})
