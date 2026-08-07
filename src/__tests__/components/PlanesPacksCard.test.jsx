import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import PlanesPacksCard from '../../components/PlanesPacksCard'

const mockedFrom = supabase.from

function makeChain(result) {
  const chain = {}
  const self = () => chain
  chain.select = vi.fn(self)
  chain.order = vi.fn(self)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const DISC_CROSSFIT = { id: 'disc-crossfit', name: 'CrossFit', kind: 'credits' }
const DISC_BOXEO = { id: 'disc-boxeo', name: 'Boxeo', kind: 'credits' }
const DISC_APARATOS = { id: 'disc-aparatos', name: 'Aparatos', kind: 'membership' }

const PACK_COMBO = {
  id: 'pack-1',
  name: 'Combo 8+8',
  price: 55000,
  is_active: true,
  incluye_aparatos: false,
  dias_vigencia: null,
  creditos: [
    { discipline_id: 'disc-boxeo', credits: 8 },
    { discipline_id: 'disc-crossfit', credits: 8 },
  ],
}

const PACK_APARATOS = {
  id: 'pack-2',
  name: 'Pase 2 Meses Aparatos',
  price: 70000,
  is_active: false,
  incluye_aparatos: true,
  dias_vigencia: 60,
  creditos: [],
}

describe('PlanesPacksCard -- gestión de packs/combos en Configuración (lo que la PWA lee en "Elegí tu pack")', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'packs') return makeChain({ data: [PACK_COMBO, PACK_APARATOS], error: null })
      if (tabla === 'disciplines') return makeChain({ data: [DISC_CROSSFIT, DISC_BOXEO, DISC_APARATOS], error: null })
      throw new Error(`tabla inesperada: ${tabla}`)
    })
  })

  it('lista un combo real con el subtítulo de las dos disciplinas y el precio -- un pase de Aparatos inactivo muestra el badge "Inactivo"', async () => {
    render(<PlanesPacksCard />)

    await waitFor(() => expect(screen.getByText('Combo 8+8')).toBeInTheDocument())
    expect(screen.getByText('8 créditos Boxeo + 8 créditos CrossFit')).toBeInTheDocument()
    expect(screen.getByText('Pase 2 Meses Aparatos')).toBeInTheDocument()
    expect(screen.getByText('Aparatos Pase Libre')).toBeInTheDocument()
    expect(screen.getByText('Inactivo')).toBeInTheDocument()
  })

  it('sin ningún pack cargado, muestra el estado vacío', async () => {
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'packs') return makeChain({ data: [], error: null })
      if (tabla === 'disciplines') return makeChain({ data: [], error: null })
      throw new Error(`tabla inesperada: ${tabla}`)
    })
    render(<PlanesPacksCard />)
    await waitFor(() => expect(screen.getByText('Todavía no hay ningún pack cargado.')).toBeInTheDocument())
  })

  it('"Nuevo Pack" abre el modal de alta', async () => {
    render(<PlanesPacksCard />)
    await waitFor(() => expect(screen.getByText('Combo 8+8')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Nuevo Pack' }))
    expect(screen.getByRole('heading', { name: 'Nuevo Pack' })).toBeInTheDocument()
  })

  it('un intento de eliminar un pack con créditos ya cargados (FK 23503) sugiere desactivarlo en vez de borrarlo', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'packs') {
        return {
          ...makeChain({ data: [PACK_COMBO], error: null }),
          delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: { code: '23503' } }) })),
        }
      }
      if (tabla === 'disciplines') return makeChain({ data: [], error: null })
      throw new Error(`tabla inesperada: ${tabla}`)
    })

    render(<PlanesPacksCard />)
    await waitFor(() => expect(screen.getByText('Combo 8+8')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Eliminar Combo 8+8'))

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Desactivalo en su lugar')),
    )
  })
})
