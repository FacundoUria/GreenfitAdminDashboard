import { describe, it, expect } from 'vitest'
import { estadoOperativoSocio, getSocioMetrics } from '../../utils/socioMetrics'

// Fuente única de verdad para "Socios Activos"/"Cuotas Vencidas"/"En
// Tolerancia" -- Home.jsx y Socios.jsx antes tenían dos criterios distintos
// para lo mismo (Home ignoraba a los socios sin fecha_vencimiento, Socios
// caía a un texto legacy `estadoDb`), lo que hacía que la misma etiqueta
// mostrara números distintos en las dos pantallas. Estos tests fijan la
// regla única y cubren el caso que causaba la divergencia.

const HOY = '2026-08-10'
const REF = new Date(`${HOY}T12:00:00`)

describe('estadoOperativoSocio', () => {
  it('vencimiento futuro -> activo', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: '2026-08-20', activo: true }, 5, REF)).toBe('activo')
  })

  it('vencimiento hoy -> activo', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: HOY, activo: true }, 5, REF)).toBe('activo')
  })

  it('vencido dentro del período de tolerancia -> tolerancia', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: '2026-08-07', activo: true }, 5, REF)).toBe('tolerancia')
  })

  it('vencido más allá de la tolerancia -> vencido', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: '2026-07-20', activo: true }, 5, REF)).toBe('vencido')
  })

  it('sin fecha_vencimiento (plan de créditos, ej. CrossFit) -> activo, nunca cae a un texto legacy', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: null, estado: 'Vencido', activo: true }, 5, REF)).toBe('activo')
  })

  it('acepta el shape mapeado de Socios.jsx (fechaVencimiento camelCase)', () => {
    expect(estadoOperativoSocio({ fechaVencimiento: '2026-07-20', activo: true }, 5, REF)).toBe('vencido')
  })

  it('dado de baja -> inactivo, sin importar la fecha de vencimiento', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: '2026-08-20', activo: false }, 5, REF)).toBe('inactivo')
  })
})

describe('getSocioMetrics', () => {
  it('cuenta activos/vencidos/tolerancia/inactivos consistentemente sobre una lista mixta', () => {
    const socios = [
      { fecha_vencimiento: '2026-08-20', activo: true }, // activo
      { fecha_vencimiento: null, activo: true }, // activo (plan de créditos)
      { fecha_vencimiento: '2026-08-07', activo: true }, // tolerancia
      { fecha_vencimiento: '2026-07-01', activo: true }, // vencido
      { fecha_vencimiento: '2026-08-20', activo: false }, // inactivo (dado de baja, no cuenta en ningún otro bucket)
    ]
    expect(getSocioMetrics(socios, 5, REF)).toEqual({ activos: 2, vencidos: 1, tolerancia: 1, inactivos: 1 })
  })

  it('da el MISMO resultado con filas crudas de Supabase (snake_case) que con el shape mapeado de Socios.jsx (camelCase) -- la garantía real detrás de "Home y Socios muestran el mismo número"', () => {
    const filasCrudas = [
      { fecha_vencimiento: '2026-08-20', activo: true },
      { fecha_vencimiento: '2026-07-01', activo: true },
      { fecha_vencimiento: null, activo: true },
    ]
    const filasMapeadas = filasCrudas.map((f) => ({ fechaVencimiento: f.fecha_vencimiento, activo: f.activo }))

    expect(getSocioMetrics(filasCrudas, 5, REF)).toEqual(getSocioMetrics(filasMapeadas, 5, REF))
  })
})
