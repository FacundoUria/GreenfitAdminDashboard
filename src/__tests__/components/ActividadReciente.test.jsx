import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../utils/fichaSocioPwa', () => ({
  fetchActividadReciente: vi.fn(),
  revertirXpEvento: vi.fn(),
}))

// on/subscribe encadenan (mockReturnThis-style) igual que el cliente real --
// nombre `mock...` porque la factory de vi.mock corre hoisteada y Vitest
// solo permite referenciar acá identificadores con ese prefijo.
const mockChannelOn = vi.fn(function () {
  return this
})
const mockChannelSubscribe = vi.fn(function () {
  return this
})
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    channel: vi.fn(() => ({ on: mockChannelOn, subscribe: mockChannelSubscribe })),
    removeChannel: vi.fn(),
  },
}))

import { fetchActividadReciente, revertirXpEvento } from '../../utils/fichaSocioPwa'
import { supabase } from '../../lib/supabaseClient'
import ActividadReciente from '../../components/ActividadReciente'

const ITEMS = [
  {
    id: 'reserva-b1',
    tipo: 'reserva',
    fecha: '2026-08-10T09:00:00.000Z',
    socioNombre: 'Facundo Uria',
    detalle: 'Reservó CrossFit',
    xpEventId: null,
    xpAmount: null,
    revertido: false,
  },
  {
    id: 'xp-e1',
    tipo: 'checkin_musculacion',
    fecha: '2026-08-10T10:00:00.000Z',
    socioNombre: 'Bruno Álvarez',
    detalle: 'Check-in de Aparatos',
    xpEventId: 'e1',
    xpAmount: 100,
    revertido: false,
  },
  {
    id: 'xp-e2',
    tipo: 'reversion',
    fecha: '2026-08-10T11:00:00.000Z',
    socioNombre: 'Martina Ríos',
    detalle: 'Reversión de CrossFit (-100 XP)',
    xpEventId: null,
    xpAmount: -100,
    revertido: false,
  },
]

describe('ActividadReciente (Dashboard -- feed + reversión de XP)', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('renderiza el stream de Reservas, Check-ins y Reversiones', async () => {
    fetchActividadReciente.mockResolvedValue(ITEMS)
    render(<ActividadReciente />)

    await waitFor(() => expect(screen.getByText(/Reservó CrossFit/)).toBeTruthy())
    expect(screen.getByText(/Check-in de Aparatos/)).toBeTruthy()
    expect(screen.getByText(/Reversión de CrossFit/)).toBeTruthy()
  })

  it('solo ofrece "Revertir" en eventos con XP no revertido todavía (no en reservas ni reversiones)', async () => {
    fetchActividadReciente.mockResolvedValue(ITEMS)
    render(<ActividadReciente />)

    await waitFor(() => expect(screen.getAllByRole('button', { name: /revertir/i })).toHaveLength(1))
  })

  it('al confirmar "Revertir", llama a revertirXpEvento y refresca el feed', async () => {
    fetchActividadReciente.mockResolvedValueOnce(ITEMS).mockResolvedValueOnce(
      ITEMS.map((i) => (i.id === 'xp-e1' ? { ...i, revertido: true } : i)),
    )
    revertirXpEvento.mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<ActividadReciente />)
    await waitFor(() => expect(screen.getByRole('button', { name: /revertir/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /revertir/i }))

    await waitFor(() => expect(revertirXpEvento).toHaveBeenCalledWith('e1'))
    await waitFor(() => expect(fetchActividadReciente).toHaveBeenCalledTimes(2))
  })

  it('si el admin cancela la confirmación, NO llama a revertirXpEvento', async () => {
    fetchActividadReciente.mockResolvedValue(ITEMS)
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<ActividadReciente />)
    await waitFor(() => expect(screen.getByRole('button', { name: /revertir/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /revertir/i }))

    expect(revertirXpEvento).not.toHaveBeenCalled()
  })

  // Checklist "Refresco en Tiempo Real": una compra por Mercado Pago tiene
  // que verse al instante mientras Seba ya tiene el Dashboard abierto, sin
  // esperar el polling de 30s.
  it('se suscribe en vivo a INSERT de pagos_socio y refresca el feed cuando llega un evento', async () => {
    fetchActividadReciente.mockResolvedValue(ITEMS)
    render(<ActividadReciente />)
    await waitFor(() => expect(screen.getByText(/Reservó CrossFit/)).toBeTruthy())

    expect(supabase.channel).toHaveBeenCalledWith('actividad-reciente-pagos-mp')
    expect(mockChannelOn).toHaveBeenCalledWith(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'pagos_socio' },
      expect.any(Function),
    )

    fetchActividadReciente.mockClear()
    const callbackRealtime = mockChannelOn.mock.calls[0][2]
    callbackRealtime({})

    await waitFor(() => expect(fetchActividadReciente).toHaveBeenCalledTimes(1))
  })
})
