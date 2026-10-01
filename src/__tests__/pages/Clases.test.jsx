import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'

// Bug real (2026-10-01), pantalla Clases del panel: al cambiar de día, los
// inscriptos del día elegido podían quedar reemplazados por los de OTRO día:
//   1) al volver al día con el que se abrió la pantalla (hoy) no se volvían a
//      pedir los inscriptos -> HOY mostraba los de mañana ("0, 0, 0");
//   2) una respuesta atrasada de otro día pisaba la del día elegido.
// Con la lista equivocada, "Ver inscriptos" mostraba socios de otro día y
// marcar asistencia escribía sobre la reserva de ese otro día.

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

const fechaStr = (offset) => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const HOY = fechaStr(0)
const MANANA = fechaStr(1)
const PASADO = fechaStr(2)

const CLASE = {
  id: 'c1',
  title: 'CrossFit',
  discipline_id: 'd1',
  instructor: 'Seba',
  start_time: '19:00:00',
  end_time: '20:00:00',
  capacity: 20,
  days_of_week: [0, 1, 2, 3, 4, 5, 6],
  disciplines: { show_in_agenda: true },
}

// "Base de datos" simulada: cada reserva con su fecha real.
const reserva = (id, fecha, user, nombre) => ({
  id,
  booking_date: fecha,
  user_id: user,
  class_id: 'c1',
  attended: null,
  profiles: { full_name: nombre, dni: `dni-${user}` },
})
let db
const estadoMock = { pedidos: [], demoras: {}, updates: [], mezclarEnHoy: false, fallarInscriptos: null }

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (tabla) => {
      const q = { filtros: {}, update: null }
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        update: (valores) => ((q.update = valores), chain),
        eq: (col, val) => ((q.filtros[col] = val), chain),
        then: (resolve, reject) => {
          let promesa
          if (tabla === 'classes') {
            promesa = Promise.resolve({ data: [CLASE], error: null })
          } else if (tabla === 'bookings' && q.update) {
            // UPDATE real: solo toca las filas que cumplen TODOS los filtros.
            estadoMock.updates.push({ ...q.filtros, valores: q.update })
            const filas = db.filter((r) => Object.entries(q.filtros).every(([col, val]) => r[col] === val))
            for (const f of filas) Object.assign(f, q.update)
            promesa = Promise.resolve({ data: filas.map((f) => ({ id: f.id })), error: null })
          } else if (tabla === 'bookings') {
            const fecha = q.filtros.booking_date
            estadoMock.pedidos.push(fecha)
            const ms = estadoMock.demoras[fecha] ?? 0
            promesa = new Promise((r) =>
              setTimeout(() => {
                if (estadoMock.fallarInscriptos === fecha) return r({ data: null, error: { message: 'network' } })
                let filas = db.filter((f) => f.booking_date === fecha)
                // Simula el estado del bug: la lista de HOY llega "mezclada"
                // con una reserva que en realidad es de mañana.
                if (estadoMock.mezclarEnHoy && fecha === HOY) filas = [...filas, ...db.filter((f) => f.booking_date === MANANA)]
                // Igual que el SELECT real: las filas llegan SIN booking_date.
                r({
                  data: filas.map((f) => {
                    const copia = { ...f }
                    delete copia.booking_date
                    return copia
                  }),
                  error: null,
                })
              }, ms),
            )
          } else {
            promesa = Promise.resolve({ data: [], error: null })
          }
          return promesa.then(resolve, reject)
        },
      }
      return chain
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    functions: { invoke: vi.fn() },
  },
}))
vi.mock('../../utils/anotarSocios', () => ({
  fetchSociosParaAnotar: vi.fn().mockResolvedValue([]),
  fetchCreditosVigentesPorSocio: vi.fn().mockResolvedValue(new Map()),
}))

import Clases from '../../pages/Clases'

const conteo = () => screen.queryByText(/\d+ \/ 20 inscriptos/)?.textContent ?? null
// Botones del selector de días, en orden: Ayer, Hoy, Mañana, +2, ...
const botonesDia = () =>
  screen.getAllByRole('button').filter((b) => /^\D+\d{1,2}$/.test(b.textContent.trim()) && !/inscriptos/i.test(b.textContent))
