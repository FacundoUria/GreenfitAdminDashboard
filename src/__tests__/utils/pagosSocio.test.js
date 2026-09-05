import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } },
}))

import { supabase } from '../../lib/supabaseClient'
import {
  buildCreditosTexto,
  buildDetalleRevertidoTexto,
  fetchHistorialComprobantes,
  fetchCountComprobantesPendientes,
  revertirComprobante,
  BUCKET_COMPROBANTES,
} from '../../utils/pagosSocio'

const mockedFrom = supabase.from
const mockedRpc = supabase.rpc
const mockedStorageFrom = supabase.storage.from

beforeEach(() => vi.clearAllMocks())

describe('buildCreditosTexto (mismo criterio que PlanesPacksCard/creditsApi.ts)', () => {
  const disciplinasPorId = new Map([
    ['disc-crossfit', { id: 'disc-crossfit', name: 'CrossFit' }],
    ['disc-boxeo', { id: 'disc-boxeo', name: 'Boxeo' }],
  ])

  it('sin pack, devuelve null', () => {
    expect(buildCreditosTexto(null, disciplinasPorId)).toBeNull()
  })

  it('combo de créditos de dos disciplinas', () => {
    const pack = { creditos: [{ discipline_id: 'disc-crossfit', credits: 12 }, { discipline_id: 'disc-boxeo', credits: 8 }], incluye_aparatos: false }
    expect(buildCreditosTexto(pack, disciplinasPorId)).toBe('12 créditos CrossFit + 8 créditos Boxeo')
  })

  it('aparatos pase libre (sin créditos)', () => {
    const pack = { creditos: [], incluye_aparatos: true }
    expect(buildCreditosTexto(pack, disciplinasPorId)).toBe('Aparatos Pase Libre')
  })

  it('aparatos + créditos combinados', () => {
    const pack = { creditos: [{ discipline_id: 'disc-crossfit', credits: 12 }], incluye_aparatos: true }
    expect(buildCreditosTexto(pack, disciplinasPorId)).toBe('Aparatos + 12 créditos CrossFit')
  })
})

// Fase 3 -- a diferencia de buildCreditosTexto (lee la definición ACTUAL
// del pack), esto lee detalle_acreditacion (lo que de verdad se otorgó en
// su momento) -- es lo que hay que mostrar en la confirmación de "Revertir".
describe('buildDetalleRevertidoTexto (confirmación de "Revertir" -- Fase 3)', () => {
  const disciplinasPorId = new Map([['disc-crossfit', { id: 'disc-crossfit', name: 'CrossFit' }]])

  it('sin detalle_acreditacion (pago de antes de este cambio), devuelve null', () => {
    expect(buildDetalleRevertidoTexto(null, disciplinasPorId)).toBeNull()
  })

  it('solo créditos', () => {
    const detalle = { creditos: [{ discipline_id: 'disc-crossfit', credits_otorgados: 12 }] }
    expect(buildDetalleRevertidoTexto(detalle, disciplinasPorId)).toBe('12 créditos CrossFit')
  })

  it('créditos + Aparatos', () => {
    const detalle = {
      creditos: [{ discipline_id: 'disc-crossfit', credits_otorgados: 12 }],
      aparatos: { discipline_id: 'disc-aparatos', fecha_vencimiento_antes: null, fecha_vencimiento_despues: '2026-10-05' },
    }
    expect(buildDetalleRevertidoTexto(detalle, disciplinasPorId)).toBe('la extensión de Aparatos + 12 créditos CrossFit')
  })
})

describe('fetchCountComprobantesPendientes (badge del Sidebar -- backlog transitorio del flujo viejo)', () => {
  it('devuelve el count real, filtrado por estado y origen', async () => {
    const eqSegundo = vi.fn().mockResolvedValue({ count: 3, error: null })
    const eqPrimero = vi.fn().mockReturnValue({ eq: eqSegundo })
    const select = vi.fn().mockReturnValue({ eq: eqPrimero })
    mockedFrom.mockReturnValue({ select })

    const count = await fetchCountComprobantesPendientes()

    expect(select).toHaveBeenCalledWith('id', { count: 'exact', head: true })
    expect(eqPrimero).toHaveBeenCalledWith('estado', 'pendiente')
    expect(eqSegundo).toHaveBeenCalledWith('origen', 'transferencia_comprobante')
    expect(count).toBe(3)
  })

  it('si la migración todavía no corrió (42P01), devuelve 0 en vez de romper el Sidebar', async () => {
    mockedFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ count: null, error: { code: '42P01', message: 'relation does not exist' } }) }) }),
    })
    expect(await fetchCountComprobantesPendientes()).toBe(0)
  })

  it('con un error real, lo propaga', async () => {
    mockedFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ count: null, error: { message: 'timeout' } }) }) }),
    })
    await expect(fetchCountComprobantesPendientes()).rejects.toThrow('timeout')
  })
})

