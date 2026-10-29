import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

// Pedido de Seba: una clase especial de un día se repetía todas las semanas.
// Con fecha_unica, en la tira de Clases aparece SOLO su día.

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

const fechaStr = (offset) => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const dow = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.getDay()
}
const AYER = fechaStr(-1)
const MANANA = fechaStr(1)

const fila = (id, title, extra) => ({
  id,
  title,
  discipline_id: 'd1',
  instructor: 'Seba',
  start_time: '19:00:00',
  end_time: '20:00:00',
  capacity: 20,
  disciplines: { show_in_agenda: true },
  ...extra,
})
const CLASES = [
  fila('c-semanal', 'CrossFit', { days_of_week: [0, 1, 2, 3, 4, 5, 6], fecha_unica: null }),
  fila('c-manana', 'Clase especial', { days_of_week: [dow(1)], fecha_unica: MANANA }),
  fila('c-ayer', 'Especial de ayer', { days_of_week: [dow(-1)], fecha_unica: AYER }),
]

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (tabla) => {
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: () => chain,
        in: () => chain,
        then: (resolve, reject) =>
          Promise.resolve({ data: tabla === 'classes' ? CLASES : [], error: null }).then(resolve, reject),
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

// Botones del selector de días, en orden: hoy-7 ... hoy-2, Ayer, Hoy, Mañana, +2, ...
const botonesDia = () =>
  screen.getAllByRole('button').filter((b) => /^\D+\d{1,2}$/.test(b.textContent.trim()) && !/inscriptos/i.test(b.textContent))
const IDX_HACE_6 = 1
const IDX_AYER = 6
const IDX_HOY = 7
const IDX_MANANA = 8
const IDX_EN_6 = 13

const titulos = () => ['CrossFit', 'Clase especial', 'Especial de ayer'].filter((t) => screen.queryByText(t))
const tarjeta = (titulo) => screen.getByText(titulo).closest('.rounded-2xl')

async function abrirEn(indice) {
  fireEvent.click(botonesDia()[indice])
  await waitFor(() => expect(screen.queryByText('Cargando clases...')).toBeNull())
}

beforeEach(() => {
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('Clases (admin) -- clases de una sola vez', () => {
  it('hoy no aparece ninguna de una sola vez: solo la semanal', async () => {
    render(<Clases />)
    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    expect(titulos()).toEqual(['CrossFit'])
  })

  it('en su fecha aparece, con el badge "Una sola vez"', async () => {
    render(<Clases />)
    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    await abrirEn(IDX_MANANA)
    expect(titulos()).toEqual(['CrossFit', 'Clase especial'])
    expect(within(tarjeta('Clase especial')).getByText(/Una sola vez · \d{2}\/\d{2}/)).toBeTruthy()
    expect(within(tarjeta('Clase especial')).getByRole('button', { name: 'Editar' })).toBeTruthy()
  })

  it('una semana después de su fecha NO aparece (el bug de Seba)', async () => {
    render(<Clases />)
    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    // hoy+6 es el mismo día de semana que ayer: la de ayer no vuelve a aparecer.
    await abrirEn(IDX_EN_6)
    expect(titulos()).toEqual(['CrossFit'])
  })

  it('un día pasado (solo lectura) del mismo día de semana tampoco la muestra', async () => {
    render(<Clases />)
    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    // hoy-6 es el mismo día de semana que mañana.
    await abrirEn(IDX_HACE_6)
    expect(titulos()).toEqual(['CrossFit'])
  })

  it('la de ayer (ya pasó) se ve, pero sin el lápiz de Editar', async () => {
    render(<Clases />)
    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    await abrirEn(IDX_AYER)
    expect(titulos()).toEqual(['CrossFit', 'Especial de ayer'])
    expect(within(tarjeta('Especial de ayer')).queryByRole('button', { name: 'Editar' })).toBeNull()
    expect(within(tarjeta('CrossFit')).getByRole('button', { name: 'Editar' })).toBeTruthy()
  })

  it('volver a hoy la deja de mostrar', async () => {
    render(<Clases />)
    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    await abrirEn(IDX_MANANA)
    await abrirEn(IDX_HOY)
    expect(titulos()).toEqual(['CrossFit'])
  })
})
