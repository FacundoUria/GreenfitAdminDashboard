import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../utils/fichaSocioPwa', () => ({
  resolverUserIdPorDni: vi.fn(),
  fetchCreditosPorDisciplina: vi.fn(),
}))

vi.mock('../../utils/creditosPwa', () => ({
  resolverDisciplinaId: vi.fn(),
  fijarCreditosDisciplina: vi.fn(),
  ajustarCreditoDisciplina: vi.fn(),
}))

import { resolverUserIdPorDni, fetchCreditosPorDisciplina } from '../../utils/fichaSocioPwa'
import { resolverDisciplinaId, fijarCreditosDisciplina, ajustarCreditoDisciplina } from '../../utils/creditosPwa'
import CreditosEditablesSocio from '../../components/CreditosEditablesSocio'

const SOCIO_CROSSFIT_BOXEO = {
  id: 's1',
  dni: '20333444',
  plan: ['CrossFit', 'Boxeo'],
}

function mapaCreditos(entradas) {
  const mapa = new Map()
  mapa.set('20333444', entradas)
  return mapa
}

function mockearCargaBase({ userId = 'user-1', entradas = [], idsPorDisciplina = {} } = {}) {
  resolverUserIdPorDni.mockResolvedValue(userId)
  fetchCreditosPorDisciplina.mockResolvedValue(mapaCreditos(entradas))
  resolverDisciplinaId.mockImplementation(async (nombre) => idsPorDisciplina[nombre] ?? null)
}

describe('CreditosEditablesSocio (reemplaza a los steppers sueltos de SociosTabla.jsx -- ver ticket "Editar Socio")', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'confirm')
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })

  it('sin disciplinas de créditos en el plan (ej. solo Aparatos), no renderiza nada', () => {
    const { container } = render(<CreditosEditablesSocio socio={{ id: 's2', dni: '1', plan: ['Aparatos'] }} />)
    expect(container.innerHTML).toBe('')
  })

  it('renderiza una fila por disciplina de créditos del plan, con el total real y el próximo vencimiento', async () => {
    mockearCargaBase({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 6,
          lotes: [{ id: 'l1', remainingCredits: 6, expiresAt: '2026-09-23T12:00:00.000Z' }],
        },
        { disciplineId: 'd-boxeo', disciplineName: 'Boxeo', remainingCredits: 0, lotes: [] },
      ],
      idsPorDisciplina: { CrossFit: 'd-crossfit', Boxeo: 'd-boxeo' },
    })

    render(<CreditosEditablesSocio socio={SOCIO_CROSSFIT_BOXEO} />)

    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    expect(screen.getByText('Boxeo')).toBeTruthy()
    expect(screen.getByText('Vence el 23/09/2026')).toBeTruthy()
    expect(screen.getByText('Sin lotes activos')).toBeTruthy()
    expect(screen.getByLabelText('Créditos de CrossFit').value).toBe('6')
    expect(screen.getByLabelText('Créditos de Boxeo').value).toBe('0')
  })

  it('escribir un número distinto y Guardar -- pide confirmación con el texto exacto y, si se confirma, fija el total', async () => {
    mockearCargaBase({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
      idsPorDisciplina: { CrossFit: 'd-crossfit' },
    })
    window.confirm.mockReturnValue(true)
    const onCreditosActualizados = vi.fn()

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: '20333444', plan: ['CrossFit'] }} onCreditosActualizados={onCreditosActualizados} />)

    const input = await screen.findByLabelText('Créditos de CrossFit')
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.click(screen.getByText('Guardar'))

    expect(window.confirm).toHaveBeenCalledWith('¿Confirmás modificar los créditos de CrossFit a 20?')
    await waitFor(() => expect(fijarCreditosDisciplina).toHaveBeenCalledWith('user-1', 'd-crossfit', 20))
    await waitFor(() => expect(onCreditosActualizados).toHaveBeenCalled())
  })

  it('si se cancela la confirmación, NO fija nada', async () => {
    mockearCargaBase({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
      idsPorDisciplina: { CrossFit: 'd-crossfit' },
    })
    window.confirm.mockReturnValue(false)

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: '20333444', plan: ['CrossFit'] }} />)

    const input = await screen.findByLabelText('Créditos de CrossFit')
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.click(screen.getByText('Guardar'))

    expect(window.confirm).toHaveBeenCalled()
    expect(fijarCreditosDisciplina).not.toHaveBeenCalled()
  })

  it('+1 -- ajusta de inmediato, SIN pedir confirmación', async () => {
    mockearCargaBase({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
      idsPorDisciplina: { CrossFit: 'd-crossfit' },
    })
    const onCreditosActualizados = vi.fn()

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: '20333444', plan: ['CrossFit'] }} onCreditosActualizados={onCreditosActualizados} />)

    fireEvent.click(await screen.findByTitle('Sumar 1 crédito a CrossFit'))

    expect(window.confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(ajustarCreditoDisciplina).toHaveBeenCalledWith('user-1', 'd-crossfit', 1))
    await waitFor(() => expect(onCreditosActualizados).toHaveBeenCalled())
  })

  it('-1 -- ajusta de inmediato, SIN pedir confirmación', async () => {
    mockearCargaBase({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
      idsPorDisciplina: { CrossFit: 'd-crossfit' },
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: '20333444', plan: ['CrossFit'] }} />)

    fireEvent.click(await screen.findByTitle('Restar 1 crédito de CrossFit'))

    expect(window.confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(ajustarCreditoDisciplina).toHaveBeenCalledWith('user-1', 'd-crossfit', -1))
  })

  it('disciplina sin id resoluble en el catálogo -- avisa y no llama a ningún RPC', async () => {
    mockearCargaBase({
      entradas: [],
      idsPorDisciplina: {}, // CrossFit no resuelve ningún id
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: '20333444', plan: ['CrossFit'] }} />)

    fireEvent.click(await screen.findByTitle('Sumar 1 crédito a CrossFit'))

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('No se encontró "CrossFit"'))
    expect(ajustarCreditoDisciplina).not.toHaveBeenCalled()
  })

  it('socio sin cuenta PWA todavía (userId null) -- avisa y no llama a ningún RPC', async () => {
    mockearCargaBase({
      userId: null,
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
      idsPorDisciplina: { CrossFit: 'd-crossfit' },
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: '20333444', plan: ['CrossFit'] }} />)

    fireEvent.click(await screen.findByTitle('Sumar 1 crédito a CrossFit'))

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('todavía no tiene cuenta en la app'))
    expect(ajustarCreditoDisciplina).not.toHaveBeenCalled()
  })
})
