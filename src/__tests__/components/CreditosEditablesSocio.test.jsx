import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../utils/fichaSocioPwa', () => ({
  resolverUserIdPorDni: vi.fn(),
  fetchCreditosPorDisciplina: vi.fn(),
}))

vi.mock('../../utils/creditosPwa', () => ({
  fijarCreditosDisciplina: vi.fn(),
  ajustarCreditoDisciplina: vi.fn(),
}))

import { resolverUserIdPorDni, fetchCreditosPorDisciplina } from '../../utils/fichaSocioPwa'
import { fijarCreditosDisciplina, ajustarCreditoDisciplina } from '../../utils/creditosPwa'
import CreditosEditablesSocio from '../../components/CreditosEditablesSocio'

// DNI real del ticket (Facundo Uria) -- caso que expuso el bug del modelo de
// "plan único": socios.plan puede estar desactualizado o incompleto (es un
// campo administrativo manual), pero las filas de este componente ya NO
// dependen de él. Salen directo de fetchCreditosPorDisciplina(), que a su
// vez ya filtra a "al menos un lote activo" (ver fichaSocioPwa.js) --
// acá se mockea directo esa función, simulando su contrato ya filtrado.
const DNI_FACUNDO = '44537978'

function mockearCarga({ userId = 'user-1', entradas = [] } = {}) {
  resolverUserIdPorDni.mockResolvedValue(userId)
  const mapa = new Map()
  mapa.set(DNI_FACUNDO, entradas)
  fetchCreditosPorDisciplina.mockResolvedValue(mapa)
}

