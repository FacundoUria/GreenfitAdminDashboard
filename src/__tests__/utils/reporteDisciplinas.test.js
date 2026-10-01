import { describe, it, expect } from 'vitest'
import { desglosePorDisciplina, ID_SIN_DISCIPLINA, NOMBRE_SIN_DISCIPLINA } from '../../utils/reporteDisciplinas'
import { getSocioMetrics } from '../../utils/socioMetrics'

const FUTURO = '2099-01-01'
const CATALOGO = [
  { id: 'ap', name: 'Aparatos', kind: 'membership', is_active: true },
  { id: 'bx', name: 'Boxeo', kind: 'credits', is_active: true },
  { id: 'cf', name: 'CrossFit', kind: 'credits', is_active: true },
]

const socio = (id, nombre, extra = {}) => ({ id, nombre, apellido: 'Test', dni: `dni-${id}`, activo: true, ...extra })
const cred = (id, nombre, n = 4) => ({ disciplineId: id, disciplineName: nombre, remainingCredits: n })
const aparatos = { aparatosVigenteReal: true, membresiasVigentes: [{ disciplineId: 'ap', disciplineName: 'Aparatos' }] }
const conCuentaSinNada = { aparatosVigenteReal: false }

const porId = (resultado, id) => resultado.categorias.find((c) => c.id === id)

