import { describe, it, expect } from 'vitest'
import { avisoSinCuenta, detalleDelCobro, tieneDniValido, TEXTO_SIN_CUENTA, TEXTO_SIN_DNI } from '../../utils/avisoSinCuenta'

// T5 -- el copiador de la app ya no copia la ficha a user_credits: cobrar a un
// socio sin cuenta deja el pago SOLO en la ficha y Seba tiene que cargarle los
// créditos después. El aviso se lo dice (en vez de "Pago registrado
// correctamente") y le deja anotado lo cobrado.
describe('avisoSinCuenta (T5)', () => {
  it('con DNI válido: "no tiene cuenta... cargale los créditos desde Editar Socio → Créditos" + lo cobrado', () => {
    const aviso = avisoSinCuenta({ dni: '30222333', detalle: 'CrossFit 8 créditos — vence el 02/12/2026' })
    expect(aviso.titulo).toBe('Pago guardado en la ficha')
    expect(aviso.mensaje).toBe(TEXTO_SIN_CUENTA)
    expect(aviso.mensaje).toContain('Este socio no tiene cuenta en la app. Cuando se registre, cargale los créditos desde Editar Socio → Créditos.')
    expect(aviso.detalle).toBe('Anotá lo cobrado: CrossFit 8 créditos — vence el 02/12/2026.')
    expect(aviso.extra).toBeNull()
  })

  it('sin DNI (null, vacío o "."): explica que sin DNI no puede tener cuenta', () => {
    for (const dni of [null, undefined, '', '.', '12345', 'abc12345']) {
      expect(avisoSinCuenta({ dni }).mensaje).toBe(TEXTO_SIN_DNI)
    }
  })

  it('error al verificar la cuenta (R5): no dice "no tiene cuenta", dice que no se pudo verificar', () => {
    const aviso = avisoSinCuenta({ dni: '30222333', errorVerificacion: 'Failed to fetch' })
    expect(aviso.mensaje).toContain('No se pudo verificar si el socio tiene cuenta en la app (Failed to fetch)')
    expect(aviso.mensaje).not.toContain('no tiene cuenta en la app.')
  })

  it('conserva otro aviso del mismo cobro (extra) y acepta otro título (alta)', () => {
    const aviso = avisoSinCuenta({ dni: '30222333', extra: 'la fecha de inicio no se guardó', titulo: 'Socio guardado en la ficha' })
    expect(aviso.extra).toBe('la fecha de inicio no se guardó')
    expect(aviso.titulo).toBe('Socio guardado en la ficha')
    expect(aviso.detalle).toBeNull()
  })
})

describe('detalleDelCobro (T5)', () => {
  it('créditos por disciplina + actividades por vencimiento + fecha', () => {
    expect(
      detalleDelCobro({
        creditosPorDisciplina: [
          { disciplina: 'CrossFit', cantidad: 8 },
          { disciplina: 'Boxeo', cantidad: 8 },
          { disciplina: 'Kickstrike', cantidad: 0 },
        ],
        plan: ['CrossFit', 'Boxeo', 'Aparatos'],
        fechaVencimiento: '2026-12-02',
      }),
    ).toBe('CrossFit 8 créditos, Boxeo 8 créditos, Aparatos — vence el 02/12/2026')
  })

  it('solo fecha, o nada', () => {
    expect(detalleDelCobro({ plan: [], fechaVencimiento: '2026-12-02' })).toBe('vence el 02/12/2026')
    expect(detalleDelCobro({})).toBe('')
  })
})

describe('tieneDniValido (T5)', () => {
  it('6 a 10 dígitos, mismo criterio que el trigger que crea la cuenta', () => {
    expect(tieneDniValido('123456')).toBe(true)
    expect(tieneDniValido('1234567890')).toBe(true)
    expect(tieneDniValido(' 30111222 ')).toBe(true)
    expect(tieneDniValido('12345')).toBe(false)
    expect(tieneDniValido('12345678901')).toBe(false)
    expect(tieneDniValido('30.111.222')).toBe(false)
    expect(tieneDniValido(null)).toBe(false)
  })
})