describe('CreditosEditablesSocio (reemplaza a los steppers sueltos de SociosTabla.jsx -- ver ticket "Editar Socio")', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'confirm')
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })

  it('sin ninguna disciplina con lotes activos, no renderiza nada (una vez resuelta la carga)', async () => {
    mockearCarga({ entradas: [] })

    const { container } = render(<CreditosEditablesSocio socio={{ id: 's2', dni: DNI_FACUNDO, plan: ['Aparatos'] }} />)

    await waitFor(() => expect(fetchCreditosPorDisciplina).toHaveBeenCalled())
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })

  it('disciplina con créditos reales y vigentes, aunque NO esté tildada en socios.plan -- aparece igual (caso Kickstrike de Facundo)', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-kickstrike',
          disciplineName: 'Kickstrike',
          remainingCredits: 12,
          lotes: [{ id: 'l1', remainingCredits: 12, expiresAt: '2026-09-23T12:00:00.000Z' }],
        },
      ],
    })

    // socio.plan NO incluye Kickstrike -- no debería importar en absoluto.
    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit', 'Boxeo'] }} />)

    await waitFor(() => expect(screen.getByText('Kickstrike')).toBeTruthy())
    expect(screen.getByLabelText('Créditos de Kickstrike').value).toBe('12')
  })

  it('disciplina tildada en socios.plan pero SIN ningún lote activo -- no aparece (caso Boxeo de Facundo)', async () => {
    // fetchCreditosPorDisciplina ya filtra a "al menos un lote activo" (ver
    // fichaSocioPwa.js) -- acá se simula exactamente ese contrato: Boxeo
    // está tildado en el plan pero no viene en las entradas.
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 12,
          lotes: [{ id: 'l1', remainingCredits: 12, expiresAt: '2026-09-23T12:00:00.000Z' }],
        },
      ],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit', 'Boxeo'] }} />)

    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    expect(screen.queryByText('Boxeo')).toBeNull()
  })

  it('socio con 1 sola disciplina real -- sin cambios respecto de siempre', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 6,
          lotes: [{ id: 'l1', remainingCredits: 6, expiresAt: '2026-09-23T12:00:00.000Z' }],
        },
      ],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    expect(screen.getByText('Vence el 23/09/2026')).toBeTruthy()
    expect(screen.getByLabelText('Créditos de CrossFit').value).toBe('6')
  })

  it('caso completo Facundo Uria -- CrossFit y Kickstrike (12 cada uno) aparecen, Boxeo no', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 12,
          lotes: [{ id: 'l1', remainingCredits: 12, expiresAt: '2026-09-23T12:00:00.000Z' }],
        },
        {
          disciplineId: 'd-kickstrike',
          disciplineName: 'Kickstrike',
          remainingCredits: 12,
          lotes: [{ id: 'l2', remainingCredits: 12, expiresAt: '2026-09-23T12:00:00.000Z' }],
        },
      ],
    })

    // socio.plan sigue teniendo "Boxeo" tildado (residuo administrativo) --
    // no debería importar, la sección ya no lo lee.
    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit', 'Boxeo'] }} />)

    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    expect(screen.getByText('Kickstrike')).toBeTruthy()
    expect(screen.queryByText('Boxeo')).toBeNull()
    expect(screen.getByLabelText('Créditos de CrossFit').value).toBe('12')
    expect(screen.getByLabelText('Créditos de Kickstrike').value).toBe('12')
  })

  it('escribir un número distinto y Guardar -- pide confirmación con el texto exacto y, si se confirma, fija el total', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })
    window.confirm.mockReturnValue(true)
    const onCreditosActualizados = vi.fn()

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }}
        onCreditosActualizados={onCreditosActualizados}
      />
    )

    const input = await screen.findByLabelText('Créditos de CrossFit')
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.click(screen.getByText('Guardar'))

    expect(window.confirm).toHaveBeenCalledWith('¿Confirmás modificar los créditos de CrossFit a 20?')
    await waitFor(() => expect(fijarCreditosDisciplina).toHaveBeenCalledWith('user-1', 'd-crossfit', 20))
    await waitFor(() => expect(onCreditosActualizados).toHaveBeenCalled())
  })

  it('si se cancela la confirmación, NO fija nada', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })
    window.confirm.mockReturnValue(false)

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    const input = await screen.findByLabelText('Créditos de CrossFit')
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.click(screen.getByText('Guardar'))

    expect(window.confirm).toHaveBeenCalled()
    expect(fijarCreditosDisciplina).not.toHaveBeenCalled()
  })

  it('+1 -- ajusta de inmediato, SIN pedir confirmación', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })
    const onCreditosActualizados = vi.fn()

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }}
        onCreditosActualizados={onCreditosActualizados}
      />
    )

    fireEvent.click(await screen.findByTitle('Sumar 1 crédito a CrossFit'))

    expect(window.confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(ajustarCreditoDisciplina).toHaveBeenCalledWith('user-1', 'd-crossfit', 1))
    await waitFor(() => expect(onCreditosActualizados).toHaveBeenCalled())
  })

  it('-1 -- ajusta de inmediato, SIN pedir confirmación', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    fireEvent.click(await screen.findByTitle('Restar 1 crédito de CrossFit'))

    expect(window.confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(ajustarCreditoDisciplina).toHaveBeenCalledWith('user-1', 'd-crossfit', -1))
  })

  it('entrada con disciplineId nulo (anomalía de datos) -- avisa y no llama a ningún RPC', async () => {
    // Ya no hay ningún paso de "resolver el id por nombre" -- el disciplineId
    // de cada entrada viene directo de fetchCreditosPorDisciplina() (join
    // real contra user_credits), así que en la práctica siempre está
    // presente. El guard en handleGuardar/handleAjustar queda como defensa
    // ante una anomalía de datos, y este test lo sigue cubriendo.
    mockearCarga({
      entradas: [{ disciplineId: null, disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    fireEvent.click(await screen.findByTitle('Sumar 1 crédito a CrossFit'))

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('No se encontró "CrossFit"'))
    expect(ajustarCreditoDisciplina).not.toHaveBeenCalled()
  })

  it('socio sin cuenta PWA todavía (userId null) -- avisa y no llama a ningún RPC', async () => {
    mockearCarga({
      userId: null,
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    fireEvent.click(await screen.findByTitle('Sumar 1 crédito a CrossFit'))

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('todavía no tiene cuenta en la app'))
    expect(ajustarCreditoDisciplina).not.toHaveBeenCalled()
  })
})
