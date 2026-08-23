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
  // Bug real: antes el calendario de vencimiento solo aparecía si el socio
  // tenía Aparatos/Pase Libre -- un socio EXCLUSIVAMENTE de CrossFit (u
  // otra disciplina de créditos) no tenía forma de que el Admin le
  // asigne/renueve un vencimiento. Ahora aparece con cualquier plan
  // tildado, sea de créditos o no.
  it('muestra los datepickers también para un socio de plan de créditos puro (CrossFit)', () => {
    render(<RegistrarPagoModal socio={SOCIO_CREDITOS} onClose={vi.fn()} onConfirmar={vi.fn()} />)
    expect(screen.getByLabelText('Fecha de inicio')).toBeInTheDocument()
    expect(screen.getByLabelText('Fecha de vencimiento')).toBeInTheDocument()
  })

  it('un cobro de créditos puro manda igual el payload de vencimiento si el admin no lo destildó', async () => {
    const onConfirmar = vi.fn().mockResolvedValue(undefined)
    render(<RegistrarPagoModal socio={SOCIO_CREDITOS} onClose={vi.fn()} onConfirmar={onConfirmar} />)

    // Necesita al menos 1 crédito cargado para poder confirmar (regla ya
    // existente, sin relación con el bug de vencimiento) -- el pack rápido
    // "+4" carga la cantidad, sin depender de un label accesible que el
    // input de cantidad no tiene.
    fireEvent.click(screen.getByRole('button', { name: '+4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))

    expect(onConfirmar).toHaveBeenCalledWith(
      SOCIO_CREDITOS,
      expect.objectContaining({
        vencimiento: expect.objectContaining({ fechaInicio: expect.any(String), fechaVencimiento: expect.any(String) }),
      }),
    )
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

describe('RegistrarPagoModal -- sugerencia inteligente de fechas (EXCLUSIVA de este modal)', () => {
  function sumarDiasStr(iso, dias) {
    const fecha = new Date(`${iso}T00:00:00`)
    fecha.setDate(fecha.getDate() + dias)
    const anio = fecha.getFullYear()
    const mes = String(fecha.getMonth() + 1).padStart(2, '0')
    const dia = String(fecha.getDate()).padStart(2, '0')
    return `${anio}-${mes}-${dia}`
  }

  // Caso 1: socio VENCIDO -- la fecha de inicio sugerida tiene que ser HOY
  // (no la fecha de vencimiento vieja, ya pasada), y el vencimiento sugerido
  // HOY + 1 mes.
  it('socio vencido: sugiere fecha de inicio = HOY (no la fecha vencida vieja) y vencimiento = HOY + 1 mes', () => {
    const hoy = new Date().toISOString().slice(0, 10)
    const socioVencido = {
      id: 's3',
      nombre: 'Bruno',
      apellido: 'Álvarez',
      dni: '30444555',
      plan: ['Pase Libre'],
      fechaVencimiento: sumarDiasStr(hoy, -10), // venció hace 10 días
      diaCorte: 5, // día de corte del ciclo VIEJO -- no debe usarse acá
      creditos: 0,
    }

    render(<RegistrarPagoModal socio={socioVencido} onClose={vi.fn()} onConfirmar={vi.fn()} />)

    expect(screen.getByLabelText('Fecha de inicio')).toHaveValue(hoy)

    // `T00:00:00` explícito -- un ISO date-only ("YYYY-MM-DD") sin hora se
    // parsea como medianoche UTC, no local; en husos detrás de UTC (ej.
    // Argentina) eso corre la fecha un día para atrás antes de sumar el mes.
    const vencimientoEsperado = new Date(`${hoy}T00:00:00`)
    vencimientoEsperado.setMonth(vencimientoEsperado.getMonth() + 1)
    const vencimientoEsperadoIso = toISODateLocal(vencimientoEsperado)
    expect(screen.getByLabelText('Fecha de vencimiento')).toHaveValue(vencimientoEsperadoIso)
  })

  // Caso 2: socio ACTIVO (vencimiento futuro) -- se mantiene la sugerencia
  // de siempre, anclada al vencimiento vigente (no a hoy).
  it('socio activo (vencimiento futuro): mantiene la sugerencia original -- inicio = vencimiento actual', () => {
    const hoy = new Date().toISOString().slice(0, 10)
    const vencimientoFuturo = sumarDiasStr(hoy, 15)
    const socioActivo = {
      id: 's4',
      nombre: 'Carla',
      apellido: 'Núñez',
      dni: '30555666',
      plan: ['Pase Libre'],
      fechaVencimiento: vencimientoFuturo,
      diaCorte: new Date(`${vencimientoFuturo}T00:00:00`).getDate(),
      creditos: 0,
    }

    render(<RegistrarPagoModal socio={socioActivo} onClose={vi.fn()} onConfirmar={vi.fn()} />)

    expect(screen.getByLabelText('Fecha de inicio')).toHaveValue(vencimientoFuturo)
    expect(screen.getByLabelText('Fecha de vencimiento').value > vencimientoFuturo).toBe(true)
  })
})

function toISODateLocal(fecha) {
  const anio = fecha.getFullYear()
  const mes = String(fecha.getMonth() + 1).padStart(2, '0')
  const dia = String(fecha.getDate()).padStart(2, '0')
  return `${anio}-${mes}-${dia}`
}
