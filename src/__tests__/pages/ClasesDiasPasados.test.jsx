import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'

// Pantalla Clases -- días pasados + calendario. Reloj congelado el jueves
// 22/10/2026 a las 12:00 de Argentina (15:00Z). Tira: 15/10 ... 28/10.
// "Ayer" = miércoles 21/10. Anteayer (solo lectura) = martes 20/10.

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

const TURNO_NOCHE = {
  id: '56e73799-640c-478c-8b55-69b0cc2d816e',
  title: 'CrossFit - Turno Noche',
  discipline_id: 'd-cf',
  instructor: 'Seba',
  start_time: '20:00:00',
  end_time: '21:00:00',
  capacity: 20,
  days_of_week: [1, 3, 5], // HOY es lun/mié/vie
  created_at: '2026-07-01T12:00:00Z',
}
const BOXEO_MARTES = { ...TURNO_NOCHE, id: 'boxeo-mar', title: 'Boxeo Martes', days_of_week: [2], start_time: '18:00:00', end_time: '19:00:00' }
const NUEVA = { ...TURNO_NOCHE, id: 'nueva', title: 'Clase Nueva', days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '10:00:00', end_time: '11:00:00', created_at: '2026-10-22T12:00:00Z' }
const LUNES_CANCELADA = { ...TURNO_NOCHE, id: 'lunes-cancelada', title: 'Kick Lunes', days_of_week: [1], start_time: '07:00:00', end_time: '08:00:00' }
const CLASES = [TURNO_NOCHE, BOXEO_MARTES, NUEVA, LUNES_CANCELADA]

const reserva = (id, classId, fecha) => ({
  id,
  class_id: classId,
  booking_date: fecha,
  user_id: `u-${id}`,
  attended: null,
  profiles: { full_name: `Socio ${id}`, dni: null },
})

let db
const estado = { fallarCancelaciones: false, updates: [] }

