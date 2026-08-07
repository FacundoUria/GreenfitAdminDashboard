import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import DisciplinaModal from '../../components/DisciplinaModal'

const mockedFrom = supabase.from

function makeChain(result) {
  const chain = {}
  const self = () => chain
  ;['select', 'eq', 'order', 'update', 'insert'].forEach((metodo) => {
    chain[metodo] = vi.fn(self)
  })
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

// Switch "Mostrar en la Agenda de reservas de la PWA" (checklist punto 2) --
// desactivarlo es para pases libres como Aparatos, que no tienen turnos
// reales que reservar.
describe('DisciplinaModal -- switch de visibilidad en la Agenda (show_in_agenda)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'classes') return makeChain({ data: [], error: null })
      return makeChain({ data: [{ id: 'disc-1' }], error: null })
    })
  })

  it('nueva disciplina: el checkbox arranca tildado (visible en la Agenda por defecto)', () => {
    render(<DisciplinaModal onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: /Mostrar en la Agenda de reservas de la PWA/ }).checked).toBe(true)
  })

  it('editar una disciplina con show_in_agenda=false: el checkbox arranca destildado', () => {
    const disciplina = { id: 'disc-1', name: 'Aparatos', kind: 'membership', is_active: true, show_in_agenda: false }
    render(<DisciplinaModal disciplina={disciplina} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: /Mostrar en la Agenda de reservas de la PWA/ }).checked).toBe(false)
  })

  it('destildar el switch y guardar manda show_in_agenda:false en el payload del update', async () => {
    const disciplina = { id: 'disc-1', name: 'Aparatos', kind: 'membership', is_active: true, show_in_agenda: true }
    const updateSpy = vi.fn(() => ({ eq: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [{ id: 'disc-1' }], error: null }) })) }))
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'classes') return makeChain({ data: [], error: null })
      if (tabla === 'disciplines') return { update: updateSpy }
      throw new Error(`tabla inesperada: ${tabla}`)
    })

    render(<DisciplinaModal disciplina={disciplina} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Mostrar en la Agenda de reservas de la PWA/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ show_in_agenda: false })))
  })
})
