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

  it('con pendientes: cartel con la cantidad y "Ver pendientes"', () => {
    const h = renderAviso({ estado: { cargando: false, error: null, lista: [PENDIENTE] }, mostrarLista: false })
    expect(screen.getByTestId('pendientes-de-cargar').textContent).toContain('1 socio pagó sin cuenta y ya tiene cuenta')
    expect(screen.queryByRole('list', { name: 'Pendientes de cargar' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ver pendientes' }))
    expect(h.onVer).toHaveBeenCalled()
  })

  it('con el filtro activo: lista cada socio con lo de su ficha, el aviso de la fecha y "Cargar créditos"', () => {
    const h = renderAviso({ estado: { cargando: false, error: null, lista: [PENDIENTE, { ...PENDIENTE, socioId: 154, nombre: 'Dario' }] }, mostrarLista: true })
    expect(screen.getByTestId('pendientes-de-cargar').textContent).toContain('2 socios pagaron sin cuenta y ya tienen cuenta')
    const lista = screen.getByRole('list', { name: 'Pendientes de cargar' })
    expect(lista.textContent).toContain('Luna Alvino')
    expect(lista.textContent).toContain('DNI 44986863')
    expect(lista.textContent).toContain('CrossFit, Aparatos · 8 créditos · cobrado hasta el 02/12/2026')
    expect(lista.textContent).toContain('ajustá la fecha al 02/12/2026')
    fireEvent.click(screen.getAllByRole('button', { name: 'Cargar créditos' })[0])
    expect(h.onCargar).toHaveBeenCalledWith(PENDIENTE)
    fireEvent.click(screen.getByRole('button', { name: 'Ver todos los socios' }))
    expect(h.onOcultar).toHaveBeenCalled()
  })

  it('R5: si la consulta falló, lo muestra en rojo con el motivo y "Reintentar"', () => {
    const h = renderAviso({ estado: { cargando: false, error: 'function not found in schema cache', lista: [] } })
    expect(screen.getByRole('alert').textContent).toContain('No se pudo calcular "Pendientes de cargar": function not found in schema cache')
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
