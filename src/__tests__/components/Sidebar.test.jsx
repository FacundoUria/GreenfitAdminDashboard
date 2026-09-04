import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../utils/pagosSocio', () => ({
  fetchCountComprobantesPendientes: vi.fn(),
}))

// on/subscribe encadenan (mockReturnThis-style) igual que el cliente real --
// mismo patrón que ActividadReciente.test.jsx/Pagos.test.jsx.
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

import { fetchCountComprobantesPendientes } from '../../utils/pagosSocio'
import { supabase } from '../../lib/supabaseClient'
import Sidebar from '../../components/Sidebar'

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  )
}

describe('Sidebar -- ítem "Pagos" con badge de comprobantes pendientes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('muestra el ítem "Pagos" en el menú, con el ícono acorde', async () => {
    fetchCountComprobantesPendientes.mockResolvedValue(0)
    renderSidebar()
    await waitFor(() => expect(fetchCountComprobantesPendientes).toHaveBeenCalled())
    expect(screen.getByRole('link', { name: /Pagos/ })).toHaveAttribute('href', '/pagos')
  })

  it('sin comprobantes pendientes (0), no muestra ningún badge', async () => {
    fetchCountComprobantesPendientes.mockResolvedValue(0)
    renderSidebar()
    await waitFor(() => expect(fetchCountComprobantesPendientes).toHaveBeenCalled())
    expect(screen.queryByLabelText(/pendientes/)).not.toBeInTheDocument()
  })

  it('con 3 comprobantes pendientes, muestra el badge "3" junto a Pagos', async () => {
    fetchCountComprobantesPendientes.mockResolvedValue(3)
    renderSidebar()
    await waitFor(() => expect(screen.getByLabelText('3 pendientes')).toBeInTheDocument())
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('con más de 99 pendientes, muestra "99+" en vez de un número gigante', async () => {
    fetchCountComprobantesPendientes.mockResolvedValue(150)
    renderSidebar()
    await waitFor(() => expect(screen.getByText('99+')).toBeInTheDocument())
  })

  it('se suscribe en vivo a pagos_socio y refresca el badge cuando llega un evento', async () => {
    fetchCountComprobantesPendientes.mockResolvedValue(0)
    renderSidebar()
    await waitFor(() => expect(fetchCountComprobantesPendientes).toHaveBeenCalledTimes(1))

    expect(supabase.channel).toHaveBeenCalledWith('sidebar-pagos-pendientes-badge')
    expect(mockChannelOn).toHaveBeenCalledWith(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'pagos_socio' },
      expect.any(Function),
    )

    fetchCountComprobantesPendientes.mockResolvedValue(1)
    const callbackRealtime = mockChannelOn.mock.calls[0][2]
    callbackRealtime({})

    await waitFor(() => expect(screen.getByLabelText('1 pendientes')).toBeInTheDocument())
  })

  it('si falla la carga del badge, el resto del menú sigue funcionando (best-effort, no rompe la navegación)', async () => {
    fetchCountComprobantesPendientes.mockRejectedValue(new Error('timeout'))
    renderSidebar()
    await waitFor(() => expect(screen.getByRole('link', { name: /Socios/ })).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /Pagos/ })).toBeInTheDocument()
    expect(screen.queryByLabelText(/pendientes/)).not.toBeInTheDocument()
  })
})