describe('desglosePorDisciplina', () => {
  it('el total de activos coincide SIEMPRE con getSocioMetrics (misma fuente que Home/Socios)', () => {
    const socios = [
      socio(1, 'Ana', { creditosPwaPorDisciplina: [cred('cf', 'CrossFit')], ...conCuentaSinNada }),
      socio(2, 'Beto', aparatos),
      socio(3, 'Mostrador', { fecha_vencimiento: FUTURO }), // sin cuenta en la app
      socio(4, 'Baja', { activo: false, creditosPwaPorDisciplina: [cred('cf', 'CrossFit')] }),
      socio(5, 'Vencido', { ...conCuentaSinNada, fecha_vencimiento: '2020-01-01' }),
      socio(6, 'SinNada', conCuentaSinNada),
    ]
    const resultado = desglosePorDisciplina(socios, CATALOGO)
    expect(resultado.activos).toBe(getSocioMetrics(socios).activos)
    expect(resultado.activos).toBe(3)
  })

  it('un socio cuenta en cada disciplina donde tiene algo vigente; el porcentaje es sobre los activos', () => {
    const socios = [
      socio(1, 'Ana', { creditosPwaPorDisciplina: [cred('cf', 'CrossFit'), cred('bx', 'Boxeo')], ...aparatos }),
      socio(2, 'Beto', { creditosPwaPorDisciplina: [cred('cf', 'CrossFit')], ...conCuentaSinNada }),
    ]
    const r = desglosePorDisciplina(socios, CATALOGO)

    expect(r.activos).toBe(2)
    expect(porId(r, 'cf')).toMatchObject({ cantidad: 2, porcentaje: 100 })
    expect(porId(r, 'bx')).toMatchObject({ cantidad: 1, porcentaje: 50 })
    expect(porId(r, 'ap')).toMatchObject({ cantidad: 1, porcentaje: 50 })
    // La suma de las tarjetas (4) supera el total de activos (2).
    expect(r.categorias.reduce((s, c) => s + c.cantidad, 0)).toBeGreaterThan(r.activos)
  })

  it('un dado de baja no cuenta en ninguna disciplina aunque tenga créditos y Aparatos vigentes', () => {
    const r = desglosePorDisciplina(
      [socio(1, 'Baja', { activo: false, creditosPwaPorDisciplina: [cred('cf', 'CrossFit')], ...aparatos })],
      CATALOGO,
    )
    expect(r.activos).toBe(0)
    expect(r.categorias.every((c) => c.cantidad === 0)).toBe(true)
    expect(porId(r, ID_SIN_DISCIPLINA)).toBeUndefined()
  })

  it('activos sin ninguna disciplina (mostrador) van a "Sin disciplina registrada", al final, y no a Aparatos', () => {
    const r = desglosePorDisciplina(
      [socio(1, 'Lucía', { fecha_vencimiento: FUTURO }), socio(2, 'Beto', aparatos)],
      CATALOGO,
    )
    const sin = porId(r, ID_SIN_DISCIPLINA)
    expect(sin).toMatchObject({ nombre: NOMBRE_SIN_DISCIPLINA, esDisciplina: false, cantidad: 1 })
    expect(sin.socios).toEqual([
      { id: 1, nombre: 'Lucía Test', dni: 'dni-1', planAdministrativo: null, sinCuentaApp: true },
    ])
    expect(porId(r, 'ap').socios.map((s) => s.id)).toEqual([2])
    expect(r.categorias.at(-1).id).toBe(ID_SIN_DISCIPLINA)
  })

  it('"Sin disciplina registrada" lleva el plan administrativo (socios.plan) como dato secundario; las disciplinas reales no', () => {
    const r = desglosePorDisciplina(
      [
        socio(1, 'Lucía', { fecha_vencimiento: FUTURO, plan: ['Pase Libre'] }),
        socio(2, 'Mora', { fecha_vencimiento: FUTURO, plan: ['Aparatos', ' CrossFit '] }),
        socio(3, 'Nico', { fecha_vencimiento: FUTURO, plan: [] }),
        socio(4, 'Beto', { ...aparatos, plan: ['Aparatos'] }),
      ],
      CATALOGO,
    )
    const sin = porId(r, ID_SIN_DISCIPLINA).socios
    expect(sin.map((s) => [s.nombre, s.planAdministrativo, s.sinCuentaApp])).toEqual([
      ['Lucía Test', 'Pase Libre', true],
      ['Mora Test', 'Aparatos, CrossFit', true],
      ['Nico Test', null, true],
    ])
    // El plan administrativo NO decide la categoría: Mora no cuenta en CrossFit.
    expect(porId(r, 'cf').cantidad).toBe(0)
    expect(porId(r, 'ap').socios).toEqual([{ id: 4, nombre: 'Beto Test', dni: 'dni-4' }])
  })

  it('usa el catálogo real: disciplina nueva con 0, desactivada solo si todavía tiene socios, y el nombre del catálogo manda', () => {
    const catalogo = [
      ...CATALOGO,
      { id: 'yg', name: 'Yoga', kind: 'credits', is_active: true },
      { id: 'sp', name: 'Spinning', kind: 'credits', is_active: false },
      { id: 'pl', name: 'Pilates (renombrada)', kind: 'credits', is_active: false },
    ]
    const r = desglosePorDisciplina(
      [socio(1, 'Ana', { creditosPwaPorDisciplina: [cred('pl', 'Pilates')], ...conCuentaSinNada })],
      catalogo,
    )
    expect(porId(r, 'yg')).toMatchObject({ nombre: 'Yoga', cantidad: 0 })
    expect(porId(r, 'sp')).toBeUndefined() // desactivada y sin socios
    expect(porId(r, 'pl')).toMatchObject({ nombre: 'Pilates (renombrada)', cantidad: 1 })
  })

  it('créditos en 0 no cuentan; orden: de mayor a menor cantidad, y los socios por nombre', () => {
    const r = desglosePorDisciplina(
      [
        socio(1, 'Zoe', { creditosPwaPorDisciplina: [cred('bx', 'Boxeo')], ...conCuentaSinNada }),
        socio(2, 'Ana', { creditosPwaPorDisciplina: [cred('bx', 'Boxeo'), cred('cf', 'CrossFit', 0)], ...conCuentaSinNada }),
      ],
      CATALOGO,
    )
    expect(r.categorias.map((c) => c.id)).toEqual(['bx', 'ap', 'cf'])
    expect(porId(r, 'cf').cantidad).toBe(0)
    expect(porId(r, 'bx').socios.map((s) => s.nombre)).toEqual(['Ana Test', 'Zoe Test'])
  })

  it('sin socios o sin catálogo no rompe', () => {
    expect(desglosePorDisciplina([], [])).toEqual({ activos: 0, categorias: [] })
    expect(desglosePorDisciplina(null, null)).toEqual({ activos: 0, categorias: [] })
  })
})
