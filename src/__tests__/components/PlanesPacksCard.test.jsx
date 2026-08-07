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
const DISC_APARATOS = { id: 'disc-aparatos', name: 'Aparatos', kind: 'membership' }

const PACK_CROSSFIT = {
  id: 'pack-1',
  name: 'Pack 12 clases CrossFit',
  price: 30000,
  credits: 12,
  duration_days: null,
  is_active: true,
  discipline_id: 'disc-crossfit',
}

const PACK_APARATOS = {
  id: 'pack-2',
  name: 'Mes libre Aparatos',
  price: 21000,
  credits: null,
  duration_days: 30,
  is_active: false,
  discipline_id: 'disc-aparatos',
}

describe('PlanesPacksCard -- gestión de packs en Configuración (lo que la PWA lee en "Elegí tu pack")', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'packs') return makeChain({ data: [PACK_CROSSFIT, PACK_APARATOS], error: null })
      if (tabla === 'disciplines') return makeChain({ data: [DISC_CROSSFIT, DISC_APARATOS], error: null })
      throw new Error(`tabla inesperada: ${tabla}`)
    })
  })

  it('lista los packs con disciplina, créditos/días y precio -- un pack de membresía inactivo muestra el badge "Inactivo"', async () => {
    render(<PlanesPacksCard />)

    await waitFor(() => expect(screen.getByText('Pack 12 clases CrossFit')).toBeInTheDocument())
    expect(screen.getByText('CrossFit · 12 créditos')).toBeInTheDocument()
    expect(screen.getByText('Mes libre Aparatos')).toBeInTheDocument()
    expect(screen.getByText('Aparatos · 30 días')).toBeInTheDocument()
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
    await waitFor(() => expect(screen.getByText('Pack 12 clases CrossFit')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Nuevo Pack' }))
    expect(screen.getByRole('heading', { name: 'Nuevo Pack' })).toBeInTheDocument()
  })

  it('un intento de eliminar un pack con créditos ya cargados (FK 23503) sugiere desactivarlo en vez de borrarlo', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    mockedFrom.mockImplementation((tabla) => {
      if (tabla === 'packs') {
        return {
          ...makeChain({ data: [PACK_CROSSFIT], error: null }),
          delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: { code: '23503' } }) })),
        }
      }
      if (tabla === 'disciplines') return makeChain({ data: [], error: null })
      throw new Error(`tabla inesperada: ${tabla}`)
    })

    render(<PlanesPacksCard />)
    await waitFor(() => expect(screen.getByText('Pack 12 clases CrossFit')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Eliminar Pack 12 clases CrossFit'))

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Desactivalo en su lugar')),
    )
  })
})
