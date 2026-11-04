import { estadoOperativoSocio } from './socioMetrics'
import {
  fetchAvataresYNiveles,
  fetchCreditosPorDisciplina,
  fetchMembresiasVigentesPorDni,
  fetchTodosLosSocios,
} from './fichaSocioPwa'

// Tanda A -- UNA sola manera de cargar y de decidir quién es "activo", para
// Home, Socios y Reportes.
//
// Por qué existe (caso real, Reportes vs Socios diferían en 1): las tres
// pantallas ya llamaban a la misma estadoOperativoSocio(), pero cada una le
// pasaba DATOS distintos. Socios y Home traían `socios` sin paginar (tope de
// 1000 de Supabase, con 1016 socios en producción) y Reportes sí paginaba:
// un socio activo que caía fuera de las primeras 1000 filas contaba en
// Reportes y no en Socios. Además Socios/Home calculaban el número ANTES de
// que llegaran créditos y Aparatos (71 -> 102 a los segundos).
//
// Ahora las tres pantallas:
//   1. cargan con cargarSociosConDatosPwa() -- TODOS los socios, paginados, y
//      sus créditos/Aparatos reales, todo junto; si cualquier parte falla,
//      LANZA (R5): nunca se devuelve una lista cortada ni un Map vacío;
//   2. arman cada socio con combinarSocioConPwa();
//   3. deciden con esSocioActivo() / estadoOperativoSocio().
// Si las tres usan esto, no pueden volver a diferir.

// Lo que necesita estadoOperativoSocio() además de la fila de `socios`.
// `aparatosVigenteReal` es TRI-ESTADO (true | false | undefined, ver
// fetchMembresiasVigentesPorDni): se pasa CRUDO, nunca coercionado.
export function combinarSocioConPwa(socio, { creditosPorDni, membresias }) {
  return {
    ...socio,
    creditosPwaPorDisciplina: creditosPorDni.get(socio.dni) ?? [],
    aparatosVigenteReal: membresias.vigentePorDni.get(socio.dni),
    membresiasVigentes: membresias.disciplinasPorDni.get(socio.dni) ?? [],
  }
}

// La ÚNICA definición de "socio activo" del panel.
export function esSocioActivo(socioCombinado, fechaReferencia = new Date()) {
  return estadoOperativoSocio(socioCombinado, fechaReferencia) === 'activo'
}

// Créditos + Aparatos (+ avatar/nivel si `conNiveles`) de esos DNIs, todo con
// `lanzarSiFalla`: o llega todo, o se lanza.
export async function cargarDatosPwaDeSocios(dnis, { conNiveles = false } = {}) {
  const opciones = { lanzarSiFalla: true }
  const [creditosPorDni, membresias, gamificacionPorDni] = await Promise.all([
    fetchCreditosPorDisciplina(dnis, opciones),
    fetchMembresiasVigentesPorDni(dnis, opciones),
    conNiveles ? fetchAvataresYNiveles(dnis, opciones) : Promise.resolve(new Map()),
  ])
  return { creditosPorDni, membresias, gamificacionPorDni }
}

export class ErrorCargaSocios extends Error {}

// TODOS los socios (paginados, orden fijo por id) + sus datos de la app.
// Lanza ErrorCargaSocios si falla la tabla `socios`, o el error de la parte
// de la app que haya fallado.
export async function cargarSociosConDatosPwa({ conNiveles = false } = {}) {
  const { data, error } = await fetchTodosLosSocios()
  if (error) throw new ErrorCargaSocios(`No se pudieron cargar los socios: ${error.message}`)
  const filas = data ?? []
  const datos = await cargarDatosPwaDeSocios(
    filas.map((s) => s.dni),
    { conNiveles },
  )
  return { filas, ...datos }
}
