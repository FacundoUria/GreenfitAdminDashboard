import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

vi.mock('../../utils/pagosSocio', () => ({
  fetchComprobantesPendientes: vi.fn(),
  aprobarComprobante: vi.fn(),
  rechazarComprobante: vi.fn(),
}))

// on/subscribe encadenan (mockReturnThis-style) igual que el cliente real --
// mismo patrón que ActividadReciente.test.jsx.
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

import { fetchComprobantesPendientes, aprobarComprobante, rechazarComprobante } from '../../utils/pagosSocio'
import { supabase } from '../../lib/supabaseClient'
import Pagos from '../../pages/Pagos'

const PAGO_BRUNO = {
  id: 'pago-1',
  userId: 'socio-1',
  socioNombre: 'Bruno Álvarez',
  paquete: 'Pack 12 CrossFit',
  pack: { name: 'Pack 12 CrossFit', creditos: [{ discipline_id: 'disc-crossfit', credits: 12 }], incluye_aparatos: false },
  creditosTexto: '12 créditos CrossFit',
  monto: 30000,
  fecha: '2026-09-01T10:00:00.000Z',
  comprobanteUrl: 'https://signed.test/socio-1/123.jpg',
}

const PAGO_MARTINA = {
  id: 'pago-2',
  userId: 'socio-2',
  socioNombre: 'Martina Ríos',
  paquete: 'Aparatos Pase Libre',
  pack: { name: 'Aparatos Pase Libre', creditos: [], incluye_aparatos: true },
  creditosTexto: 'Aparatos Pase Libre',
  monto: 21000,
  fecha: '2026-09-01T09:00:00.000Z',
  comprobanteUrl: null,
}

