// Colores por disciplina del panel -- fuente única. Son los mismos que ya
// usaba la grilla de Clases (ClasesGrid.jsx), ahora compartidos con Reportes.
// El nombre de la disciplina es texto libre del catálogo: se matchea por
// "contiene" (ej. "CrossFit Turno Mañana" -> crossfit), y cualquier
// disciplina nueva cae al verde institucional (`default`).
//
// Las clases van escritas enteras (no armadas con plantillas) porque Tailwind
// solo genera las que encuentra como texto literal en el código.
export const COLORES_DISCIPLINA = {
  crossfit: {
    header: 'from-orange-600 to-orange-500',
    dot: 'bg-orange-400',
    texto: 'text-orange-400',
    chip: 'bg-orange-400/10',
  },
  boxeo: { header: 'from-red-600 to-red-500', dot: 'bg-red-400', texto: 'text-red-400', chip: 'bg-red-400/10' },
  kickstrike: { header: 'from-rose-600 to-rose-500', dot: 'bg-rose-400', texto: 'text-rose-400', chip: 'bg-rose-400/10' },
  musculación: { header: 'from-sky-600 to-sky-500', dot: 'bg-sky-400', texto: 'text-sky-400', chip: 'bg-sky-400/10' },
  aparatos: { header: 'from-sky-600 to-sky-500', dot: 'bg-sky-400', texto: 'text-sky-400', chip: 'bg-sky-400/10' },
  yoga: { header: 'from-purple-600 to-purple-500', dot: 'bg-purple-400', texto: 'text-purple-400', chip: 'bg-purple-400/10' },
  funcional: { header: 'from-teal-600 to-teal-500', dot: 'bg-teal-400', texto: 'text-teal-400', chip: 'bg-teal-400/10' },
  default: {
    header: 'from-greenfit-primary to-lime-500',
    dot: 'bg-greenfit-primary',
    texto: 'text-greenfit-primary',
    chip: 'bg-greenfit-primary/10',
  },
}

// Para categorías que no son una disciplina (ej. "Sin disciplina registrada").
export const COLOR_NEUTRO = { header: 'from-gray-600 to-gray-500', dot: 'bg-gray-500', texto: 'text-gray-400', chip: 'bg-gray-500/10' }

export function colorDisciplina(disciplina) {
  const nombre = (disciplina ?? '').toLowerCase()
  const clave = Object.keys(COLORES_DISCIPLINA).find((c) => c !== 'default' && nombre.includes(c))
  return COLORES_DISCIPLINA[clave ?? 'default']
}
