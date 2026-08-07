import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import PackModal from '../../components/PackModal'

const mockedFrom = supabase.from

const DISCIPLINAS = [
  { id: 'disc-crossfit', name: 'CrossFit', kind: 'credits' },
  { id: 'disc-aparatos', name: 'Aparatos', kind: 'membership' },
]

describe('PackModal -- alta/edición de un pack real de `packs` (precio/créditos que usa Mercado Pago)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('con una disciplina de créditos elegida, muestra el campo "Cantidad de créditos" y no el de días', () => {
    render(<PackModal disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByLabelText('Cantidad de créditos')).toBeInTheDocument()
    expect(screen.queryByLabelText('Días de vigencia')).not.toBeInTheDocument()
  })

  it('al elegir una disciplina de membresía, cambia a "Días de vigencia" en vez de créditos', () => {
    render(<PackModal disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Disciplina'), { target: { value: 'disc-aparatos' } })
    expect(screen.getByLabelText('Días de vigencia')).toBeInTheDocument()
    expect(screen.queryByLabelText('Cantidad de créditos')).not.toBeInTheDocument()
  })

  it('bloquea el submit si el precio es 0', () => {
    render(<PackModal disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Pack 6 clases CrossFit' } })
    fireEvent.change(screen.getByLabelText('Cantidad de créditos'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.getByText('El precio tiene que ser mayor a 0.')).toBeInTheDocument()
    expect(mockedFrom).not.toHaveBeenCalled()
  })

  it('crear un pack nuevo de créditos manda el payload correcto a `packs`', async () => {
    const insertSpy = vi.fn(() => ({
      select: vi.fn().mockResolvedValue({ data: [{ id: 'pack-nuevo' }], error: null }),
    }))
    mockedFrom.mockReturnValue({ insert: insertSpy })

    const onSaved = vi.fn()
    const onClose = vi.fn()
    render(<PackModal disciplinas={DISCIPLINAS} onClose={onClose} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Pack 6 clases CrossFit' } })
    fireEvent.change(screen.getByLabelText('Precio'), { target: { value: '10000' } })
    fireEvent.change(screen.getByLabelText('Cantidad de créditos'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() =>
      expect(insertSpy).toHaveBeenCalledWith({
        name: 'Pack 6 clases CrossFit',
        discipline_id: 'disc-crossfit',
        price: 10000,
        credits: 6,
        duration_days: null,
        is_active: true,
      }),
    )
    expect(onSaved).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('editar un pack de membresía (Aparatos) manda duration_days y credits:null', async () => {
    const packAparatos = {
      id: 'pack-aparatos',
      name: 'Mes libre Aparatos',
      discipline_id: 'disc-aparatos',
      price: 21000,
      credits: null,
      duration_days: 30,
      is_active: true,
    }
    const updateSpy = vi.fn(() => ({
      eq: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [packAparatos], error: null }) })),
    }))
    mockedFrom.mockReturnValue({ update: updateSpy })

    render(<PackModal pack={packAparatos} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Días de vigencia'), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ duration_days: 45, credits: null, discipline_id: 'disc-aparatos' }),
      ),
    )
  })

  it('un nombre duplicado (23505) muestra un mensaje claro en vez del genérico', async () => {
    mockedFrom.mockReturnValue({
      insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: null, error: { code: '23505' } }) })),
    })

    render(<PackModal disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Pack 12 clases CrossFit' } })
    fireEvent.change(screen.getByLabelText('Precio'), { target: { value: '30000' } })
    fireEvent.change(screen.getByLabelText('Cantidad de créditos'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(screen.getByText('Ya existe un pack llamado "Pack 12 clases CrossFit".')).toBeInTheDocument())
  })
})
