import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import NuevoSocioModal from '../../components/NuevoSocioModal'

// BUG CRÍTICO (2026-08-07): el formulario de "Nuevo Socio" arrancaba con
// 'Pase Libre' YA TILDADO (PLANES_DISPONIBLES[0]) -- si el staff cargaba un
// socio de Kickstrike/CrossFit sin destildarlo a mano, el socio quedaba con
// un plan extra que nunca pidió ('Pase Libre'), que además termina
// sincronizando un balance de Aparatos en la PWA (ver el comentario de
// formInicial() en NuevoSocioModal.jsx). Ninguna disciplina debe empezar
// pre-seleccionada -- el staff elige cada actividad real a mano.
describe('NuevoSocioModal -- ningún plan arranca pre-tildado (fix del bug de disciplinas fantasma)', () => {
  it('alta nueva: todos los checkboxes de Planes/Actividades arrancan sin marcar', () => {
    render(<NuevoSocioModal onClose={vi.fn()} onSaved={vi.fn()} />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBeGreaterThan(0)
    expect(checkboxes.every((cb) => !cb.checked)).toBe(true)
  })

  it('editar un socio: solo quedan tildados los planes que el socio realmente tiene, ninguno de más', () => {
    const socioKickstrike = {
      id: 's1',
      nombre: 'Bruno',
      apellido: 'Álvarez',
      dni: '30999888',
      email: 'bruno@mail.com',
      telefono: '',
      plan: ['Kickstrike'],
      fechaVencimiento: null,
    }
    render(<NuevoSocioModal socio={socioKickstrike} onClose={vi.fn()} onSaved={vi.fn()} />)

    const checkboxKickstrike = screen.getByRole('checkbox', { name: 'Kickstrike' })
    expect(checkboxKickstrike.checked).toBe(true)

    // Ninguna otra actividad -- en particular, "Aparatos" y
    // "Pase Libre" (las dos etiquetas de vencimiento) tienen que quedar
    // SIN tildar para un socio que solo tiene Kickstrike.
    const otrosCheckboxes = screen.getAllByRole('checkbox').filter((cb) => cb !== checkboxKickstrike)
    expect(otrosCheckboxes.every((cb) => !cb.checked)).toBe(true)
  })

  it('editar un socio sin ningún plan guardado (dato legacy vacío) tampoco pre-tilda nada por defecto', () => {
    const socioSinPlan = {
      id: 's2',
      nombre: 'Legacy',
      apellido: 'Viejo',
      dni: '30000111',
      email: '',
      telefono: '',
      plan: [],
      fechaVencimiento: null,
    }
    render(<NuevoSocioModal socio={socioSinPlan} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getAllByRole('checkbox').every((cb) => !cb.checked)).toBe(true)
  })
})
