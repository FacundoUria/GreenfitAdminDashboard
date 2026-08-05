import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import SociosTabla from '../../components/SociosTabla'

// La tabla renderiza SIEMPRE las dos variantes (tarjetas para mobile, tabla
// para desktop) -- jsdom no evalúa media queries, así que un mismo dato
// puede aparecer 2 veces en el árbol (una por variante). Se usa getAllBy*
// a propósito en vez de getBy* para no chocar con eso.

const HANDLERS = {
  onRegistrarPago: vi.fn(),
  onEditar: vi.fn(),
  onAjustarCredito: vi.fn(),
  onAbrirWhatsapp: vi.fn(),
  onCambiarBaja: vi.fn(),
  seleccionados: new Set(),
  onToggleSeleccionado: vi.fn(),
  onToggleSeleccionarTodos: vi.fn(),
}

const SOCIO_CON_FOTO = {
  id: 's1',
  nombre: 'Martina',
  apellido: 'Ríos',
  dni: '30111222',
  email: 'martina@mail.com',
  plan: ['CrossFit'],
  creditos: 4,
  activo: true,
  estado: 'activo',
  avatarUrl: 'https://cdn.supabase.co/avatars/u1/avatar.jpg',
  nivelXp: 3,
}

const SOCIO_SIN_FOTO = {
  id: 's2',
  nombre: 'Bruno',
  apellido: 'Álvarez',
  dni: '30999888',
  email: 'bruno@mail.com',
  plan: ['Aparatos / Musculación'],
  creditos: 0,
  activo: true,
  estado: 'activo',
  avatarUrl: null,
  nivelXp: null,
}

describe('SociosTabla -- avatar sincronizado con la PWA + badge de nivel (Ficha 360°, punto a)', () => {
  it('renderiza el avatar_url real como <img> cuando el socio tiene foto', () => {
    render(<SociosTabla socios={[SOCIO_CON_FOTO]} {...HANDLERS} />)
    const imagenes = screen.getAllByRole('img').filter((img) => img.getAttribute('src') === SOCIO_CON_FOTO.avatarUrl)
    expect(imagenes.length).toBeGreaterThan(0)
  })

  it('muestra el badge "N{nivel}" junto al nombre cuando hay XP calculada', () => {
    render(<SociosTabla socios={[SOCIO_CON_FOTO]} {...HANDLERS} />)
    expect(screen.getAllByText('N3').length).toBeGreaterThan(0)
  })

  it('sin foto, cae al fallback de iniciales (no rompe ni muestra un <img> roto)', () => {
    render(<SociosTabla socios={[SOCIO_SIN_FOTO]} {...HANDLERS} />)
    expect(screen.getAllByText('BÁ').length).toBeGreaterThan(0)
  })

  it('sin nivel resuelto todavía, no muestra ningún badge "N..."', () => {
    render(<SociosTabla socios={[SOCIO_SIN_FOTO]} {...HANDLERS} />)
    expect(screen.queryByText(/^N\d+$/)).toBeNull()
  })
})
