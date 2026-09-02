import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
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

// Antes, el Admin no validaba el formato de DNI en ningún lado -- un DNI mal
// tipeado se guardaba sin error visible, y como no matcheaba el mismo patrón
// que usa el trigger handle_socio_dni_upsert() en SQL, el socio quedaba con
// su ficha completa acá pero SIN cuenta de PWA, sin que nadie se enterara.
// Mismo patrón ^\d{6,10}$ que ya usa isValidDni() en la PWA (dni.ts).
describe('NuevoSocioModal -- valida el formato de DNI antes de guardar (mismo patrón que la PWA)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    supabase.from.mockReset()
  })

  function completarCamposObligatorios() {
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Facundo' } })
    fireEvent.change(screen.getByLabelText('Apellido'), { target: { value: 'Test' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'facu@test.com' } })
  }

  it('DNI con letras: bloquea el guardado con un error claro, sin llamar a Supabase', () => {
    render(<NuevoSocioModal onClose={vi.fn()} onSaved={vi.fn()} />)
    completarCamposObligatorios()
    fireEvent.change(screen.getByLabelText('DNI'), { target: { value: '30abc999' } })

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.getByText(/DNI tiene que tener entre 6 y 10 dígitos/)).toBeTruthy()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('DNI de menos de 6 dígitos: bloquea el guardado', () => {
    render(<NuevoSocioModal onClose={vi.fn()} onSaved={vi.fn()} />)
    completarCamposObligatorios()
    fireEvent.change(screen.getByLabelText('DNI'), { target: { value: '123' } })

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.getByText(/DNI tiene que tener entre 6 y 10 dígitos/)).toBeTruthy()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('DNI de más de 10 dígitos: bloquea el guardado', () => {
    render(<NuevoSocioModal onClose={vi.fn()} onSaved={vi.fn()} />)
    completarCamposObligatorios()
    fireEvent.change(screen.getByLabelText('DNI'), { target: { value: '123456789012' } })

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.getByText(/DNI tiene que tener entre 6 y 10 dígitos/)).toBeTruthy()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('DNI válido (7 dígitos) y al menos un plan: no bloquea por el DNI -- sigue de largo hasta guardar en Supabase', () => {
    // 'socios': el alta real. 'profiles': lo consulta esperarCuentaPwa() justo
    // después del insert (espera a que el trigger on_socio_dni_upsert termine
    // de aprovisionar la cuenta de la PWA) -- sin mockear esta segunda tabla
    // también, esa llamada revienta con un TypeError asíncrono no manejado.
    supabase.from.mockImplementation((tabla) => {
      if (tabla === 'socios') {
        return { insert: () => ({ select: () => Promise.resolve({ data: [{ id: 'nuevo-1' }], error: null }) }) }
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }
    })
    render(<NuevoSocioModal onClose={vi.fn()} onSaved={vi.fn()} />)
    completarCamposObligatorios()
    fireEvent.change(screen.getByLabelText('DNI'), { target: { value: '3099988' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'CrossFit' }))

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.queryByText(/DNI tiene que tener entre 6 y 10 dígitos/)).toBeNull()
    expect(supabase.from).toHaveBeenCalledWith('socios')
  })
})