function filtrar(filas, q) {
  return filas.filter((f) =>
    q.filtros.every(([op, col, val]) => {
      if (op === 'eq') return f[col] === val
      if (op === 'gte') return f[col] >= val
      if (op === 'lte') return f[col] <= val
      if (op === 'in') return val.includes(f[col])
      return true
    }),
  )
}

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (tabla) => {
      const q = { filtros: [], update: null, desde: null, hasta: null, limite: null }
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: (n) => ((q.limite = n), chain),
        range: (desde, hasta) => ((q.desde = desde), (q.hasta = hasta), chain),
        update: (valores) => ((q.update = valores), chain),
        eq: (c, v) => (q.filtros.push(['eq', c, v]), chain),
        gte: (c, v) => (q.filtros.push(['gte', c, v]), chain),
        lte: (c, v) => (q.filtros.push(['lte', c, v]), chain),
        in: (c, v) => (q.filtros.push(['in', c, v]), chain),
        then: (resolve, reject) => {
          let respuesta
          if (tabla === 'classes') {
            respuesta = { data: CLASES.map((c) => ({ ...c, disciplines: { show_in_agenda: true } })), error: null }
          } else if (q.update) {
            estado.updates.push({ tabla, valores: q.update })
            respuesta = { data: [], error: null }
          } else if (tabla === 'class_occurrence_cancellations' && estado.fallarCancelaciones) {
            respuesta = { data: null, error: { message: 'network' } }
          } else {
            let filas = filtrar(db[tabla] ?? [], q)
            if (tabla === 'bookings' && q.limite) filas = [...filas].sort((a, b) => a.booking_date.localeCompare(b.booking_date)).slice(0, q.limite)
            if (q.desde !== null) filas = filas.slice(q.desde, q.hasta + 1)
            respuesta = { data: filas, error: null }
          }
          return Promise.resolve(respuesta).then(resolve, reject)
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

import { supabase } from '../../lib/supabaseClient'
import Clases from '../../pages/Clases'

const chips = () => screen.getAllByRole('button').filter((b) => /^\D+\d{1,2}$/.test(b.textContent.trim()) && !/inscriptos/i.test(b.textContent))
const chip = (texto) => chips().find((b) => b.textContent.trim() === texto)
const tarjeta = (titulo) => screen.getByText(titulo).closest('div.rounded-2xl')

async function abrirEn(instante, timers = ['Date']) {
  vi.useFakeTimers({ toFake: timers })
  vi.setSystemTime(new Date(instante))
  render(<Clases />)
  await screen.findByText(/inscriptos/)
}

beforeEach(() => {
  db = {
    bookings: [
      reserva('n1', TURNO_NOCHE.id, '2026-10-20'), // martes: hoy Turno Noche no se dicta los martes
      reserva('n2', TURNO_NOCHE.id, '2026-10-20'),
      reserva('b-ayer', BOXEO_MARTES.id, '2026-10-21'), // miércoles: Boxeo hoy es solo martes
      reserva('n-5', TURNO_NOCHE.id, '2026-10-05'),
    ],
    class_occurrence_cancellations: [{ id: 'oc1', class_id: LUNES_CANCELADA.id, occurrence_date: '2026-10-20' }],
  }
  estado.fallarCancelaciones = false
  estado.updates = []
  vi.clearAllMocks()
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  vi.spyOn(window, 'confirm').mockImplementation(() => true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Clases -- tira de 14 días (7 anteriores + hoy + 6 siguientes)', () => {
  it('arranca en hoy - 7 y abre en Hoy', async () => {
    await abrirEn('2026-10-22T15:00:00Z')
    const tira = chips()
    expect(tira).toHaveLength(14)
    expect(tira[0].textContent).toBe('jue15')
    expect(tira[6].textContent).toBe('Ayer21')
    expect(tira[7].textContent).toBe('Hoy22')
    expect(tira[7].className).toContain('bg-greenfit-primary') // elegido
    expect(tira[13].textContent).toBe('mié28')
  })

  it('a medianoche se actualiza sola: "Hoy" pasa al 23 y el día elegido no salta', async () => {
    await abrirEn('2026-10-23T02:59:30Z', ['Date', 'setInterval', 'clearInterval']) // jueves 23:59:30
    expect(chip('Hoy22')).toBeTruthy()

    act(() => vi.advanceTimersByTime(60_000))

    await waitFor(() => expect(chip('Hoy23')).toBeTruthy())
    expect(chip('Ayer22').className).toContain('bg-greenfit-primary') // seguía viendo el 22, ahora "Ayer"
    expect(chips()[0].textContent).toBe('vie16')
  })
})

describe('Clases -- días anteriores a "ayer" (solo lectura, armados por reservas)', () => {
  it('martes 20/10: Turno Noche aparece por sus reservas con aviso, la cancelada se marca y la creada después no está', async () => {
    await abrirEn('2026-10-22T15:00:00Z')
    fireEvent.click(chip('mar20'))

    expect(await screen.findByText(/día pasado, solo lectura/)).toBeInTheDocument()
    const noche = tarjeta('CrossFit - Turno Noche')
    expect(within(noche).getByText('2 / 20 inscriptos')).toBeInTheDocument()
    expect(within(noche).getByText(/Hoy esta clase se dicta lun, mié y vie/)).toBeInTheDocument()
    expect(within(tarjeta('Boxeo Martes')).getByText('0 / 20 inscriptos')).toBeInTheDocument()
    expect(within(tarjeta('Kick Lunes')).getByText('Cancelada este día')).toBeInTheDocument()
    expect(screen.queryByText('Clase Nueva')).toBeNull() // creada el 22/10

    // Solo lectura: ni Editar ni Cancelar.
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancelar clase' })).toBeNull()
  })

  it('el modal de inscriptos de un día pasado no deja anotar, quitar ni marcar asistencia', async () => {
    await abrirEn('2026-10-22T15:00:00Z')
    fireEvent.click(chip('mar20'))
    await screen.findByText(/día pasado, solo lectura/)
    fireEvent.click(within(tarjeta('CrossFit - Turno Noche')).getByRole('button', { name: /Ver Inscriptos/ }))

    expect(await screen.findByText(/Día pasado: solo lectura/)).toBeInTheDocument()
    expect(screen.getByText('Socio n1')).toBeInTheDocument()
    expect(screen.queryByLabelText('Buscar socio para anotar')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Marcar Asistió' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Marcar Ausente' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Quitar de la clase' })).toBeNull()
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(estado.updates).toEqual([])
  })
})

describe('Clases -- "Ayer" queda exactamente como antes', () => {
  it('sin aviso de solo lectura, con Editar/Cancelar, solo plantillas (no suma la reserva de Boxeo del miércoles)', async () => {
    await abrirEn('2026-10-22T15:00:00Z')
    fireEvent.click(chip('Ayer21'))

    await screen.findByText('CrossFit - Turno Noche')
    expect(screen.queryByText(/solo lectura/)).toBeNull()
    expect(screen.queryByText('Boxeo Martes')).toBeNull() // hoy no se dicta los miércoles: igual que antes
    expect(screen.getByText('Clase Nueva')).toBeInTheDocument() // igual que antes: sin filtro por fecha de creación
    expect(screen.getAllByRole('button', { name: 'Editar' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Cancelar clase' }).length).toBeGreaterThan(0)
  })
})

describe('Clases -- errores visibles y calendario', () => {
  it('si fallan las cancelaciones del día, lo avisa y deja reintentar (la grilla se ve igual)', async () => {
    estado.fallarCancelaciones = true
    await abrirEn('2026-10-22T15:00:00Z')
    expect(await screen.findByText(/No se pudieron cargar las cancelaciones de este día/)).toBeInTheDocument()
    expect(screen.getByText('Clase Nueva')).toBeInTheDocument() // la grilla de hoy (jueves) se ve igual

    estado.fallarCancelaciones = false
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    await waitFor(() => expect(screen.queryByText(/No se pudieron cargar las cancelaciones/)).toBeNull())
  })

  it('"Ver calendario" -> tocar el 5/10 lo abre en el panel (fuera de la tira, en solo lectura)', async () => {
    await abrirEn('2026-10-22T15:00:00Z')
    fireEvent.click(screen.getByRole('button', { name: /Ver calendario/ }))
    const calendario = await screen.findByRole('dialog', { name: 'Calendario de inscriptos' })
    fireEvent.click(await within(calendario).findByRole('button', { name: '5 de Octubre 2026: 1 inscripto' }))

    expect(screen.queryByRole('dialog', { name: 'Calendario de inscriptos' })).toBeNull()
    expect(await screen.findByText(/día pasado, solo lectura/)).toBeInTheDocument()
    expect(screen.getByText('05/10')).toBeInTheDocument()
    expect(within(tarjeta('CrossFit - Turno Noche')).getByText('1 / 20 inscriptos')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Volver a hoy' }))
    await waitFor(() => expect(chip('Hoy22').className).toContain('bg-greenfit-primary'))
  })
})