describe('Pagos (Fase 3 -- revisión de comprobantes de transferencia)', () => {
  let confirmSpy
  let alertSpy

  beforeEach(() => {
    vi.clearAllMocks()
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    fetchComprobantesPendientes.mockResolvedValue([PAGO_BRUNO, PAGO_MARTINA])
  })

  afterEach(() => {
    confirmSpy.mockRestore()
    alertSpy.mockRestore()
  })

  it('lista los comprobantes pendientes con socio, pack, monto y fecha, más recientes primero (orden que ya devuelve fetchComprobantesPendientes)', async () => {
    render(<Pagos />)

    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())
    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    expect(filaBruno).toHaveTextContent('Pack 12 CrossFit')
    // Solo la parte numérica -- formatMoneda() separa el símbolo "$" del
    // monto con un espacio duro ( ) que toHaveTextContent normaliza
    // en el textContent recibido pero NO en el string esperado, así que
    // comparar el string armado por formatMoneda() 1:1 da un falso negativo.
    expect(filaBruno).toHaveTextContent('30.000')
    expect(screen.getByText('12 créditos CrossFit')).toBeInTheDocument()
    expect(screen.getByText('Martina Ríos')).toBeInTheDocument()
  })

  it('sin ningún comprobante pendiente, muestra el estado vacío', async () => {
    fetchComprobantesPendientes.mockResolvedValue([])
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('No hay comprobantes pendientes de revisión.')).toBeInTheDocument())
  })

  it('si fetchComprobantesPendientes falla, muestra un mensaje de error claro', async () => {
    fetchComprobantesPendientes.mockRejectedValue(new Error('No se pudo conectar con Supabase.'))
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('No se pudo conectar con Supabase.')).toBeInTheDocument())
  })

  it('una fila sin comprobante_url muestra "Sin imagen disponible" en vez de romper', async () => {
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeInTheDocument())
    expect(screen.getByText('Sin imagen disponible')).toBeInTheDocument()
  })

  it('tocar la imagen la amplía en un overlay, y se puede cerrar', async () => {
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    fireEvent.click(screen.getByAltText('Comprobante de Bruno Álvarez'))
    const dialog = await screen.findByRole('dialog', { name: 'Comprobante ampliado' })
    expect(within(dialog).getByAltText('Comprobante de pago ampliado')).toHaveAttribute('src', PAGO_BRUNO.comprobanteUrl)

    fireEvent.click(screen.getByLabelText('Cerrar'))
    expect(screen.queryByRole('dialog', { name: 'Comprobante ampliado' })).not.toBeInTheDocument()
  })

  it('Aprobar: pide confirmación describiendo el pack/créditos, y al confirmar acredita y saca la fila de la lista', async () => {
    aprobarComprobante.mockResolvedValue({ creditoOtorgado: true })
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    fireEvent.click(within(filaBruno).getByRole('button', { name: /aprobar/i }))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('12 créditos CrossFit'))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Bruno Álvarez'))
    await waitFor(() => expect(aprobarComprobante).toHaveBeenCalledWith('pago-1'))
    await waitFor(() => expect(screen.queryByText('Bruno Álvarez')).not.toBeInTheDocument())
    // La otra fila (Martina) no se tocó.
    expect(screen.getByText('Martina Ríos')).toBeInTheDocument()
  })

  it('Aprobar: si se cancela la confirmación, no llama al RPC ni saca la fila', async () => {
    confirmSpy.mockReturnValue(false)
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    fireEvent.click(within(filaBruno).getByRole('button', { name: /aprobar/i }))

    expect(aprobarComprobante).not.toHaveBeenCalled()
    expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument()
  })

  it('Aprobar: si el comprobante ya había sido revisado por otra pestaña (creditoOtorgado=false), avisa y refresca la lista real', async () => {
    aprobarComprobante.mockResolvedValue({ creditoOtorgado: false })
    fetchComprobantesPendientes.mockResolvedValueOnce([PAGO_BRUNO, PAGO_MARTINA]).mockResolvedValueOnce([PAGO_MARTINA])
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    fireEvent.click(within(filaBruno).getByRole('button', { name: /aprobar/i }))

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('ya había sido revisado')))
    await waitFor(() => expect(screen.queryByText('Bruno Álvarez')).not.toBeInTheDocument())
    expect(fetchComprobantesPendientes).toHaveBeenCalledTimes(2)
  })

  it('Aprobar: con un error real del RPC, muestra el error en la fila y el botón vuelve a estar disponible (no queda colgado)', async () => {
    aprobarComprobante.mockRejectedValue(new Error('No existe ningún comprobante con ese id.'))
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    const botonAprobar = within(filaBruno).getByRole('button', { name: /aprobar/i })
    fireEvent.click(botonAprobar)

    await waitFor(() => expect(screen.getByText('No existe ningún comprobante con ese id.')).toBeInTheDocument())
    // La fila sigue en la lista (estado ambiguo evitado) y el botón no quedó deshabilitado para siempre.
    expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument()
    expect(within(filaBruno).getByRole('button', { name: /aprobar/i })).not.toBeDisabled()
  })

  it('Descartar: pide confirmación, y al confirmar rechaza y saca la fila de la lista', async () => {
    rechazarComprobante.mockResolvedValue(undefined)
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeInTheDocument())

    const filaMartina = screen.getByText('Martina Ríos').closest('li')
    fireEvent.click(within(filaMartina).getByRole('button', { name: /descartar/i }))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Martina Ríos'))
    await waitFor(() => expect(rechazarComprobante).toHaveBeenCalledWith('pago-2'))
    await waitFor(() => expect(screen.queryByText('Martina Ríos')).not.toBeInTheDocument())
    expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument()
  })

  it('Descartar: con un error real, lo muestra en la fila sin sacarla de la lista', async () => {
    rechazarComprobante.mockRejectedValue(new Error('Error de red.'))
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeInTheDocument())

    const filaMartina = screen.getByText('Martina Ríos').closest('li')
    fireEvent.click(within(filaMartina).getByRole('button', { name: /descartar/i }))

    await waitFor(() => expect(screen.getByText('Error de red.')).toBeInTheDocument())
    expect(screen.getByText('Martina Ríos')).toBeInTheDocument()
  })

  it('se suscribe en vivo a pagos_socio y refresca la lista cuando llega un evento (nuevo comprobante, o revisado desde otra pestaña)', async () => {
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    expect(supabase.channel).toHaveBeenCalledWith('pagos-pendientes-transferencia')
    expect(mockChannelOn).toHaveBeenCalledWith(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'pagos_socio' },
      expect.any(Function),
    )

    fetchComprobantesPendientes.mockClear()
    const callbackRealtime = mockChannelOn.mock.calls[0][2]
    callbackRealtime({})

    await waitFor(() => expect(fetchComprobantesPendientes).toHaveBeenCalledTimes(1))
  })

  it('al desmontar, da de baja el canal de Realtime', async () => {
    const { unmount } = render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())
    unmount()
    expect(supabase.removeChannel).toHaveBeenCalled()
  })
})
