import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

// Tanda 2 -- cancela EL GIMNASIO desde Clases. "Quitar de la clase" usa
// admin_quitar_de_clase y "Cancelar clase" usa admin_cancelar_clase_dia_v2:
// Seba ve qué pasó con cada crédito y cada socio recibe un push con SU caso.
// Reloj: jueves 22/10/2026 12:00 de Argentina (15:00Z).

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

const CLASE = {
  id: 'c1',
  title: 'CrossFit',
  discipline_id: 'd1',
  instructor: 'Seba',
  start_time: '19:00:00',
  end_time: '20:00:00',
  capacity: 20,
  days_of_week: [0, 1, 2, 3, 4, 5, 6],
  created_at: '2026-07-01T12:00:00Z',
}
const reserva = (id, user, nombre) => ({ id, class_id: 'c1', booking_date: '2026-10-22', user_id: user, attended: null, profiles: { full_name: nombre, dni: null } })

const resultado = (user, nombre, reintegrado, mensajeSocio, mensajeAdmin) => ({
  user_id: user,
  nombre,
  reintegrado,
  motivo: reintegrado ? 'reintegrado' : 'pago_anulado',
  mensaje_socio: mensajeSocio,
  mensaje_admin: mensajeAdmin,
})
const DEVUELTO_TXT = 'CrossFit de las 19:00 del 22/10/2026 fue cancelada por el gimnasio. Te devolvimos el crédito (vence el 20/11/2026).'
const ANULADO_TXT = 'La clase del 22/10/2026 se canceló. Ese crédito no se reintegró porque pertenecía a un pago anulado. Consultá con el gimnasio.'

let db
const rpc = vi.fn()
const invoke = vi.fn()

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (tabla) => {
      const q = { filtros: [] }
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (c, v) => (q.filtros.push([c, v]), chain),
        then: (resolve, reject) => {
          let data = []
          if (tabla === 'classes') data = [{ ...CLASE, disciplines: { show_in_agenda: true } }]
          else if (tabla === 'bookings') data = db.filter((r) => q.filtros.every(([c, v]) => r[c] === v))
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        },
      }
      return chain
    },
    rpc: (...args) => rpc(...args),
    functions: { invoke: (...args) => invoke(...args) },
  },
}))
vi.mock('../../utils/anotarSocios', () => ({
  fetchSociosParaAnotar: vi.fn().mockResolvedValue([]),
  fetchCreditosVigentesPorSocio: vi.fn().mockResolvedValue(new Map()),
}))

import Clases from '../../pages/Clases'

let alertas
let confirmaciones
beforeEach(() => {
  db = [reserva('b1', 'u1', 'Ana'), reserva('b2', 'u2', 'Beto'), reserva('b3', 'u3', 'Caro')]
  alertas = []
  confirmaciones = []
  rpc.mockReset()
  invoke.mockReset().mockResolvedValue({ data: null, error: null })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-22T15:00:00Z'))
  vi.spyOn(window, 'alert').mockImplementation((m) => alertas.push(m))
  vi.spyOn(window, 'confirm').mockImplementation((m) => (confirmaciones.push(m), true))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function abrir() {
  render(<Clases />)
  await screen.findByText('3 / 20 inscriptos')
}

describe('Clases -- "Quitar de la clase" (cancela el gimnasio)', () => {
  it('llama a admin_quitar_de_clase, le manda el push al socio y le muestra a Seba qué pasó con el crédito', async () => {
    const mensajeSocio = 'El gimnasio te quitó de la clase del 22/10/2026. Ese crédito no se reintegró porque pertenecía a un pago anulado. Consultá con el gimnasio.'
    const mensajeAdmin = 'Ana: NO se devolvió el crédito, era de un pago anulado (del 02/10/2026). Si querés, cargáselo a mano con los créditos manuales.'
    rpc.mockResolvedValue({ data: resultado('u1', 'Ana', false, mensajeSocio, mensajeAdmin), error: null })
    await abrir()

    fireEvent.click(screen.getByRole('button', { name: /Ver Inscriptos/ }))
    const fila = (await screen.findByText('Ana')).closest('li')
    fireEvent.click(within(fila).getByRole('button', { name: 'Quitar de la clase' }))

    await waitFor(() => expect(alertas).toHaveLength(1))
    expect(rpc).toHaveBeenCalledWith('admin_quitar_de_clase', {
      p_user_id: 'u1',
      p_class_id: 'c1',
      p_booking_date: '2026-10-22',
      p_reason: 'Quitado por el admin desde el panel',
    })
    expect(rpc).not.toHaveBeenCalledWith('admin_cancel_booking', expect.anything())
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('send-push', {
      body: { title: 'Cambio en tu reserva', body: mensajeSocio, audience: 'users', targetUserIds: ['u1'] },
    })
    expect(alertas[0]).toBe(`Socio quitado de la clase.\n\n${mensajeAdmin}`)
  })

  it('si la RPC falla, lo dice y no manda ningún push', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'network' } })
    await abrir()
    fireEvent.click(screen.getByRole('button', { name: /Ver Inscriptos/ }))
    const fila = (await screen.findByText('Ana')).closest('li')
    fireEvent.click(within(fila).getByRole('button', { name: 'Quitar de la clase' }))

    await waitFor(() => expect(alertas).toEqual(['No se pudo quitar al socio: network']))
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('Clases -- "Cancelar clase" (cancela el gimnasio)', () => {
  it('confirma sin prometer el reintegro, usa la v2, manda un push por cada texto y muestra el resumen', async () => {
    rpc.mockResolvedValue({
      data: {
        cancelados: 3,
        reintegrados: 2,
        no_reintegrados: [resultado('u3', 'Caro', false, ANULADO_TXT, 'Caro: NO se devolvió el crédito, era de un pago anulado (del 02/10/2026). Si querés, cargáselo a mano con los créditos manuales.')],
        detalle: [
          resultado('u1', 'Ana', true, DEVUELTO_TXT, 'Ana: crédito devuelto (vence el 20/11/2026).'),
          resultado('u2', 'Beto', true, DEVUELTO_TXT, 'Beto: crédito devuelto (vence el 20/11/2026).'),
          resultado('u3', 'Caro', false, ANULADO_TXT, 'Caro: NO se devolvió el crédito, era de un pago anulado (del 02/10/2026). Si querés, cargáselo a mano con los créditos manuales.'),
        ],
      },
      error: null,
    })
    await abrir()

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar clase' }))

    await waitFor(() => expect(alertas).toHaveLength(1))
    expect(confirmaciones[0]).toContain('Se intenta devolver el crédito a cada anotado de ese día')
    expect(confirmaciones[0]).not.toContain('Se reintegra el crédito a todos')
    expect(rpc).toHaveBeenCalledWith('admin_cancelar_clase_dia_v2', { p_class_id: 'c1', p_occurrence_date: '2026-10-22' })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledWith('send-push', {
      body: { title: 'Clase cancelada', body: DEVUELTO_TXT, audience: 'users', targetUserIds: ['u1', 'u2'] },
    })
    expect(invoke).toHaveBeenCalledWith('send-push', {
      body: { title: 'Clase cancelada', body: ANULADO_TXT, audience: 'users', targetUserIds: ['u3'] },
    })
    expect(alertas[0]).toContain('Crédito devuelto a 2 de 3.')
    expect(alertas[0]).toContain('NO devueltos (1):')
    expect(alertas[0]).not.toContain('Ya te reintegramos')
  })
})
