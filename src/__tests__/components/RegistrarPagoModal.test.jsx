import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RegistrarPagoModal from '../../components/RegistrarPagoModal'

// Socio con plan de VENCIMIENTO (Pase Libre) -- es el único caso en el que
// el modal muestra los datepickers de fecha de inicio/vencimiento en vez
// de la grilla de créditos.
const SOCIO_PASE_LIBRE = {
  id: 's1',
  nombre: 'Lucía',
  apellido: 'Paz',
  dni: '30222333',
  plan: ['Pase Libre'],
  fechaVencimiento: null,
  diaCorte: null,
  creditos: 0,
}

const SOCIO_CREDITOS = {
  id: 's2',
  nombre: 'Martina',
  apellido: 'Ríos',
  dni: '30111222',
  plan: ['CrossFit'],
  fechaVencimiento: null,
  diaCorte: null,
  creditos: 4,
}

describe('RegistrarPagoModal -- fechas de inicio/vencimiento personalizables', () => {
  it('no muestra los datepickers para un socio de plan de créditos (sin vencimiento)', () => {
    render(<RegistrarPagoModal socio={SOCIO_CREDITOS} onClose={vi.fn()} onConfirmar={vi.fn()} />)
    expect(screen.queryByLabelText('Fecha de inicio')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Fecha de vencimiento')).not.toBeInTheDocument()
  })

  it('precarga fecha de inicio = hoy y vencimiento = +1 mes cuando el socio nunca pagó', () => {
    render(<RegistrarPagoModal socio={SOCIO_PASE_LIBRE} onClose={vi.fn()} onConfirmar={vi.fn()} />)
    const hoy = new Date().toISOString().slice(0, 10)
    expect(screen.getByLabelText('Fecha de inicio')).toHaveValue(hoy)
    // No fijamos el día exacto (depende del mes), solo que quedó precargada
    // con ALGO posterior a la fecha de inicio -- el detalle de "+1 mes
    // exacto" ya lo cubre proximoVencimiento() en utils/fecha.test.js.
    expect(screen.getByLabelText('Fecha de vencimiento')).not.toHaveValue('')
    expect(screen.getByLabelText('Fecha de vencimiento').value > hoy).toBe(true)
  })

  it('permite un rango 100% custom (ej. 10 días) y lo manda tal cual en el payload de onConfirmar', async () => {
    const onConfirmar = vi.fn().mockResolvedValue(undefined)
    render(<RegistrarPagoModal socio={SOCIO_PASE_LIBRE} onClose={vi.fn()} onConfirmar={onConfirmar} />)

    fireEvent.change(screen.getByLabelText('Fecha de inicio'), { target: { value: '2026-08-05' } })
    fireEvent.change(screen.getByLabelText('Fecha de vencimiento'), { target: { value: '2026-08-15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))

    expect(onConfirmar).toHaveBeenCalledWith(
      SOCIO_PASE_LIBRE,
      expect.objectContaining({
        vencimiento: { fechaInicio: '2026-08-05', fechaVencimiento: '2026-08-15' },
      }),
    )
  })

  it('bloquea la confirmación si la fecha de vencimiento es anterior a la de inicio', () => {
    const onConfirmar = vi.fn()
    render(<RegistrarPagoModal socio={SOCIO_PASE_LIBRE} onClose={vi.fn()} onConfirmar={onConfirmar} />)

    fireEvent.change(screen.getByLabelText('Fecha de inicio'), { target: { value: '2026-08-15' } })
    fireEvent.change(screen.getByLabelText('Fecha de vencimiento'), { target: { value: '2026-08-05' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))

    expect(screen.getByText('La fecha de vencimiento no puede ser anterior a la de inicio.')).toBeInTheDocument()
    expect(onConfirmar).not.toHaveBeenCalled()
  })
})
