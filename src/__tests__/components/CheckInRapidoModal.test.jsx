import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../utils/fichaSocioPwa', () => ({
  buscarSociosParaCheckin: vi.fn(),
  otorgarCheckinMusculacion: vi.fn(),
  CHECKIN_OTORGADO: 'otorgado',
  CHECKIN_YA_REGISTRADO: 'ya_registrado_hoy',
}))

import { buscarSociosParaCheckin, otorgarCheckinMusculacion } from '../../utils/fichaSocioPwa'
import CheckInRapidoModal from '../../components/CheckInRapidoModal'

const SOCIO = { userId: 'u1', nombre: 'Martina Ríos', dni: '30111222', avatarUrl: null }

describe('CheckInRapidoModal (Navbar -- Check-in Rápido ⚡ de Musculación)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('no renderiza nada si visible=false', () => {
    const { container } = render(<CheckInRapidoModal visible={false} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('busca socios (debounced) y otorga +100 XP con un clic', async () => {
    buscarSociosParaCheckin.mockResolvedValue([SOCIO])
    otorgarCheckinMusculacion.mockResolvedValue('otorgado')

    render(<CheckInRapidoModal visible onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Buscar socio'), { target: { value: 'Martina' } })

    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy(), { timeout: 2000 })
    expect(buscarSociosParaCheckin).toHaveBeenCalledWith('Martina')

    fireEvent.click(screen.getByRole('button', { name: /otorgar/i }))

    await waitFor(() => expect(screen.getByText('+100 XP')).toBeTruthy())
    expect(otorgarCheckinMusculacion).toHaveBeenCalledWith('u1')
  })

  it('si el socio ya tiene un check-in hoy, muestra "Ya registrado hoy" en vez de romper', async () => {
    buscarSociosParaCheckin.mockResolvedValue([SOCIO])
    otorgarCheckinMusculacion.mockResolvedValue('ya_registrado_hoy')

    render(<CheckInRapidoModal visible onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Buscar socio'), { target: { value: 'Martina' } })

    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy(), { timeout: 2000 })
    fireEvent.click(screen.getByRole('button', { name: /otorgar/i }))

    await waitFor(() => expect(screen.getByText('Ya registrado hoy')).toBeTruthy())
  })
})
