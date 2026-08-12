import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../utils/comunidadAdmin', () => ({
  fetchDisciplinasGrupalesAdmin: vi.fn(),
  fetchRankingAdmin: vi.fn(),
  resetearRankingAdmin: vi.fn(),
}))

// useConfiguracion no viene de un provider real acá -- se mockea el hook
// directo (mismo criterio de nombre con prefijo `mock` que mockChannelOn en
// ActividadReciente.test.jsx, por las reglas de hoisting de vi.mock).
const mockUseConfiguracion = vi.fn()
vi.mock('../../context/useConfiguracion', () => ({
  useConfiguracion: () => mockUseConfiguracion(),
}))

import { fetchDisciplinasGrupalesAdmin, fetchRankingAdmin, resetearRankingAdmin } from '../../utils/comunidadAdmin'
import { formatFecha } from '../../utils/fecha'
import RankingAdmin from '../../components/comunidad/RankingAdmin'

const RANKING = [
  { userId: 'u1', fullName: 'Martina Ríos', avatarUrl: null, xp: 900 },
  { userId: 'u2', fullName: 'Bruno Álvarez', avatarUrl: null, xp: 700 },
  { userId: 'u3', fullName: 'Facundo Uria', avatarUrl: null, xp: 500 },
  { userId: 'u4', fullName: 'Seba Torres', avatarUrl: null, xp: 100 },
]

describe('RankingAdmin (Comunidad > Ranking -- panel Admin)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseConfiguracion.mockReturnValue({ configuracion: {} })
    fetchDisciplinasGrupalesAdmin.mockResolvedValue([])
    fetchRankingAdmin.mockResolvedValue(RANKING)
  })

  it('renderiza el podio y el resto de la lista', async () => {
    render(<RankingAdmin />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy())
    expect(screen.getByText('Seba Torres')).toBeTruthy()
    expect(screen.getByText('900 XP')).toBeTruthy()
  })

  it('muestra el botón "Resetear Ranking"', async () => {
    render(<RankingAdmin />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy())
    expect(screen.getByRole('button', { name: /resetear ranking/i })).toBeTruthy()
  })

  it('al hacer clic en "Resetear Ranking" abre el modal con el texto EXACTO de confirmación pedido', async () => {
    render(<RankingAdmin />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /resetear ranking/i }))

    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName.toLowerCase() === 'p' &&
          element.textContent ===
            '¿Estás seguro de que querés reiniciar el ranking? Todos los socios volverán a 0 XP. Esta acción no se puede deshacer.',
      ),
    ).toBeTruthy()
    expect(resetearRankingAdmin).not.toHaveBeenCalled()
  })

  it('si cancela, cierra el modal sin llamar a resetearRankingAdmin', async () => {
    render(<RankingAdmin />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /resetear ranking/i }))

    fireEvent.click(screen.getByRole('button', { name: /^cancelar$/i }))

    expect(resetearRankingAdmin).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^cancelar$/i })).toBeNull()
  })

  it('al confirmar, llama a resetearRankingAdmin, avisa cuántos socios volvieron a 0 XP y refresca el ranking', async () => {
    resetearRankingAdmin.mockResolvedValue(4)
    fetchRankingAdmin.mockResolvedValueOnce(RANKING).mockResolvedValueOnce(RANKING.map((r) => ({ ...r, xp: 0 })))

    render(<RankingAdmin />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /resetear ranking/i }))

    fireEvent.click(screen.getByRole('button', { name: /sí, resetear a 0 xp/i }))

    await waitFor(() => expect(resetearRankingAdmin).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(fetchRankingAdmin).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText(/4 socios volvieron a 0 XP/)).toBeTruthy())
    // El modal se cierra solo tras un reseteo exitoso.
    expect(screen.queryByRole('button', { name: /^cancelar$/i })).toBeNull()
  })

  it('si resetea con 0 socios afectados (ya estaba todo en 0), lo avisa igual sin tratarlo como error', async () => {
    resetearRankingAdmin.mockResolvedValue(0)

    render(<RankingAdmin />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /resetear ranking/i }))
    fireEvent.click(screen.getByRole('button', { name: /sí, resetear a 0 xp/i }))

    await waitFor(() => expect(screen.getByText(/ya estaba en 0 XP para todos/)).toBeTruthy())
  })

  it('si el RPC falla (ej. migración no corrida), muestra el error DENTRO del modal y no lo cierra', async () => {
    resetearRankingAdmin.mockRejectedValue(
      new Error('Todavía no se corrió la migración de reseteo de ranking (supabase_migration_resetear_ranking.sql).'),
    )

    render(<RankingAdmin />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /resetear ranking/i }))
    fireEvent.click(screen.getByRole('button', { name: /sí, resetear a 0 xp/i }))

    await waitFor(() =>
      expect(screen.getByText(/Todavía no se corrió la migración de reseteo de ranking/)).toBeTruthy(),
    )
    // Sigue abierto -- el admin puede reintentar o cancelar, no se pierde el aviso.
    expect(screen.getByRole('button', { name: /^cancelar$/i })).toBeTruthy()
    expect(fetchRankingAdmin).toHaveBeenCalledTimes(1)
  })

  it('con una fecha de reseteo programado futura, muestra el recordatorio visual sin urgencia', async () => {
    mockUseConfiguracion.mockReturnValue({ configuracion: { proximo_reseteo_ranking: '2099-01-01' } })
    render(<RankingAdmin />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy())

    expect(screen.getByText(new RegExp(formatFecha('2099-01-01')))).toBeTruthy()
    expect(screen.getByText(/recordatorio visual/)).toBeTruthy()
  })

  it('con una fecha de reseteo programado ya vencida, avisa que hay que resetear a mano', async () => {
    mockUseConfiguracion.mockReturnValue({ configuracion: { proximo_reseteo_ranking: '2020-01-01' } })
    render(<RankingAdmin />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy())

    expect(screen.getByText(/ya llegó la fecha/)).toBeTruthy()
  })

  it('sin fecha de reseteo programado, no muestra ningún recordatorio', async () => {
    render(<RankingAdmin />)
    await waitFor(() => expect(screen.getByText('Martina Ríos')).toBeTruthy())

    expect(screen.queryByText(/Reseteo programado/)).toBeNull()
  })
})
