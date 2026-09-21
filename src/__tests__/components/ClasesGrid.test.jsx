import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ClasesGrid from '../../components/ClasesGrid'

// Ticket "cancelar clase puntual" -- ANTES "Cancelar" borraba la plantilla
// recurrente entera (DELETE sobre classes). Ahora cancela la OCURRENCIA de
// un día puntual (admin_cancelar_clase_dia) -- una clase ya cancelada para
// el día que se está viendo se muestra con un badge "Cancelada este día" y
// el botón "Cancelar" queda deshabilitado (no se puede cancelar dos veces),
// sin ocultar la tarjeta (Seba necesita seguir viéndola).
const CLASE_BASE = {
  id: 'clase-1',
  disciplina: 'CrossFit',
  profesor: 'Seba',
  horaInicio: '18:00',
  horaFin: '19:00',
  cupoMaximo: 10,
  inscriptos: [],
}

const HANDLERS = {
  onVerInscriptos: vi.fn(),
  onEditar: vi.fn(),
  onCancelar: vi.fn(),
}

describe('ClasesGrid -- "Cancelada este día" (cancelación puntual, no borra la clase)', () => {
  it('sin cancelación para este día: sin badge, botón "Cancelar" habilitado y funcional', () => {
    render(<ClasesGrid clases={[CLASE_BASE]} {...HANDLERS} />)

    expect(screen.queryByText('Cancelada este día')).toBeNull()
    const boton = screen.getByRole('button', { name: 'Cancelar clase' })
    expect(boton).not.toBeDisabled()
  })

  it('con cancelación para este día (canceladasIds): muestra el badge y deshabilita "Cancelar"', () => {
    const onCancelar = vi.fn()
    render(
      <ClasesGrid
        clases={[CLASE_BASE]}
        canceladasIds={new Set(['clase-1'])}
        {...HANDLERS}
        onCancelar={onCancelar}
      />,
    )

    expect(screen.getByText('Cancelada este día')).toBeTruthy()
    const boton = screen.getByRole('button', { name: 'Cancelar clase' })
    expect(boton).toBeDisabled()
  })

  it('canceladasIds es por (clase, día): otra clase sin cancelar en la misma grilla no se ve afectada', () => {
    const OTRA_CLASE = { ...CLASE_BASE, id: 'clase-2', disciplina: 'Boxeo' }
    render(
      <ClasesGrid clases={[CLASE_BASE, OTRA_CLASE]} canceladasIds={new Set(['clase-1'])} {...HANDLERS} />,
    )

    expect(screen.getByText('Cancelada este día')).toBeTruthy() // solo una vez -- clase-1
    const botones = screen.getAllByRole('button', { name: 'Cancelar clase' })
    expect(botones[0]).toBeDisabled() // CrossFit (clase-1) -- cancelada
    expect(botones[1]).not.toBeDisabled() // Boxeo (clase-2) -- intacta
  })
})
