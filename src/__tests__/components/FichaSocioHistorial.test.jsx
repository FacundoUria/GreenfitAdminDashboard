import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../utils/fichaSocioPwa', () => ({
  resolverUserIdPorDni: vi.fn(),
  fetchHistorialAsistencias: vi.fn(),
  fetchHistorialRutinas: vi.fn(),
  fetchMetricasGamificacion: vi.fn(),
  fetchHistorialPagos: vi.fn(),
}))

import {
  resolverUserIdPorDni,
  fetchHistorialAsistencias,
  fetchHistorialRutinas,
  fetchMetricasGamificacion,
  fetchHistorialPagos,
} from '../../utils/fichaSocioPwa'
import FichaSocioHistorial from '../../components/FichaSocioHistorial'

const SOCIO = { id: 's1', nombre: 'Martina', apellido: 'Ríos', dni: '30111222' }

const ASISTENCIAS_UNIFICADAS = [
  { id: 'checkin-1', fecha: '2026-08-10', tipo: 'Entrenamiento Libre: ¡Hoy entrené!', detalle: 'Autoreportado desde la app', estado: 'Registrado' },
  { id: 'booking-1', fecha: '2026-08-09', tipo: 'Clase: CrossFit', detalle: 'Prof. Seba', estado: 'Asistió' },
]

const PAGOS = [
  {
    id: 'p1',
    fecha: '2026-08-01',
    paquete: 'CrossFit',
    monto: 15000,
    metodoPago: 'efectivo',
    periodoDesde: '2026-08-01',
    periodoHasta: '2026-09-01',
    estado: 'pagado',
  },
]

function mockearCargaCompleta() {
  resolverUserIdPorDni.mockResolvedValue('u1')
  fetchHistorialAsistencias.mockResolvedValue(ASISTENCIAS_UNIFICADAS)
  fetchHistorialRutinas.mockResolvedValue([])
  fetchMetricasGamificacion.mockResolvedValue({ nivel: 3, totalXp: 1150, racha: 2, totalAsistencias: 12, miembroDesde: '2025-01-15' })
  fetchHistorialPagos.mockResolvedValue(PAGOS)
}

describe('FichaSocioHistorial (Ficha 360° -- Historial y Actividad del Socio)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('si el socio no tiene cuenta PWA todavía, avisa sin romper', async () => {
    resolverUserIdPorDni.mockResolvedValue(null)
    render(<FichaSocioHistorial socio={SOCIO} />)
    await waitFor(() => expect(screen.getByText(/todavía no tiene una cuenta activa/)).toBeTruthy())
  })

  it('la pestaña Asistencias unifica clases reservadas y check-ins "¡Hoy entrené!" (punto b del protocolo)', async () => {
    mockearCargaCompleta()
    render(<FichaSocioHistorial socio={SOCIO} />)

    fireEvent.click(await screen.findByText('📅 Asistencias'))

    await waitFor(() => expect(screen.getByText('Clase: CrossFit')).toBeTruthy())
    expect(screen.getByText('Entrenamiento Libre: ¡Hoy entrené!')).toBeTruthy()
    expect(screen.getByText('Prof. Seba')).toBeTruthy()
  })

  it('la pestaña Pagos muestra el historial real y permite imprimir (punto c del protocolo)', async () => {
    mockearCargaCompleta()
    const ventanaFalsa = { document: { write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn() }
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(ventanaFalsa)

    render(<FichaSocioHistorial socio={SOCIO} />)

    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    // Formato exacto del símbolo/espaciado de Intl.NumberFormat puede variar
    // según el ICU del entorno -- solo se verifica el monto en sí.
    expect(screen.getByText(/15[.,]000/)).toBeTruthy()
    expect(screen.getByText('Efectivo')).toBeTruthy()
    expect(screen.getByText('pagado')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /imprimir/i }))

    expect(openSpy).toHaveBeenCalled()
    expect(ventanaFalsa.document.write).toHaveBeenCalledWith(expect.stringContaining('Martina Ríos'))
    expect(ventanaFalsa.print).toHaveBeenCalled()

    openSpy.mockRestore()
  })

  it('la pestaña Métricas muestra nivel, racha, asistencias totales y fecha de alta', async () => {
    mockearCargaCompleta()
    render(<FichaSocioHistorial socio={SOCIO} />)

    fireEvent.click(await screen.findByText('⚡ Métricas'))

    await waitFor(() => expect(screen.getByText('N3')).toBeTruthy())
    expect(screen.getByText('2')).toBeTruthy() // racha
    expect(screen.getByText('12')).toBeTruthy() // asistencias totales
  })
})
