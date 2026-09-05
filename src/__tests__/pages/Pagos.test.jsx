import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

vi.mock('../../utils/pagosSocio', () => ({
  fetchHistorialComprobantes: vi.fn(),
  revertirComprobante: vi.fn(),
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

import { fetchHistorialComprobantes, revertirComprobante } from '../../utils/pagosSocio'
import { supabase } from '../../lib/supabaseClient'
import Pagos from '../../pages/Pagos'

const PAGO_BRUNO = {
  id: 'pago-1',
  userId: 'socio-1',
  socioNombre: 'Bruno Álvarez',
  paquete: 'Pack 12 CrossFit',
  pack: { name: 'Pack 12 CrossFit', creditos: [{ discipline_id: 'disc-crossfit', credits: 12 }], incluye_aparatos: false },
  creditosTexto: '12 créditos CrossFit',
  detalleRevertidoTexto: '12 créditos CrossFit',
  monto: 30000,
  fecha: '2026-09-01T10:00:00.000Z',
  estado: 'pagado',
  revertidoEl: null,
  comprobanteUrl: 'https://signed.test/socio-1/123.jpg',
}

const PAGO_MARTINA = {
  id: 'pago-2',
  userId: 'socio-2',
  socioNombre: 'Martina Ríos',
  paquete: 'Aparatos Pase Libre',
  pack: { name: 'Aparatos Pase Libre', creditos: [], incluye_aparatos: true },
  creditosTexto: 'Aparatos Pase Libre',
  detalleRevertidoTexto: 'la extensión de Aparatos',
  monto: 21000,
  fecha: '2026-09-01T09:00:00.000Z',
  estado: 'pagado',
  revertidoEl: null,
  comprobanteUrl: null,
}

const PAGO_ANULADO = {
  id: 'pago-3',
  userId: 'socio-3',
  socioNombre: 'Charbel Nara',
  paquete: 'Pack 8 Boxeo',
  pack: { name: 'Pack 8 Boxeo', creditos: [{ discipline_id: 'disc-boxeo', credits: 8 }], incluye_aparatos: false },
  creditosTexto: '8 créditos Boxeo',
  detalleRevertidoTexto: '8 créditos Boxeo',
  monto: 20000,
  fecha: '2026-08-30T09:00:00.000Z',
  estado: 'anulado',
  revertidoEl: '2026-09-01T12:00:00.000Z',
  comprobanteUrl: null,
}

describe('Pagos (Fase 3 -- historial de comprobantes, acreditación automática + reversión)', () => {
  let confirmSpy
  let alertSpy

  beforeEach(() => {
    vi.clearAllMocks()
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    fetchHistorialComprobantes.mockResolvedValue([PAGO_BRUNO, PAGO_MARTINA])
  })

  afterEach(() => {
    confirmSpy.mockRestore()
    alertSpy.mockRestore()
  })

  it('lista el historial con socio, pack, monto, fecha y el badge de estado', async () => {
    render(<Pagos />)

    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())
    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    expect(filaBruno).toHaveTextContent('Pack 12 CrossFit')
    expect(filaBruno).toHaveTextContent('30.000')
    expect(within(filaBruno).getByText('Pagado')).toBeInTheDocument()
    expect(screen.getByText('12 créditos CrossFit')).toBeInTheDocument()
    expect(screen.getByText('Martina Ríos')).toBeInTheDocument()
  })

  it('una fila anulada muestra el badge "Anulado" y NO tiene botón Revertir', async () => {
    fetchHistorialComprobantes.mockResolvedValue([PAGO_ANULADO])
    render(<Pagos />)

    await waitFor(() => expect(screen.getByText('Charbel Nara')).toBeInTheDocument())
    const fila = screen.getByText('Charbel Nara').closest('li')
    expect(within(fila).getByText('Anulado')).toBeInTheDocument()
    expect(within(fila).queryByRole('button', { name: /revertir/i })).not.toBeInTheDocument()
  })

  it('sin ningún comprobante en el historial, muestra el estado vacío', async () => {
    fetchHistorialComprobantes.mockResolvedValue([])
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Todavía no hay comprobantes en el historial.')).toBeInTheDocument())
  })

  it('si fetchHistorialComprobantes falla, muestra un mensaje de error claro', async () => {
    fetchHistorialComprobantes.mockRejectedValue(new Error('No se pudo conectar con Supabase.'))
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

  it('Revertir: pide confirmación describiendo lo que se le va a quitar (detalleRevertidoTexto, no la definición actual del pack), y al confirmar revierte', async () => {
    revertirComprobante.mockResolvedValue({ revertido: true, aparatosAdvertencia: null })
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    fireEvent.click(within(filaBruno).getByRole('button', { name: /revertir/i }))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('12 créditos CrossFit'))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Bruno Álvarez'))
    await waitFor(() => expect(revertirComprobante).toHaveBeenCalledWith('pago-1'))
  })

  it('Revertir: si se cancela la confirmación, no llama al RPC', async () => {
    confirmSpy.mockReturnValue(false)
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    fireEvent.click(within(filaBruno).getByRole('button', { name: /revertir/i }))

    expect(revertirComprobante).not.toHaveBeenCalled()
  })

  it('Revertir sin advertencia: muestra un toast de éxito, SIN mostrar el banner de advertencia', async () => {
    revertirComprobante.mockResolvedValue({ revertido: true, aparatosAdvertencia: null })
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    fireEvent.click(within(screen.getByText('Bruno Álvarez').closest('li')).getByRole('button', { name: /revertir/i }))

    await waitFor(() => expect(screen.getByText(/Acreditación revertida/)).toBeInTheDocument())
  })

  // Pedido explícito: la advertencia de Aparatos tiene que verse BIEN
  // VISIBLE (banner persistente), no como un detalle chico que se puede
  // pasar por alto.
  it('Revertir CON advertencia de Aparatos: muestra un banner persistente y visible con el texto exacto', async () => {
    revertirComprobante.mockResolvedValue({
      revertido: true,
      aparatosAdvertencia: 'La fecha de vencimiento de Aparatos no se pudo revertir automáticamente -- cambió desde que se otorgó esta acreditación. Ajustala a mano en "Editar Socio".',
    })
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeInTheDocument())

    fireEvent.click(within(screen.getByText('Martina Ríos').closest('li')).getByRole('button', { name: /revertir/i }))

    await waitFor(() =>
      expect(screen.getByText(/no se pudo revertir automáticamente/)).toBeInTheDocument()
    )
    // El nombre del socio va incluido en el banner, para que quede claro a
    // quién corresponde ajustar la fecha a mano (regex compuesta -- "Martina
    // Ríos" sola matchea también la fila de la lista, no solo el banner).
    expect(screen.getByText(/Martina Ríos: La fecha/)).toBeInTheDocument()
    // El banner se puede cerrar a mano.
    fireEvent.click(screen.getByLabelText('Cerrar advertencia'))
    expect(screen.queryByText(/no se pudo revertir automáticamente/)).not.toBeInTheDocument()
  })

  it('Revertir: si el comprobante ya había sido revertido por otra pestaña (revertido=false), avisa y refresca la lista real', async () => {
    revertirComprobante.mockResolvedValue({ revertido: false, aparatosAdvertencia: null })
    fetchHistorialComprobantes.mockResolvedValueOnce([PAGO_BRUNO, PAGO_MARTINA]).mockResolvedValueOnce([{ ...PAGO_BRUNO, estado: 'anulado' }, PAGO_MARTINA])
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    fireEvent.click(within(screen.getByText('Bruno Álvarez').closest('li')).getByRole('button', { name: /revertir/i }))

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('ya había sido revertido')))
    await waitFor(() => expect(fetchHistorialComprobantes).toHaveBeenCalledTimes(2))
  })

  it('Revertir: con un error real del RPC, muestra el error en la fila y el botón vuelve a estar disponible (no queda colgado)', async () => {
    revertirComprobante.mockRejectedValue(new Error('No existe ningún pago con ese id.'))
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    const botonRevertir = within(filaBruno).getByRole('button', { name: /revertir/i })
    fireEvent.click(botonRevertir)

    await waitFor(() => expect(screen.getByText('No existe ningún pago con ese id.')).toBeInTheDocument())
    expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument()
    expect(within(filaBruno).getByRole('button', { name: /revertir/i })).not.toBeDisabled()
  })

  it('se suscribe en vivo a pagos_socio y refresca la lista cuando llega un evento (comprobante nuevo, o revertido desde otra pestaña)', async () => {
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    expect(supabase.channel).toHaveBeenCalledWith('pagos-comprobantes-transferencia')
    expect(mockChannelOn).toHaveBeenCalledWith(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'pagos_socio' },
      expect.any(Function),
    )

    fetchHistorialComprobantes.mockClear()
    const callbackRealtime = mockChannelOn.mock.calls[0][2]
    callbackRealtime({})

    await waitFor(() => expect(fetchHistorialComprobantes).toHaveBeenCalledTimes(1))
  })

  it('al desmontar, da de baja el canal de Realtime', async () => {
    const { unmount } = render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())
    unmount()
    expect(supabase.removeChannel).toHaveBeenCalled()
  })
})
