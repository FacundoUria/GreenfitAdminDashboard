export function colorOcupacion(porcentaje) {
  if (porcentaje >= 90) return { barra: 'bg-red-500', texto: 'text-red-400' }
  if (porcentaje >= 60) return { barra: 'bg-amber-500', texto: 'text-amber-400' }
  return { barra: 'bg-greenfit-primary', texto: 'text-greenfit-primary' }
}
