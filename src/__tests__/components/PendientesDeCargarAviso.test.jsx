import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PendientesDeCargarAviso from '../../components/PendientesDeCargarAviso'
import AvisoSinCuentaModal from '../../components/AvisoSinCuentaModal'

const PENDIENTE = {
  socioId: 153,
  nombre: 'Luna',
  apellido: 'Alvino',
  dni: '44986863',
  plan: ['CrossFit', 'Aparatos'],
  creditosFicha: 8,
  fechaVencimientoFicha: '2026-12-02',
  ultimoPago: '2026-11-02',
}

function renderAviso(props) {
  const handlers = { onVer: vi.fn(), onOcultar: vi.fn(), onCargar: vi.fn(), onReintentar: vi.fn() }
  render(<PendientesDeCargarAviso {...handlers} {...props} />)
  return handlers
}

describe('PendientesDeCargarAviso (T5)', () => {
  it('cargando o sin pendientes: no muestra nada', () => {
    const { container: c1 } = render(<PendientesDeCargarAviso estado={{ cargando: true, error: null, lista: [] }} />)
    expect(c1.innerHTML).toBe('')
    const { container: c2 } = render(<PendientesDeCargarAviso estado={{ cargando: false, error: null, lista: [] }} />)
    expect(c2.innerHTML).toBe('')
  })

  it('con un pendiente: cartel con su nombre y "Ver quiénes"', () => {
    const h = renderAviso({ estado: { cargando: false, error: null, lista: [PENDIENTE] }, mostrarLista: false })
    expect(screen.getByTestId('pendientes-de-cargar').textContent).toContain('Pagos sin cargar en la app: Luna Alvino pagó cuando todavía no tenía cuenta en la app. Ya se registró, pero en la app no le figura lo que pagó. Tocá «Cargar créditos» en cada uno.')
    expect(screen.queryByRole('list', { name: 'Pagos sin cargar en la app' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ver quiénes' }))
    expect(h.onVer).toHaveBeenCalled()
  })

  it('con el filtro activo: lista cada socio con lo de su ficha, el aviso de la fecha y "Cargar créditos"', () => {
    const h = renderAviso({ estado: { cargando: false, error: null, lista: [PENDIENTE, { ...PENDIENTE, socioId: 154, nombre: 'Dario' }] }, mostrarLista: true })
    expect(screen.getByTestId('pendientes-de-cargar').textContent).toContain('Pagos sin cargar en la app: 2 socios pagaron cuando todavía no tenían cuenta en la app. Ya se registraron, pero en la app no les figura lo que pagaron.')
    const lista = screen.getByRole('list', { name: 'Pagos sin cargar en la app' })
    expect(lista.textContent).toContain('Luna Alvino')
    expect(lista.textContent).toContain('DNI 44986863')
    expect(lista.textContent).toContain('Lo que pagó: CrossFit, Aparatos · 8 créditos · hasta el 02/12/2026 · pagó el 02/11/2026')
    expect(lista.textContent).toContain('Al cargar, la fecha queda en hoy + 30 días. Si pagó hasta el 02/12/2026, cambiala a esa fecha.')
    fireEvent.click(screen.getAllByRole('button', { name: 'Cargar créditos' })[0])
    expect(h.onCargar).toHaveBeenCalledWith(PENDIENTE)
    fireEvent.click(screen.getByRole('button', { name: 'Ver todos los socios' }))
    expect(h.onOcultar).toHaveBeenCalled()
  })

  it('R5: si la consulta falló, lo muestra en rojo con el motivo y "Reintentar"', () => {
    const h = renderAviso({ estado: { cargando: false, error: 'function not found in schema cache', lista: [] } })
    expect(screen.getByRole('alert').textContent).toContain('No se pudo calcular "Pagos sin cargar en la app": function not found in schema cache')
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(h.onReintentar).toHaveBeenCalled()
  })
})

describe('AvisoSinCuentaModal (T5)', () => {
  it('sin aviso no muestra nada; con aviso, queda hasta "Entendido"', () => {
    const { container } = render(<AvisoSinCuentaModal aviso={null} onCerrar={vi.fn()} />)
    expect(container.innerHTML).toBe('')

    const onCerrar = vi.fn()
    render(
      <AvisoSinCuentaModal
        aviso={{ titulo: 'Pago guardado en la ficha', mensaje: 'Este socio no tiene cuenta en la app.', detalle: 'Anotá lo cobrado: CrossFit 8 créditos.', extra: 'otro aviso' }}
        onCerrar={onCerrar}
      />,
    )
    const dialogo = screen.getByRole('alertdialog', { name: 'Pago guardado en la ficha' })
    expect(dialogo.textContent).toContain('Este socio no tiene cuenta en la app.')
    expect(dialogo.textContent).toContain('Anotá lo cobrado: CrossFit 8 créditos.')
    expect(dialogo.textContent).toContain('otro aviso')
    fireEvent.click(screen.getByRole('button', { name: 'Entendido' }))
    expect(onCerrar).toHaveBeenCalled()
  })
})
