import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import InscriptosModal from '../../components/InscriptosModal'

// PARTE A (ticket "click en un inscripto redirige a su ficha") -- el nombre
// solo es clickeable con dni real. Sin dni, "/socios?editar=<dni>" no
// tendría nada que buscar -- mismo criterio de "ausencia de UI" que ya rige
// en el resto del proyecto para socios sin DNI cargado (ver
// creditos-sin-dni.spec.js). La navegación en sí (onAbrirFicha ->
// navigate(`/socios?editar=${dni}`)) vive en Clases.jsx, no acá -- este
// componente solo tiene que disparar el callback con el dni correcto.
const CLASE_BASE = {
  id: 'clase-1',
  disciplina: 'CrossFit',
  diasSemana: [1],
  horaInicio: '18:00',
  horaFin: '19:00',
  profesor: 'Seba',
}

function renderModal(inscriptos) {
  const onAbrirFicha = vi.fn()
  render(
    <InscriptosModal
      open
      clase={{ ...CLASE_BASE, inscriptos }}
      onClose={vi.fn()}
      onMarcarAsistencia={vi.fn()}
      onAgregarSocio={vi.fn()}
      onQuitarInscripto={vi.fn()}
      onAbrirFicha={onAbrirFicha}
    />,
  )
  return { onAbrirFicha }
}

describe('InscriptosModal -- nombre clickeable a la ficha del socio (PARTE A)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('un inscripto CON dni es clickeable y dispara onAbrirFicha con su dni', () => {
    const { onAbrirFicha } = renderModal([
      { id: 'b1', userId: 'u1', nombre: 'Martina Ríos', dni: '30111222', asistio: null },
    ])

    const boton = screen.getByRole('button', { name: 'Martina Ríos' })
    fireEvent.click(boton)
    expect(onAbrirFicha).toHaveBeenCalledWith('30111222')
  })

  it('un inscripto SIN dni queda como texto plano -- no clickeable, sin romper el resto de su fila', () => {
    const { onAbrirFicha } = renderModal([
      { id: 'b2', userId: 'u2', nombre: 'Socio Sin Dni', dni: null, asistio: null },
    ])

    expect(screen.getByText('Socio Sin Dni')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Socio Sin Dni' })).not.toBeInTheDocument()
    // El resto de la fila sigue intacto -- asistencia y "Quitar" no dependen
    // del dni, nunca lo necesitaron.
    expect(screen.getByRole('button', { name: 'Marcar Asistió' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Marcar Ausente' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Quitar de la clase' })).toBeInTheDocument()
    expect(onAbrirFicha).not.toHaveBeenCalled()
  })

  it('con un inscripto de cada tipo en la misma clase, cada uno respeta su propio criterio de forma independiente', () => {
    const { onAbrirFicha } = renderModal([
      { id: 'b1', userId: 'u1', nombre: 'Martina Ríos', dni: '30111222', asistio: null },
      { id: 'b2', userId: 'u2', nombre: 'Socio Sin Dni', dni: null, asistio: null },
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Martina Ríos' }))
    expect(onAbrirFicha).toHaveBeenCalledTimes(1)
    expect(onAbrirFicha).toHaveBeenCalledWith('30111222')
    expect(screen.queryByRole('button', { name: 'Socio Sin Dni' })).not.toBeInTheDocument()
  })
})
