import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// Se mockean SOLO las dos consultas; el resto de utils/calendarioClases
// (fechas, semanas del mes) es el real.
vi.mock('../../utils/calendarioClases', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchResumenMes: vi.fn(),
  fetchPrimeraReserva: vi.fn(),
}))

import { fetchPrimeraReserva, fetchResumenMes } from '../../utils/calendarioClases'
import CalendarioClases from '../../components/CalendarioClases'

const DATOS = {
  '2026-10-01': { inscriptosPorDia: new Map([['2026-10-05', 12], ['2026-10-22', 1]]), diasConCancelacion: new Set(['2026-10-09']) },
  '2026-09-01': { inscriptosPorDia: new Map([['2026-09-15', 7]]), diasConCancelacion: new Set() },
  '2026-08-01': { inscriptosPorDia: new Map([['2026-08-18', 21]]), diasConCancelacion: new Set() },
  '2026-07-01': { inscriptosPorDia: new Map([['2026-07-03', 4]]), diasConCancelacion: new Set() },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fetchResumenMes.mockImplementation(async (mes) => DATOS[mes] ?? { inscriptosPorDia: new Map(), diasConCancelacion: new Set() })
  fetchPrimeraReserva.mockResolvedValue('2026-07-03')
})

const abrir = (props = {}) =>
  render(<CalendarioClases hoy="2026-10-22" fechaSeleccionada="2026-10-22" onElegirDia={vi.fn()} onCerrar={vi.fn()} {...props} />)

describe('CalendarioClases (Clases > "Ver calendario")', () => {
  it('muestra el mes con los inscriptos de cada día y la marca de clase cancelada', async () => {
    abrir()
    expect(await screen.findByRole('button', { name: '5 de Octubre 2026: 12 inscriptos' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '22 de Octubre 2026: 1 inscripto' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '9 de Octubre 2026: 0 inscriptos, con clase cancelada' })).toBeInTheDocument()
    expect(fetchResumenMes).toHaveBeenCalledWith('2026-10-01')
  })

  it('se navega hacia atrás hasta el mes de la primera reserva, y hacia adelante hasta hoy + 6', async () => {
    abrir()
    await screen.findByText('Octubre 2026')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mes anterior' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Mes siguiente' })).toBeDisabled() // 22/10 + 6 = 28/10, sigue en octubre

    fireEvent.click(screen.getByRole('button', { name: 'Mes anterior' }))
    expect(await screen.findByRole('button', { name: '15 de Septiembre 2026: 7 inscriptos' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mes anterior' }))
    expect(await screen.findByRole('button', { name: '18 de Agosto 2026: 21 inscriptos' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mes anterior' }))
    expect(await screen.findByRole('button', { name: '3 de Julio 2026: 4 inscriptos' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mes anterior' })).toBeDisabled()
  })

  it('cerca de fin de mes se puede avanzar al mes siguiente (hoy + 6 cae en noviembre)', async () => {
    abrir({ hoy: '2026-10-28', fechaSeleccionada: '2026-10-28' })
    await screen.findByText('Octubre 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Mes siguiente' }))
    expect(await screen.findByText('Noviembre 2026')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mes siguiente' })).toBeDisabled()
  })

  it('tocar un día lo abre en el panel (onElegirDia con su fecha)', async () => {
    const onElegirDia = vi.fn()
    abrir({ onElegirDia })
    fireEvent.click(await screen.findByRole('button', { name: '5 de Octubre 2026: 12 inscriptos' }))
    expect(onElegirDia).toHaveBeenCalledWith('2026-10-05')
  })

  it('si falla la consulta del mes, lo dice y deja reintentar', async () => {
    fetchResumenMes.mockRejectedValueOnce(new Error('network'))
    abrir()
    expect(await screen.findByText(/No se pudieron cargar los inscriptos de este mes/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByRole('button', { name: '5 de Octubre 2026: 12 inscriptos' })).toBeInTheDocument()
    expect(fetchResumenMes).toHaveBeenCalledTimes(2)
  })

  it('si falla la búsqueda de la primera reserva, avisa y no limita hacia atrás', async () => {
    fetchPrimeraReserva.mockRejectedValueOnce(new Error('network'))
    abrir()
    expect(await screen.findByText(/No se pudo averiguar la primera reserva/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mes anterior' })).toBeEnabled()
  })
})
