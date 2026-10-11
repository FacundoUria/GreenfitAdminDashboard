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
  detalleRevertidoTexto: 'Aparatos',
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
    revertirComprobante.mockResolvedValue({ revertido: true, avisos: [] })
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    fireEvent.click(within(filaBruno).getByRole('button', { name: /revertir/i }))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('12 créditos CrossFit'))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Bruno Álvarez'))
    await waitFor(() => expect(revertirComprobante).toHaveBeenCalledWith('pago-1'))
  })

  // Regla F: la confirmación tiene que decir la verdad sobre lo que va a pasar.
  it('Revertir: la confirmación avisa que vence todo lo del pago (incluido Aparatos), que NO devuelve el plan anterior y que NO cancela reservas futuras', async () => {
    revertirComprobante.mockResolvedValue({ revertido: true, avisos: [] })
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeInTheDocument())

    fireEvent.click(within(screen.getByText('Martina Ríos').closest('li')).getByRole('button', { name: /revertir/i }))

    const texto = confirmSpy.mock.calls[0][0]
    expect(texto).toContain('Se le va a quitar: Aparatos.')
    expect(texto).toContain('Se le vence ya todo lo que dio este pago, incluido Aparatos.')
    expect(texto).toContain('No se le devuelve el plan anterior.')
    expect(texto).toContain('Las reservas futuras no se cancelan.')
    expect(texto).toContain('Esta acción no se puede deshacer.')
    expect(texto).not.toContain('extensión')
  })

  it('Revertir: si se cancela la confirmación, no llama al RPC', async () => {
    confirmSpy.mockReturnValue(false)
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    fireEvent.click(within(filaBruno).getByRole('button', { name: /revertir/i }))

    expect(revertirComprobante).not.toHaveBeenCalled()
  })

  it('Revertir sin avisos: muestra un toast de éxito con el nombre, SIN mostrar el banner de advertencia', async () => {
    revertirComprobante.mockResolvedValue({ revertido: true, avisos: [] })
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    fireEvent.click(within(screen.getByText('Bruno Álvarez').closest('li')).getByRole('button', { name: /revertir/i }))

    await waitFor(() =>
      expect(screen.getByText('Acreditación revertida -- se le quitó lo que quedaba sin usar a Bruno Álvarez.')).toBeInTheDocument(),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // Pedido explícito: los avisos tienen que verse BIEN VISIBLES (banner
  // persistente, uno por línea), no como un detalle chico que se puede pasar
  // por alto ni como un toast que se va solo.
  it('Revertir CON avisos: banner persistente con el nombre del socio y CADA aviso en su propia línea, sin toast', async () => {
    const AVISOS = [
      'El Aparatos de este pago tenía la fecha cambiada a mano (vencía el 21/11/2026): igual se le venció.',
      'Tiene 1 reserva(s) futura(s) pagada(s) con créditos de este pago (CrossFit 19hs del 09/10): no se cancelaron. Si se cancelan, el crédito no vuelve porque el lote quedó vencido.',
      'Sigue vigente (no es de este pago, no se tocó): Boxeo (3 créditos) hasta el 06/11/2026.',
    ]
    revertirComprobante.mockResolvedValue({ revertido: true, avisos: AVISOS })
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeInTheDocument())

    fireEvent.click(within(screen.getByText('Martina Ríos').closest('li')).getByRole('button', { name: /revertir/i }))

    const banner = await screen.findByRole('alert')
    expect(within(banner).getByText('Martina Ríos: acreditación revertida, con avisos')).toBeInTheDocument()
    const lineas = within(banner).getAllByRole('listitem').map((li) => li.textContent)
    expect(lineas).toEqual(AVISOS)
    expect(screen.queryByText(/Acreditación revertida --/)).not.toBeInTheDocument()

    // Sigue ahí hasta que Seba lo cierra a mano.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Cerrar advertencia'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Revertir con un solo aviso (lo del pago ya estaba vencido): también va al banner, no al toast', async () => {
    revertirComprobante.mockResolvedValue({
      revertido: true,
      avisos: ['El Aparatos de este pago ya estaba vencido (venció, lo reemplazó otro cobro o se quitó a mano): no había nada para quitar.'],
    })
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeInTheDocument())

    fireEvent.click(within(screen.getByText('Martina Ríos').closest('li')).getByRole('button', { name: /revertir/i }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('ya estaba vencido')
    expect(screen.queryByText(/Acreditación revertida --/)).not.toBeInTheDocument()
  })

  it('Revertir: si el comprobante ya había sido revertido por otra pestaña (revertido=false), avisa y refresca la lista real', async () => {
    revertirComprobante.mockResolvedValue({ revertido: false, avisos: ['Este pago ya estaba revertido: no se cambió nada.'] })
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

  // Si algo del pago no se puede identificar, la RPC no cambia nada y lo dice:
  // ese mensaje completo tiene que quedar visible bajo ESA fila.
  it('Revertir: "No se pudo revertir … No se cambió nada" se ve completo bajo esa fila, la fila sigue "Pagado" y no hay toast', async () => {
    const mensaje =
      'No se pudo revertir: el lote de créditos de CrossFit que figura en este pago no lo creó este pago (puede ser un comprobante de antes del 10/09, cuando los créditos se sumaban a un lote existente). No se cambió nada: corregí los créditos a mano desde Socios.'
    revertirComprobante.mockRejectedValue(new Error(mensaje))
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    fireEvent.click(within(filaBruno).getByRole('button', { name: /revertir/i }))

    await waitFor(() => expect(within(filaBruno).getByText(mensaje)).toBeInTheDocument())
    expect(within(screen.getByText('Martina Ríos').closest('li')).queryByText(mensaje)).not.toBeInTheDocument()
    expect(within(filaBruno).getByText('Pagado')).toBeInTheDocument()
    expect(screen.queryByText(/Acreditación revertida/)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Revertir: un error de red también se ve en la fila (nunca en silencio)', async () => {
    revertirComprobante.mockRejectedValue(new Error('Failed to fetch'))
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    fireEvent.click(within(filaBruno).getByRole('button', { name: /revertir/i }))

    await waitFor(() => expect(within(filaBruno).getByText('Failed to fetch')).toBeInTheDocument())
  })

  it('Revertir: mientras procesa, el botón queda deshabilitado (un doble click no revierte dos veces)', async () => {
    let resolver
    revertirComprobante.mockReturnValue(new Promise((r) => (resolver = r)))
    render(<Pagos />)
    await waitFor(() => expect(screen.getByText('Bruno Álvarez')).toBeInTheDocument())

    const filaBruno = screen.getByText('Bruno Álvarez').closest('li')
    const boton = within(filaBruno).getByRole('button', { name: /revertir/i })
    fireEvent.click(boton)
    await waitFor(() => expect(boton).toBeDisabled())
    fireEvent.click(boton)
    expect(revertirComprobante).toHaveBeenCalledTimes(1)

    resolver({ revertido: true, avisos: [] })
    await waitFor(() => expect(boton).not.toBeDisabled())
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
