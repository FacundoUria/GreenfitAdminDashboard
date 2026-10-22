import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RegistrarPagoModal from '../../components/RegistrarPagoModal'
import { ahoraEnArgentina } from '../../utils/ahoraArgentina'

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
    const hoy = ahoraEnArgentina().fecha
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
    const hoy = ahoraEnArgentina().fecha
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
    const hoy = ahoraEnArgentina().fecha
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

// ETAPA 4 -- el "vencimiento actual" del socio sale de sus créditos/Aparatos
// reales (utils/fechaPlan.js), no de socios.fecha_vencimiento a secas.
describe('RegistrarPagoModal -- el vencimiento sale de user_credits, no de la columna vieja', () => {
  // Cuenta desde el "hoy" de Argentina (el mismo que usa el modal), no desde
  // el día local de la PC.
  const enDias = (dias) => {
    const fecha = new Date(`${ahoraEnArgentina().fecha}T00:00:00`)
    fecha.setDate(fecha.getDate() + dias)
    return toISODateLocal(fecha)
  }
  // 15:00 UTC = mediodía en Argentina: mismo día calendario.
  const lote = (dia) => [{ disciplineId: 'cf', disciplineName: 'CrossFit', remainingCredits: 4, lotes: [{ id: 'l1', remainingCredits: 4, expiresAt: `${dia}T15:00:00.000Z` }] }]

  it('socio de SOLO CRÉDITOS al día, con la columna vieja (ya pasada): NO dice "está vencido" y sugiere arrancar desde su vencimiento real', () => {
    const vencimientoReal = enDias(8)
    const socio = {
      ...SOCIO_CREDITOS,
      fechaVencimiento: enDias(-60), // columna vieja: un pago por la app no la actualiza
      aparatosVigenteReal: false, // tiene cuenta en la app, sin Aparatos
      creditosPwaPorDisciplina: lote(vencimientoReal),
    }
    render(<RegistrarPagoModal socio={socio} onClose={vi.fn()} onConfirmar={vi.fn()} />)

    expect(screen.queryByText(/El socio está vencido/)).toBeNull()
    expect(screen.getByText(/desde el vencimiento actual/)).toBeInTheDocument()
    expect(screen.getByLabelText('Fecha de inicio')).toHaveValue(vencimientoReal)
  })

  it('socio con cuenta, sin nada vigente y una fecha FUTURA fantasma en la columna: arranca desde hoy', () => {
    const socio = { ...SOCIO_CREDITOS, fechaVencimiento: '2052-08-21', aparatosVigenteReal: false, creditosPwaPorDisciplina: [] }
    render(<RegistrarPagoModal socio={socio} onClose={vi.fn()} onConfirmar={vi.fn()} />)

    expect(screen.getByLabelText('Fecha de inicio')).toHaveValue(enDias(0))
    expect(screen.getByText(/1 mes desde hoy/)).toBeInTheDocument()
  })

  it('socio con cuenta, sin nada vigente y la columna ya pasada: sigue diciendo "está vencido" y arranca hoy', () => {
    const socio = { ...SOCIO_CREDITOS, fechaVencimiento: enDias(-10), aparatosVigenteReal: false, creditosPwaPorDisciplina: [] }
    render(<RegistrarPagoModal socio={socio} onClose={vi.fn()} onConfirmar={vi.fn()} />)

    expect(screen.getByText(/El socio está vencido/)).toBeInTheDocument()
    expect(screen.getByLabelText('Fecha de inicio')).toHaveValue(enDias(0))
  })
})

// Bug real: "hoy" salía de hoyISO() (UTC) -- de 21:00 a 23:59 de Argentina el
// modal proponía arrancar la cuota MAÑANA, y un socio que vencía hoy se
// trataba como "vencido". Instantes en UTC (con Z): el resultado no depende
// de la zona de la PC. Jueves 22/10/2026 -> viernes 23/10/2026.
describe('RegistrarPagoModal -- "hoy" en hora de Argentina (franja 21:00 a 23:59)', () => {
  afterEach(() => vi.useRealTimers())

  const INSTANTES = [
    ['20:59', '2026-10-22T23:59:00Z'],
    ['21:00', '2026-10-23T00:00:00Z'],
    ['23:59', '2026-10-23T02:59:00Z'],
    ['00:00', '2026-10-23T03:00:00Z'],
  ]

  const conVencimiento = (fechaVencimiento, diaCorte) => ({ ...SOCIO_PASE_LIBRE, id: `s-${fechaVencimiento}`, fechaVencimiento, diaCorte })

  // [caso, socio, esperado por instante (20:59, 21:00, 23:59, 00:00)]
  // esperado = [inicio, vencimiento, mensaje]
  const VENCIDO = /El socio está vencido/
  const DESDE_VENCIMIENTO = /desde el vencimiento actual/
  const DESDE_HOY = /1 mes desde hoy/
  const CASOS = [
    ['socio sin pagos', SOCIO_PASE_LIBRE, [
      ['2026-10-22', '2026-11-22', DESDE_HOY],
      ['2026-10-22', '2026-11-22', DESDE_HOY],
      ['2026-10-22', '2026-11-22', DESDE_HOY],
      ['2026-10-23', '2026-11-23', DESDE_HOY],
    ]],
    ['socio vencido (12/10)', conVencimiento('2026-10-12', 5), [
      ['2026-10-22', '2026-11-22', VENCIDO],
      ['2026-10-22', '2026-11-22', VENCIDO],
      ['2026-10-22', '2026-11-22', VENCIDO],
      ['2026-10-23', '2026-11-23', VENCIDO],
    ]],
    ['socio que vence HOY (22/10, corte 22)', conVencimiento('2026-10-22', 22), [
      ['2026-10-22', '2026-11-22', DESDE_VENCIMIENTO],
      ['2026-10-22', '2026-11-22', DESDE_VENCIMIENTO],
      ['2026-10-22', '2026-11-22', DESDE_VENCIMIENTO],
      ['2026-10-23', '2026-11-23', VENCIDO], // a las 00:00 ya venció ayer
    ]],
    ['socio activo (vence 30/10, corte 30)', conVencimiento('2026-10-30', 30), [
      ['2026-10-30', '2026-11-30', DESDE_VENCIMIENTO],
      ['2026-10-30', '2026-11-30', DESDE_VENCIMIENTO],
      ['2026-10-30', '2026-11-30', DESDE_VENCIMIENTO],
      ['2026-10-30', '2026-11-30', DESDE_VENCIMIENTO],
    ]],
  ]

  for (const [caso, socio, esperados] of CASOS) {
    INSTANTES.forEach(([hora, instante], i) => {
      const [inicio, vencimiento, mensaje] = esperados[i]
      it(`${caso}, ${hora} de Argentina: inicio ${inicio}, vencimiento ${vencimiento}`, () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date(instante))
        const onConfirmar = vi.fn().mockResolvedValue(undefined)
        render(<RegistrarPagoModal socio={socio} onClose={vi.fn()} onConfirmar={onConfirmar} />)

        expect(screen.getByLabelText('Fecha de inicio')).toHaveValue(inicio)
        expect(screen.getByLabelText('Fecha de vencimiento')).toHaveValue(vencimiento)
        expect(screen.getByText(mensaje)).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))
        expect(onConfirmar).toHaveBeenCalledWith(
          socio,
          expect.objectContaining({ vencimiento: { fechaInicio: inicio, fechaVencimiento: vencimiento } }),
        )
      })
    })
  }
})
