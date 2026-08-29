import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import PackModal from '../../components/PackModal'

const mockedFrom = supabase.from

const DISCIPLINAS = [
  { id: 'disc-crossfit', name: 'CrossFit', kind: 'credits' },
  { id: 'disc-boxeo', name: 'Boxeo', kind: 'credits' },
  { id: 'disc-aparatos', name: 'Aparatos', kind: 'membership' },
]

describe('PackModal -- alta/edición de un pack/combo real de `packs` (precio/créditos que usa Mercado Pago)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('arranca sin ninguna fila de créditos y sin el campo de Días de Vigencia (Aparatos apagado por defecto)', () => {
    render(<PackModal pack={null} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.queryByLabelText(/Disciplina 1/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Días de Vigencia')).not.toBeInTheDocument()
  })

  it('"Agregar Disciplina" agrega una fila de disciplina + créditos -- Aparatos no aparece en el selector (se maneja con el switch)', () => {
    render(<PackModal pack={null} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agregar Disciplina' }))

    const selectorFila = screen.getByLabelText('Disciplina 1')
    expect(selectorFila).toBeInTheDocument()
    expect(within(selectorFila).queryByText('Aparatos')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Créditos 1')).toBeInTheDocument()
  })

  it('tildar "¿Incluye Aparatos?" muestra Días de Vigencia con los atajos de meses', () => {
    render(<PackModal pack={null} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('¿Incluye Aparatos?'))

    expect(screen.getByLabelText('Días de Vigencia')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '2 Meses (60 días)' }))
    expect(screen.getByLabelText('Días de Vigencia')).toHaveValue(60)
  })

  it('bloquea el submit si el precio es 0', () => {
    render(<PackModal pack={null} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Nombre del Plan/Combo'), { target: { value: 'Combo 8+8' } })
    fireEvent.click(screen.getByLabelText('¿Incluye Aparatos?'))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.getByText('El precio tiene que ser mayor a 0.')).toBeInTheDocument()
    expect(mockedFrom).not.toHaveBeenCalled()
  })

  it('bloquea el submit si no hay ninguna disciplina de créditos NI Aparatos (combo vacío)', () => {
    render(<PackModal pack={null} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Nombre del Plan/Combo'), { target: { value: 'Pack vacío' } })
    fireEvent.change(screen.getByLabelText('Precio ($)'), { target: { value: '10000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.getByText('El combo tiene que incluir al menos una disciplina de créditos o Aparatos.')).toBeInTheDocument()
    expect(mockedFrom).not.toHaveBeenCalled()
  })

  it('crear un combo real (Boxeo + CrossFit) manda el payload EXACTO con las dos disciplinas en `creditos`', async () => {
    const insertSpy = vi.fn(() => ({
      select: vi.fn().mockResolvedValue({ data: [{ id: 'pack-combo-8-8' }], error: null }),
    }))
    mockedFrom.mockReturnValue({ insert: insertSpy })

    const onSaved = vi.fn()
    const onClose = vi.fn()
    render(<PackModal pack={null} disciplinas={DISCIPLINAS} onClose={onClose} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText('Nombre del Plan/Combo'), { target: { value: 'Combo 8+8' } })
    fireEvent.change(screen.getByLabelText('Precio ($)'), { target: { value: '55000' } })

    fireEvent.click(screen.getByRole('button', { name: 'Agregar Disciplina' }))
    fireEvent.change(screen.getByLabelText('Disciplina 1'), { target: { value: 'disc-boxeo' } })
    fireEvent.change(screen.getByLabelText('Créditos 1'), { target: { value: '8' } })

    fireEvent.click(screen.getByRole('button', { name: 'Agregar Disciplina' }))
    fireEvent.change(screen.getByLabelText('Disciplina 2'), { target: { value: 'disc-crossfit' } })
    fireEvent.change(screen.getByLabelText('Créditos 2'), { target: { value: '8' } })

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() =>
      expect(insertSpy).toHaveBeenCalledWith({
        name: 'Combo 8+8',
        price: 55000,
        incluye_aparatos: false,
        dias_vigencia: null,
        creditos: [
          { discipline_id: 'disc-boxeo', credits: 8 },
          { discipline_id: 'disc-crossfit', credits: 8 },
        ],
        is_active: true,
      }),
    )
    expect(onSaved).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('crear un pase de Aparatos puro (sin créditos) manda creditos:[] e incluye_aparatos:true con los días elegidos', async () => {
    const insertSpy = vi.fn(() => ({
      select: vi.fn().mockResolvedValue({ data: [{ id: 'pack-aparatos' }], error: null }),
    }))
    mockedFrom.mockReturnValue({ insert: insertSpy })

    render(<PackModal pack={null} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Nombre del Plan/Combo'), { target: { value: 'Pase 2 Meses Aparatos' } })
    fireEvent.change(screen.getByLabelText('Precio ($)'), { target: { value: '70000' } })
    fireEvent.click(screen.getByLabelText('¿Incluye Aparatos?'))
    fireEvent.click(screen.getByRole('button', { name: '2 Meses (60 días)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() =>
      expect(insertSpy).toHaveBeenCalledWith({
        name: 'Pase 2 Meses Aparatos',
        price: 70000,
        incluye_aparatos: true,
        dias_vigencia: 60,
        creditos: [],
        is_active: true,
      }),
    )
  })

  it('un combo con Aparatos + créditos manda las dos cosas a la vez', async () => {
    const insertSpy = vi.fn(() => ({
      select: vi.fn().mockResolvedValue({ data: [{ id: 'pack-combo' }], error: null }),
    }))
    mockedFrom.mockReturnValue({ insert: insertSpy })

    render(<PackModal pack={null} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Nombre del Plan/Combo'), { target: { value: 'Aparatos + 12 créditos CrossFit' } })
    fireEvent.change(screen.getByLabelText('Precio ($)'), { target: { value: '90000' } })
    fireEvent.click(screen.getByLabelText('¿Incluye Aparatos?'))
    fireEvent.click(screen.getByRole('button', { name: '1 Mes (30 días)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Agregar Disciplina' }))
    fireEvent.change(screen.getByLabelText('Disciplina 1'), { target: { value: 'disc-crossfit' } })
    fireEvent.change(screen.getByLabelText('Créditos 1'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() =>
      expect(insertSpy).toHaveBeenCalledWith({
        name: 'Aparatos + 12 créditos CrossFit',
        price: 90000,
        incluye_aparatos: true,
        dias_vigencia: 30,
        creditos: [{ discipline_id: 'disc-crossfit', credits: 12 }],
        is_active: true,
      }),
    )
  })

  it('no permite repetir la misma disciplina en dos filas', () => {
    render(<PackModal pack={null} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Nombre del Plan/Combo'), { target: { value: 'Combo raro' } })
    fireEvent.change(screen.getByLabelText('Precio ($)'), { target: { value: '10000' } })

    fireEvent.click(screen.getByRole('button', { name: 'Agregar Disciplina' }))
    fireEvent.change(screen.getByLabelText('Disciplina 1'), { target: { value: 'disc-crossfit' } })
    fireEvent.change(screen.getByLabelText('Créditos 1'), { target: { value: '4' } })

    fireEvent.click(screen.getByRole('button', { name: 'Agregar Disciplina' }))
    fireEvent.change(screen.getByLabelText('Disciplina 2'), { target: { value: 'disc-crossfit' } })
    fireEvent.change(screen.getByLabelText('Créditos 2'), { target: { value: '4' } })

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(screen.getByText('No podés repetir la misma disciplina en dos filas -- sumá los créditos en una sola.')).toBeInTheDocument()
    expect(mockedFrom).not.toHaveBeenCalled()
  })

  it('"Quitar disciplina" elimina esa fila puntual', () => {
    render(<PackModal pack={null} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agregar Disciplina' }))
    fireEvent.click(screen.getByRole('button', { name: 'Agregar Disciplina' }))
    expect(screen.getByLabelText('Disciplina 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Quitar disciplina 2' }))
    expect(screen.queryByLabelText('Disciplina 2')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Disciplina 1')).toBeInTheDocument()
  })

  it('editar un combo existente precarga sus filas de créditos y el switch/días de Aparatos', () => {
    const comboExistente = {
      id: 'pack-existente',
      name: 'Aparatos + 12 créditos CrossFit',
      price: 90000,
      incluye_aparatos: true,
      dias_vigencia: 30,
      creditos: [{ discipline_id: 'disc-crossfit', credits: 12 }],
      is_active: true,
    }
    render(<PackModal pack={comboExistente} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)

    expect(screen.getByLabelText('Nombre del Plan/Combo')).toHaveValue('Aparatos + 12 créditos CrossFit')
    expect(screen.getByLabelText('¿Incluye Aparatos?')).toBeChecked()
    expect(screen.getByLabelText('Días de Vigencia')).toHaveValue(30)
    expect(screen.getByLabelText('Disciplina 1')).toHaveValue('disc-crossfit')
    expect(screen.getByLabelText('Créditos 1')).toHaveValue(12)
  })

  it('un nombre duplicado (23505) muestra un mensaje claro en vez del genérico', async () => {
    mockedFrom.mockReturnValue({
      insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: null, error: { code: '23505' } }) })),
    })

    render(<PackModal pack={null} disciplinas={DISCIPLINAS} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Nombre del Plan/Combo'), { target: { value: 'Pack 12 clases CrossFit' } })
    fireEvent.change(screen.getByLabelText('Precio ($)'), { target: { value: '30000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agregar Disciplina' }))
    fireEvent.change(screen.getByLabelText('Disciplina 1'), { target: { value: 'disc-crossfit' } })
    fireEvent.change(screen.getByLabelText('Créditos 1'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(screen.getByText('Ya existe un pack llamado "Pack 12 clases CrossFit".')).toBeInTheDocument())
  })
})
