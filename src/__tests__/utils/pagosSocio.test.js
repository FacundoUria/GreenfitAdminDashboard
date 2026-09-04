import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } },
}))

import { supabase } from '../../lib/supabaseClient'
import {
  buildCreditosTexto,
  fetchComprobantesPendientes,
  fetchCountComprobantesPendientes,
  aprobarComprobante,
  rechazarComprobante,
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

describe('fetchCountComprobantesPendientes (badge del Sidebar)', () => {
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

function chainPagos(data, error = null) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data, error }),
        }),
      }),
    }),
  }
}

describe('fetchComprobantesPendientes (listado de la pantalla Pagos)', () => {
  const DISCIPLINAS = [{ id: 'disc-crossfit', name: 'CrossFit' }]
  const PACK = { id: 'pack-1', name: 'Pack 12 CrossFit', creditos: [{ discipline_id: 'disc-crossfit', credits: 12 }], incluye_aparatos: false, dias_vigencia: null }
  const FILA_CRUDA = {
    id: 'pago-1',
    user_id: 'socio-1',
    paquete: 'Pack 12 CrossFit',
    monto: 30000,
    pack_id: 'pack-1',
    comprobante_url: 'socio-1/123.jpg',
    created_at: '2026-09-01T10:00:00.000Z',
    profiles: { full_name: 'Bruno Álvarez' },
    packs: PACK,
  }

  it('camino feliz: arma el listado con nombre real, créditos a otorgar, monto y URL firmada', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'pagos_socio') return chainPagos([FILA_CRUDA])
      if (tabla === 'disciplines') return chainDisciplinas(DISCIPLINAS)
      throw new Error(`tabla inesperada: ${tabla}`)
    })
    const createSignedUrls = vi.fn().mockResolvedValue({
      data: [{ path: 'socio-1/123.jpg', signedUrl: 'https://signed.test/socio-1/123.jpg?token=abc' }],
      error: null,
    })
    mockedStorageFrom.mockReturnValue({ createSignedUrls })

    const filas = await fetchComprobantesPendientes()

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
        monto: 30000,
        fecha: '2026-09-01T10:00:00.000Z',
        comprobanteUrl: 'https://signed.test/socio-1/123.jpg?token=abc',
      },
    ])
  })

  it('sin filas pendientes, no pide ninguna URL firmada (batch vacío)', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'pagos_socio') return chainPagos([])
      if (tabla === 'disciplines') return chainDisciplinas([])
      throw new Error(`tabla inesperada: ${tabla}`)
    })

    const filas = await fetchComprobantesPendientes()

    expect(filas).toEqual([])
    expect(mockedStorageFrom).not.toHaveBeenCalled()
  })

  it('si createSignedUrls falla, la fila sigue siendo revisable pero sin imagen (no rompe el listado entero)', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'pagos_socio') return chainPagos([FILA_CRUDA])
      if (tabla === 'disciplines') return chainDisciplinas(DISCIPLINAS)
      throw new Error(`tabla inesperada: ${tabla}`)
    })
    mockedStorageFrom.mockReturnValue({
      createSignedUrls: vi.fn().mockResolvedValue({ data: null, error: { message: 'bucket privado sin acceso' } }),
    })

    const filas = await fetchComprobantesPendientes()

    expect(filas).toHaveLength(1)
    expect(filas[0].comprobanteUrl).toBeNull()
    expect(filas[0].socioNombre).toBe('Bruno Álvarez')
  })

  it('si pagos_socio todavía no tiene las columnas de la Fase 1 (relación faltante), devuelve lista vacía en vez de romper', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'pagos_socio') return chainPagos(null, { code: 'PGRST205', message: 'schema cache' })
      if (tabla === 'disciplines') return chainDisciplinas([])
      throw new Error(`tabla inesperada: ${tabla}`)
    })
    expect(await fetchComprobantesPendientes()).toEqual([])
  })

  it('con un error real de pagos_socio, lo propaga', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'pagos_socio') return chainPagos(null, { message: 'timeout de red' })
      if (tabla === 'disciplines') return chainDisciplinas([])
      throw new Error(`tabla inesperada: ${tabla}`)
    })
    await expect(fetchComprobantesPendientes()).rejects.toThrow('timeout de red')
  })
})

describe('aprobarComprobante (RPC admin_aprobar_comprobante)', () => {
  it('camino feliz: créditos otorgados', async () => {
    mockedRpc.mockResolvedValue({ data: [{ credito_otorgado: true }], error: null })
    const resultado = await aprobarComprobante('pago-1')
    expect(mockedRpc).toHaveBeenCalledWith('admin_aprobar_comprobante', { p_pagos_socio_id: 'pago-1' })
    expect(resultado).toEqual({ creditoOtorgado: true })
  })

  it('si ya había sido revisado antes (otra pestaña), devuelve creditoOtorgado=false sin tirar error', async () => {
    mockedRpc.mockResolvedValue({ data: [{ credito_otorgado: false }], error: null })
    expect(await aprobarComprobante('pago-1')).toEqual({ creditoOtorgado: false })
  })

  it('con un error real del RPC, lo propaga', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { message: 'No existe ningún comprobante con ese id.' } })
    await expect(aprobarComprobante('pago-x')).rejects.toThrow('No existe ningún comprobante con ese id.')
  })
})

describe('rechazarComprobante (RPC admin_rechazar_comprobante)', () => {
  it('camino feliz', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: null })
    await expect(rechazarComprobante('pago-1')).resolves.toBeUndefined()
    expect(mockedRpc).toHaveBeenCalledWith('admin_rechazar_comprobante', { p_pagos_socio_id: 'pago-1' })
  })

  it('con un error real del RPC, lo propaga', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { message: 'No existe ningún comprobante con ese id.' } })
    await expect(rechazarComprobante('pago-x')).rejects.toThrow('No existe ningún comprobante con ese id.')
  })
})