function chainDisciplinas(data = []) {
  return { select: vi.fn().mockResolvedValue({ data, error: null }) }
}

// Devuelve la cadena mockeada y una referencia a cada mock intermedio, para
// poder assertar CON QUÉ se llamó cada paso (select/eq/in/order/limit) --
// no solo que la cadena en sí resuelva bien.
function chainPagos(data, error = null) {
  const limit = vi.fn().mockResolvedValue({ data, error })
  const order = vi.fn().mockReturnValue({ limit })
  const inFn = vi.fn().mockReturnValue({ order })
  const eq = vi.fn().mockReturnValue({ in: inFn })
  const select = vi.fn().mockReturnValue({ eq })
  return { select, _mocks: { select, eq, in: inFn, order, limit } }
}

describe('fetchHistorialComprobantes (listado de la pantalla Pagos -- Fase 3, reemplaza a fetchComprobantesPendientes)', () => {
  const DISCIPLINAS = [{ id: 'disc-crossfit', name: 'CrossFit' }]
  const PACK = { id: 'pack-1', name: 'Pack 12 CrossFit', creditos: [{ discipline_id: 'disc-crossfit', credits: 12 }], incluye_aparatos: false, dias_vigencia: null }
  const DETALLE = { creditos: [{ discipline_id: 'disc-crossfit', credits_otorgados: 12 }] }
  const FILA_CRUDA = {
    id: 'pago-1',
    user_id: 'socio-1',
    paquete: 'Pack 12 CrossFit',
    monto: 30000,
    pack_id: 'pack-1',
    comprobante_url: 'socio-1/123.jpg',
    created_at: '2026-09-01T10:00:00.000Z',
    estado: 'pagado',
    reviewed_at: null,
    detalle_acreditacion: DETALLE,
    profiles: { full_name: 'Bruno Álvarez' },
    packs: PACK,
  }

  it('camino feliz: arma el listado con nombre real, estado, créditos otorgados, monto y URL firmada, filtrando por origen/estado/límite', async () => {
    let mocksPagos
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'pagos_socio') {
        const chain = chainPagos([FILA_CRUDA])
        mocksPagos = chain._mocks
        return chain
      }
      if (tabla === 'disciplines') return chainDisciplinas(DISCIPLINAS)
      throw new Error(`tabla inesperada: ${tabla}`)
    })
    const createSignedUrls = vi.fn().mockResolvedValue({
      data: [{ path: 'socio-1/123.jpg', signedUrl: 'https://signed.test/socio-1/123.jpg?token=abc' }],
      error: null,
    })
    mockedStorageFrom.mockReturnValue({ createSignedUrls })

    const filas = await fetchHistorialComprobantes()

    expect(mocksPagos.eq).toHaveBeenCalledWith('origen', 'transferencia_comprobante')
    expect(mocksPagos.in).toHaveBeenCalledWith('estado', ['pagado', 'anulado'])
    expect(mocksPagos.limit).toHaveBeenCalledWith(50)
    expect(mockedStorageFrom).toHaveBeenCalledWith(BUCKET_COMPROBANTES)
    expect(createSignedUrls).toHaveBeenCalledWith(['socio-1/123.jpg'], 600)
    expect(filas).toEqual([
      {
        id: 'pago-1',
        userId: 'socio-1',
        socioNombre: 'Bruno Álvarez',
        paquete: 'Pack 12 CrossFit',
        pack: PACK,
        creditosTexto: '12 créditos CrossFit',
        detalleRevertidoTexto: '12 créditos CrossFit',
        monto: 30000,
        fecha: '2026-09-01T10:00:00.000Z',
        estado: 'pagado',
        revertidoEl: null,
        comprobanteUrl: 'https://signed.test/socio-1/123.jpg?token=abc',
      },
    ])
  })

  it('sin filas en el historial, no pide ninguna URL firmada (batch vacío)', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'pagos_socio') return chainPagos([])
      if (tabla === 'disciplines') return chainDisciplinas([])
      throw new Error(`tabla inesperada: ${tabla}`)
    })

    const filas = await fetchHistorialComprobantes()

    expect(filas).toEqual([])
    expect(mockedStorageFrom).not.toHaveBeenCalled()
  })

  it('una fila anulada sin detalle_acreditacion muestra detalleRevertidoTexto null (pago de antes de este cambio)', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'pagos_socio') return chainPagos([{ ...FILA_CRUDA, estado: 'anulado', detalle_acreditacion: null }])
      if (tabla === 'disciplines') return chainDisciplinas(DISCIPLINAS)
      throw new Error(`tabla inesperada: ${tabla}`)
    })

    const [fila] = await fetchHistorialComprobantes()
    expect(fila.estado).toBe('anulado')
    expect(fila.detalleRevertidoTexto).toBeNull()
  })

  it('si createSignedUrls falla, la fila sigue siendo visible pero sin imagen', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'pagos_socio') return chainPagos([FILA_CRUDA])
      if (tabla === 'disciplines') return chainDisciplinas(DISCIPLINAS)
      throw new Error(`tabla inesperada: ${tabla}`)
    })
    mockedStorageFrom.mockReturnValue({
      createSignedUrls: vi.fn().mockResolvedValue({ data: null, error: { message: 'bucket privado sin acceso' } }),
    })

    const filas = await fetchHistorialComprobantes()

    expect(filas).toHaveLength(1)
    expect(filas[0].comprobanteUrl).toBeNull()
    expect(filas[0].socioNombre).toBe('Bruno Álvarez')
  })

  it('si pagos_socio todavía no tiene detalle_acreditacion (relación faltante), devuelve lista vacía en vez de romper', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'pagos_socio') return chainPagos(null, { code: 'PGRST205', message: 'schema cache' })
      if (tabla === 'disciplines') return chainDisciplinas([])
      throw new Error(`tabla inesperada: ${tabla}`)
    })
    expect(await fetchHistorialComprobantes()).toEqual([])
  })

  it('con un error real de pagos_socio, lo propaga', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'pagos_socio') return chainPagos(null, { message: 'timeout de red' })
      if (tabla === 'disciplines') return chainDisciplinas([])
      throw new Error(`tabla inesperada: ${tabla}`)
    })
    await expect(fetchHistorialComprobantes()).rejects.toThrow('timeout de red')
  })
})

