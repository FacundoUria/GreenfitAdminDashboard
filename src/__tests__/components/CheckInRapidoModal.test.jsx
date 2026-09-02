import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../utils/fichaSocioPwa', () => ({
  buscarSociosParaCheckin: vi.fn(),
  otorgarCheckinAparatos: vi.fn(),
  buscarSociosClaseActiva: vi.fn(),
  darPresenteClase: vi.fn(),
  CHECKIN_OTORGADO: 'otorgado',
  CHECKIN_YA_REGISTRADO: 'ya_registrado_hoy',
}))

import {
  buscarSociosParaCheckin,
  otorgarCheckinAparatos,
  buscarSociosClaseActiva,
  darPresenteClase,
} from '../../utils/fichaSocioPwa'
import CheckInRapidoModal from '../../components/CheckInRapidoModal'

const SOCIO = { userId: 'u1', nombre: 'Martina Ríos', dni: '30111222', avatarUrl: null }

const INSCRIPTO_CROSSFIT = {
  bookingId: 'booking-1',
  userId: 'u2',
  nombre: 'Bruno Álvarez',
  dni: '30999888',
  turno: 'CrossFit · 18:00 a 19:00',
  yaRegistrado: false,
}

describe('CheckInRapidoModal (Navbar -- Check-in Rápido ⚡)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Sin clase activa por defecto -- las pruebas de búsqueda por nombre/DNI
    // (Musculación) no dependen de esto.
    buscarSociosClaseActiva.mockResolvedValue([])
  })

  it('no renderiza nada si visible=false', () => {
    const { container } = render(<CheckInRapidoModal visible={false} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('busca socios (debounced) y otorga +100 XP con un clic', async () => {
    buscarSociosParaCheckin.mockResolvedValue([SOCIO])
    otorgarCheckinAparatos.mockResolvedValue('otorgado')

    render(<CheckInRapidoModal visible onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Buscar socio'), { target: { value: 'Martina' } })

    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy(), { timeout: 2000 })
    expect(buscarSociosParaCheckin).toHaveBeenCalledWith('Martina')

    fireEvent.click(screen.getByRole('button', { name: /otorgar/i }))

    await waitFor(() => expect(screen.getByText('+100 XP')).toBeTruthy())
    expect(otorgarCheckinAparatos).toHaveBeenCalledWith('u1')
  })

  it('si el socio ya tiene un check-in hoy, muestra "Ya registrado hoy" en vez de romper', async () => {
    buscarSociosParaCheckin.mockResolvedValue([SOCIO])
    otorgarCheckinAparatos.mockResolvedValue('ya_registrado_hoy')

    render(<CheckInRapidoModal visible onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Buscar socio'), { target: { value: 'Martina' } })

    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy(), { timeout: 2000 })
    fireEvent.click(screen.getByRole('button', { name: /otorgar/i }))

    await waitFor(() => expect(screen.getByText('Ya registrado hoy')).toBeTruthy())
  })

  // -- Sugerencias inteligentes (clase activa/por arrancar) --

  it('al abrir el modal sin escribir nada, lista automáticamente a los inscriptos de la clase activa', async () => {
    buscarSociosClaseActiva.mockResolvedValue([INSCRIPTO_CROSSFIT])

    render(<CheckInRapidoModal visible onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeTruthy())
    expect(screen.getByText('CrossFit · 18:00 a 19:00')).toBeTruthy()
    expect(buscarSociosParaCheckin).not.toHaveBeenCalled()
  })

  it('"Dar Presente" marca la reserva de la sugerencia como asistida', async () => {
    buscarSociosClaseActiva.mockResolvedValue([INSCRIPTO_CROSSFIT])
    darPresenteClase.mockResolvedValue(undefined)

    render(<CheckInRapidoModal visible onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /dar presente/i }))

    await waitFor(() => expect(screen.getByText('Presente')).toBeTruthy())
    expect(darPresenteClase).toHaveBeenCalledWith('booking-1')
  })

  it('un inscripto que ya tenía la asistencia marcada arranca directo en "Presente", sin botón', async () => {
    buscarSociosClaseActiva.mockResolvedValue([{ ...INSCRIPTO_CROSSFIT, yaRegistrado: true }])

    render(<CheckInRapidoModal visible onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeTruthy())
    expect(screen.getByText('Presente')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /dar presente/i })).toBeNull()
  })

  it('sin ninguna clase activa, avisa que se puede buscar por nombre/DNI para Musculación', async () => {
    buscarSociosClaseActiva.mockResolvedValue([])

    render(<CheckInRapidoModal visible onClose={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByText(/No hay ninguna clase en curso ni por arrancar ahora/)).toBeTruthy(),
    )
  })

  it('escribir algo en el buscador oculta las sugerencias y muestra la búsqueda por nombre/DNI', async () => {
    buscarSociosClaseActiva.mockResolvedValue([INSCRIPTO_CROSSFIT])
    buscarSociosParaCheckin.mockResolvedValue([SOCIO])

    render(<CheckInRapidoModal visible onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Buscar socio'), { target: { value: 'Martina' } })

    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy())
    expect(screen.queryByText('Bruno Álvarez')).toBeNull()
  })
})
