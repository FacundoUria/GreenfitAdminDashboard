import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import InscriptosModal from '../../components/InscriptosModal'

// Encabezado del modal: una clase de una sola vez dice su fecha, no "Miércoles"
// (que se lee como "todos los miércoles").
function renderModal(clase) {
  render(
    <InscriptosModal
      open
      clase={{ id: 'c1', disciplina: 'Especial', horaInicio: '19:00', horaFin: '20:00', profesor: 'Seba', inscriptos: [], ...clase }}
      onClose={vi.fn()}
      onMarcarAsistencia={vi.fn()}
      onAgregarSocio={vi.fn()}
      onQuitarInscripto={vi.fn()}
      onAbrirFicha={vi.fn()}
    />,
  )
}

describe('InscriptosModal -- clases de una sola vez', () => {
  it('una de una sola vez muestra "Una sola vez" y su fecha', () => {
    renderModal({ diasSemana: [3], fechaUnica: '2026-11-04' })
    expect(screen.getByText(/Una sola vez · Miércoles 4 de noviembre · 19:00 - 20:00 · Prof\. Seba/)).toBeTruthy()
  })

  it('una semanal sigue mostrando sus días', () => {
    renderModal({ diasSemana: [1, 3], fechaUnica: null })
    expect(screen.getByText(/Lunes, Miércoles · 19:00 - 20:00/)).toBeTruthy()
    expect(screen.queryByText(/Una sola vez/)).toBeNull()
  })
})