describe('revertirComprobante (RPC admin_revertir_comprobante -- Fase 3, reemplaza a aprobarComprobante/rechazarComprobante)', () => {
  it('camino feliz sin advertencia', async () => {
    mockedRpc.mockResolvedValue({ data: [{ reversion_ok: true, aparatos_advertencia: null }], error: null })
    const resultado = await revertirComprobante('pago-1')
    expect(mockedRpc).toHaveBeenCalledWith('admin_revertir_comprobante', { p_pagos_socio_id: 'pago-1' })
    expect(resultado).toEqual({ revertido: true, aparatosAdvertencia: null })
  })

  it('camino feliz CON advertencia de Aparatos (algo lo modificó después) -- se propaga el texto tal cual', async () => {
    mockedRpc.mockResolvedValue({
      data: [{ reversion_ok: true, aparatos_advertencia: 'La fecha de vencimiento de Aparatos no se pudo revertir automáticamente -- cambió desde que se otorgó esta acreditación. Ajustala a mano en "Editar Socio".' }],
      error: null,
    })
    const resultado = await revertirComprobante('pago-1')
    expect(resultado.revertido).toBe(true)
    expect(resultado.aparatosAdvertencia).toContain('no se pudo revertir automáticamente')
  })

  it('si ya había sido revertido antes (otra pestaña), devuelve revertido=false sin tirar error', async () => {
    mockedRpc.mockResolvedValue({ data: [{ reversion_ok: false, aparatos_advertencia: null }], error: null })
    expect(await revertirComprobante('pago-1')).toEqual({ revertido: false, aparatosAdvertencia: null })
  })

  it('con un error real del RPC, lo propaga', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { message: 'No existe ningún pago con ese id.' } })
    await expect(revertirComprobante('pago-x')).rejects.toThrow('No existe ningún pago con ese id.')
  })
})