const elegirDia = (indice) => fireEvent.click(botonesDia()[indice])
const AYER = 0
const IDX_HOY = 1
const IDX_MANANA = 2
const IDX_PASADO = 3
const esperar = (ms) => act(() => new Promise((r) => setTimeout(r, ms)))

async function abrir() {
  render(<Clases />)
  await waitFor(() => expect(conteo()).toBe('4 / 20 inscriptos'))
}

beforeEach(() => {
  db = [
    reserva('b-h1', HOY, 'u1', 'Ana Hoy'),
    reserva('b-h2', HOY, 'u2', 'Beto Hoy'),
    reserva('b-h3', HOY, 'u3', 'Caro Hoy'),
    reserva('b-h4', HOY, 'u4', 'Dani Hoy'),
    reserva('b-m1', MANANA, 'u9', 'Zoe Mañana'),
    reserva('b-p1', PASADO, 'u7', 'Pepe Pasado'),
    reserva('b-p2', PASADO, 'u8', 'Quique Pasado'),
  ]
  estadoMock.pedidos = []
  estadoMock.demoras = {}
  estadoMock.updates = []
  estadoMock.mezclarEnHoy = false
  estadoMock.fallarInscriptos = null
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('Clases (admin) -- inscriptos del día elegido', () => {
  it('hoy -> mañana -> hoy: al VOLVER a hoy se vuelven a pedir sus inscriptos (antes quedaban los de mañana)', async () => {
    await abrir()

    elegirDia(IDX_MANANA)
    await waitFor(() => expect(conteo()).toBe('1 / 20 inscriptos'))

    elegirDia(IDX_HOY)
    await waitFor(() => expect(conteo()).toBe('4 / 20 inscriptos'))
    expect(estadoMock.pedidos).toEqual([HOY, MANANA, HOY])
  })

  it('una respuesta ATRASADA de otro día no pisa los inscriptos del día elegido', async () => {
    await abrir()
    estadoMock.demoras[MANANA] = 250 // mañana responde tarde

    elegirDia(IDX_MANANA)
    await esperar(20)
    elegirDia(IDX_PASADO) // responde enseguida
    await waitFor(() => expect(conteo()).toBe('2 / 20 inscriptos'))

    await esperar(350) // ya llegó la respuesta atrasada de mañana
    expect(conteo()).toBe('2 / 20 inscriptos')
  })

  it('mientras no llega la respuesta del día elegido se ve "Cargando", nunca la grilla de otro día', async () => {
    await abrir()
    estadoMock.demoras[MANANA] = 200

    elegirDia(IDX_MANANA)
    // En el mismo instante del cambio: ni un cuadro con los 4 de hoy bajo "Mañana".
    expect(conteo()).toBeNull()
    expect(screen.getByText('Cargando clases...')).toBeInTheDocument()

    await waitFor(() => expect(conteo()).toBe('1 / 20 inscriptos'))
  })

  it('si falla la carga de inscriptos del día elegido, avisa con "Reintentar" en vez de mostrar otro día', async () => {
    await abrir()
    estadoMock.fallarInscriptos = MANANA

    elegirDia(IDX_MANANA)
    await waitFor(() => expect(screen.getByText(/No se pudieron cargar los inscriptos de este día/)).toBeInTheDocument())
    expect(conteo()).toBeNull()

    // Reintentar pide el día ELEGIDO (mañana), no el inicial.
    estadoMock.fallarInscriptos = null
    fireEvent.click(screen.getByText('Reintentar'))
    await waitFor(() => expect(conteo()).toBe('1 / 20 inscriptos'))
    expect(estadoMock.pedidos.at(-1)).toBe(MANANA)
  })

  it('"Ayer" también se pide y se muestra bien', async () => {
    db.push(reserva('b-a1', fechaStr(-1), 'u5', 'Eva Ayer'))
    await abrir()
    elegirDia(AYER)
    await waitFor(() => expect(conteo()).toBe('1 / 20 inscriptos'))
  })
})

describe('Clases (admin) -- "Ver inscriptos"', () => {
  it('muestra solo los inscriptos del día elegido, también después de ir y volver', async () => {
    await abrir()
    elegirDia(IDX_MANANA)
    await waitFor(() => expect(conteo()).toBe('1 / 20 inscriptos'))
    elegirDia(IDX_HOY)
    await waitFor(() => expect(conteo()).toBe('4 / 20 inscriptos'))

    fireEvent.click(screen.getByText('Ver Inscriptos'))
    expect(await screen.findByText('Ana Hoy')).toBeInTheDocument()
    expect(screen.getByText('Dani Hoy')).toBeInTheDocument()
    expect(screen.queryByText('Zoe Mañana')).toBeNull()
  })

  it('cambiar de día cierra el modal (no queda abierto sobre la lista de otro día)', async () => {
    await abrir()
    fireEvent.click(screen.getByText('Ver Inscriptos'))
    expect(await screen.findByText('Ana Hoy')).toBeInTheDocument()

    elegirDia(IDX_MANANA)
    expect(screen.queryByText('Ana Hoy')).toBeNull()
    await waitFor(() => expect(conteo()).toBe('1 / 20 inscriptos'))
    // Sigue cerrado al llegar los datos de mañana: no se reabre solo.
    expect(screen.queryByText('Zoe Mañana')).toBeNull()
  })
})

// El caso más grave del bug: con la lista de otro día en pantalla, marcar
// "Asistió" escribía sobre la reserva de ese otro día.
describe('Clases (admin) -- marcar asistencia usa SIEMPRE la reserva del día que se ve', () => {
  const marcarAsistio = (nombre) => {
    const fila = screen.getByText(nombre).closest('li') ?? screen.getByText(nombre).closest('div')
    const botones = screen.getAllByLabelText('Marcar Asistió')
    const boton = botones.find((b) => fila.contains(b)) ?? botones[0]
    fireEvent.click(boton)
  }

  it('caso normal: marca la reserva de HOY y la consulta exige la fecha y la clase que se ven', async () => {
    await abrir()
    fireEvent.click(screen.getByText('Ver Inscriptos'))
    await screen.findByText('Ana Hoy')

    marcarAsistio('Ana Hoy')

    await waitFor(() => expect(estadoMock.updates).toHaveLength(1))
    expect(estadoMock.updates[0]).toEqual({ id: 'b-h1', booking_date: HOY, class_id: 'c1', valores: { attended: true } })
    expect(db.find((r) => r.id === 'b-h1').attended).toBe(true)
    // Nada de otro día cambió.
    expect(db.filter((r) => r.booking_date !== HOY).every((r) => r.attended === null)).toBe(true)
    expect(window.alert).not.toHaveBeenCalled()
  })

  it('después de ir a mañana y volver a hoy, marcar asistencia sigue escribiendo sobre la reserva de HOY', async () => {
    await abrir()
    elegirDia(IDX_MANANA)
    await waitFor(() => expect(conteo()).toBe('1 / 20 inscriptos'))
    elegirDia(IDX_HOY)
    await waitFor(() => expect(conteo()).toBe('4 / 20 inscriptos'))

    fireEvent.click(screen.getByText('Ver Inscriptos'))
    await screen.findByText('Beto Hoy')
    marcarAsistio('Beto Hoy')

    await waitFor(() => expect(db.find((r) => r.id === 'b-h2').attended).toBe(true))
    expect(estadoMock.updates[0]).toMatchObject({ id: 'b-h2', booking_date: HOY })
    expect(db.find((r) => r.id === 'b-m1').attended).toBeNull()
  })

  it('aunque en la lista de HOY quede MEZCLADA una reserva de mañana, marcarla NO modifica la reserva de mañana', async () => {
    estadoMock.mezclarEnHoy = true // estado del bug: la lista de hoy trae también la reserva de mañana
    render(<Clases />)
    await waitFor(() => expect(conteo()).toBe('5 / 20 inscriptos'))

    fireEvent.click(screen.getByText('Ver Inscriptos'))
    await screen.findByText('Zoe Mañana')
    marcarAsistio('Zoe Mañana')

    // La consulta salió con la fecha de HOY como condición...
    await waitFor(() => expect(estadoMock.updates).toHaveLength(1))
    expect(estadoMock.updates[0]).toMatchObject({ id: 'b-m1', booking_date: HOY, class_id: 'c1' })
    // ...así que el servidor no tocó ninguna fila: la reserva de mañana queda intacta,
    expect(db.find((r) => r.id === 'b-m1').attended).toBeNull()
    expect(db.every((r) => r.attended === null)).toBe(true)
    // y Seba se entera de que no se aplicó.
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('No se pudo actualizar la asistencia. Intentá nuevamente.'))
  })
})
