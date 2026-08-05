import { calcularEstadoCuota } from './fecha'

// Fuente ÚNICA de verdad para "¿este socio está Activo, en Tolerancia o
// Vencido?" -- Home.jsx y Socios.jsx antes tenían dos criterios DISTINTOS
// para lo mismo (Home ignoraba a los socios sin fecha_vencimiento, Socios
// los hacía caer a `socios.estado`, un texto libre legacy que puede estar
// desactualizado), lo que producía números distintos para la misma
// etiqueta ("Socios Activos"/"Cuotas Vencidas") en las dos pantallas.
//
// Reglas (únicas, válidas para toda la app):
// - Dado de baja (`activo === false`): 'inactivo' -- aparte de
//   Activo/Vencido/Tolerancia, no se mezcla con el estado de pago.
// - Con fecha de vencimiento: 'activo' si vencimiento >= hoy, 'tolerancia'
//   si está vencido pero todavía dentro de `diasTolerancia`, 'vencido' si
//   superó la tolerancia (calcularEstadoCuota ya resuelve esto).
// - SIN fecha de vencimiento (planes de créditos sin membresía por fecha,
//   ej. CrossFit/Boxeo -- no tienen una "cuota" que pueda vencer): 'activo'.
//   Nunca cae a un texto legacy sin validar.
//
// Acepta tanto filas crudas de Supabase (`fecha_vencimiento`, snake_case)
// como el objeto ya mapeado que arma Socios.jsx (`fechaVencimiento`,
// camelCase) -- así Home y Socios pueden llamar exactamente la misma
// función sin tener que normalizar el shape antes.
export function estadoOperativoSocio(socio, diasTolerancia = 5, fechaReferencia = new Date()) {
  if (socio.activo === false) return 'inactivo'
  const fechaVencimiento = socio.fecha_vencimiento ?? socio.fechaVencimiento ?? null
  const estadoPorFecha = calcularEstadoCuota(fechaVencimiento, diasTolerancia, fechaReferencia)
  return estadoPorFecha ?? 'activo'
}

// Conteos para las tarjetas de KPI de Home y Socios -- ambas pantallas
// deben llamar a ESTA función (no reimplementar el filtro) para garantizar
// que muestren exactamente el mismo número.
export function getSocioMetrics(socios, diasTolerancia = 5, fechaReferencia = new Date()) {
  const metrics = { activos: 0, vencidos: 0, tolerancia: 0, inactivos: 0 }
  for (const socio of socios ?? []) {
    const estado = estadoOperativoSocio(socio, diasTolerancia, fechaReferencia)
    if (estado === 'activo') metrics.activos += 1
    else if (estado === 'vencido') metrics.vencidos += 1
    else if (estado === 'tolerancia') metrics.tolerancia += 1
    else metrics.inactivos += 1
  }
  return metrics
}
