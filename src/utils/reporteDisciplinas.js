import { estadoOperativoSocio } from './socioMetrics'

export const ID_SIN_DISCIPLINA = 'sin-disciplina'
export const NOMBRE_SIN_DISCIPLINA = 'Sin disciplina registrada'

// `socios.plan` es un arreglo de nombres (['Aparatos', 'CrossFit']); se
// tolera también un texto suelto. Devuelve null si no hay nada cargado.
//
// "Pase Libre" es el nombre histórico de Aparatos (ya no existe como
// disciplina): se MUESTRA como "Aparatos". Es solo visualización -- no
// cambia a nadie de categoría ni toca socios.plan. El resto va tal cual.
function planComoTexto(plan) {
  const nombres = (Array.isArray(plan) ? plan : [plan])
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .map((p) => (p.toLowerCase() === 'pase libre' ? 'Aparatos' : p))
  const sinRepetir = Array.from(new Set(nombres))
  return sinRepetir.length > 0 ? sinRepetir.join(', ') : null
}

// Desglose de los socios ACTIVOS por disciplina, para Reportes.
//
// "Activo" es exactamente el mismo criterio que la tarjeta principal y que
// Home/Socios (estadoOperativoSocio): por eso un socio dado de baja
// (`activo === false`) queda afuera SIEMPRE, aunque tenga algo vigente.
//
// Un socio activo cuenta en CADA disciplina donde tenga algo vigente:
//   - créditos: al menos un lote con saldo > 0 y sin vencer
//     (`creditosPwaPorDisciplina`, que ya viene filtrado a lotes activos);
//   - membresía (Aparatos): una fila sin vencer (`membresiasVigentes`).
// Por eso la suma de las tarjetas puede superar el total de socios activos.
//
// Los activos SIN ninguna disciplina (socios sin cuenta en la app, cobrados
// por mostrador: están activos por `fecha_vencimiento`, que no dice de qué
// disciplina) van a una categoría aparte, "Sin disciplina registrada" -- no
// se mezclan con Aparatos ni con ninguna otra.
//
// Las tarjetas salen del CATÁLOGO real (`disciplinas`: filas de la tabla
// `disciplines`), no de una lista fija: toda disciplina activa del catálogo
// aparece (aunque tenga 0 socios), y una disciplina desactivada solo aparece
// si todavía tiene socios con algo vigente.
//
// socios: filas de `socios` ya mergeadas con `creditosPwaPorDisciplina`,
//   `aparatosVigenteReal` y `membresiasVigentes`.
// Devuelve { activos, categorias } con cada categoría:
//   { id, nombre, esDisciplina, cantidad, porcentaje, socios: [{ id, nombre, dni }] }
// ordenadas de mayor a menor cantidad ("Sin disciplina registrada" al final).
// `porcentaje` es sobre el total de socios activos (no sobre la suma).
export function desglosePorDisciplina(socios, disciplinas, fechaReferencia = new Date()) {
  const categoriasPorId = new Map()
  const asegurar = (id, nombre) => {
    if (!categoriasPorId.has(id)) categoriasPorId.set(id, { id, nombre, esDisciplina: true, socios: [] })
    return categoriasPorId.get(id)
  }

  const catalogo = disciplinas ?? []
  for (const d of catalogo) {
    if (d.is_active !== false) asegurar(d.id, d.name)
  }
  const nombreEnCatalogo = new Map(catalogo.map((d) => [d.id, d.name]))

  const sinDisciplina = { id: ID_SIN_DISCIPLINA, nombre: NOMBRE_SIN_DISCIPLINA, esDisciplina: false, socios: [] }
  let activos = 0

  for (const socio of socios ?? []) {
    if (estadoOperativoSocio(socio, fechaReferencia) !== 'activo') continue
    activos += 1

    const fila = {
      id: socio.id,
      nombre: [socio.nombre, socio.apellido].filter(Boolean).join(' ').trim() || 'Socio sin nombre',
      dni: socio.dni ?? null,
    }

    const disciplinasDelSocio = new Map()
    for (const c of socio.creditosPwaPorDisciplina ?? []) {
      if ((c.remainingCredits ?? 0) > 0) disciplinasDelSocio.set(c.disciplineId, c.disciplineName)
    }
    for (const m of socio.membresiasVigentes ?? []) disciplinasDelSocio.set(m.disciplineId, m.disciplineName)

    if (disciplinasDelSocio.size === 0) {
      // Dato secundario SOLO para esta categoría: `socios.plan` es el plan
      // administrativo que cargó el admin en el panel -- NO está verificado
      // contra créditos reales de la app (por eso no decide la categoría).
      // `sinCuentaApp`: no se encontró cuenta de la app para su DNI
      // (`aparatosVigenteReal` ausente, ver estadoOperativoSocio).
      sinDisciplina.socios.push({
        ...fila,
        planAdministrativo: planComoTexto(socio.plan),
        sinCuentaApp: socio.aparatosVigenteReal === undefined,
      })
      continue
    }
    for (const [id, nombre] of disciplinasDelSocio) {
      // El nombre del catálogo manda; el del crédito es el respaldo (una
      // disciplina desactivada o que no vino en el catálogo).
      asegurar(id, nombreEnCatalogo.get(id) ?? nombre ?? 'Disciplina').socios.push(fila)
    }
  }

  const porNombre = (a, b) => a.nombre.localeCompare(b.nombre, 'es')
  const cerrar = (categoria) => ({
    ...categoria,
    socios: [...categoria.socios].sort(porNombre),
    cantidad: categoria.socios.length,
    porcentaje: activos > 0 ? Math.round((categoria.socios.length / activos) * 100) : 0,
  })

  const categorias = Array.from(categoriasPorId.values())
    .map(cerrar)
    .sort((a, b) => b.cantidad - a.cantidad || porNombre(a, b))
  if (sinDisciplina.socios.length > 0) categorias.push(cerrar(sinDisciplina))

  return { activos, categorias }
}
