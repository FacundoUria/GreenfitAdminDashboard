// Paleta por grupo muscular para los badges de ejercicios -- mismo patrón
// que colorDisciplina en ClasesGrid.jsx (texto libre, normalizado a
// minúsculas, con un color por defecto para lo que no matchea).
export const GRUPOS_MUSCULARES = [
  'Pecho',
  'Espalda',
  'Piernas',
  'Hombros',
  'Bíceps',
  'Tríceps',
  'Core / Abdomen',
  'Glúteos',
  'Cardio',
  'Cuerpo completo',
]

const COLORES_GRUPO = {
  pecho: { bg: 'bg-orange-500/15', text: 'text-orange-400' },
  espalda: { bg: 'bg-sky-500/15', text: 'text-sky-400' },
  piernas: { bg: 'bg-purple-500/15', text: 'text-purple-400' },
  hombros: { bg: 'bg-amber-500/15', text: 'text-amber-400' },
  'bíceps': { bg: 'bg-rose-500/15', text: 'text-rose-400' },
  biceps: { bg: 'bg-rose-500/15', text: 'text-rose-400' },
  'tríceps': { bg: 'bg-pink-500/15', text: 'text-pink-400' },
  triceps: { bg: 'bg-pink-500/15', text: 'text-pink-400' },
  'core / abdomen': { bg: 'bg-teal-500/15', text: 'text-teal-400' },
  core: { bg: 'bg-teal-500/15', text: 'text-teal-400' },
  'gluteos': { bg: 'bg-fuchsia-500/15', text: 'text-fuchsia-400' },
  'glúteos': { bg: 'bg-fuchsia-500/15', text: 'text-fuchsia-400' },
  cardio: { bg: 'bg-red-500/15', text: 'text-red-400' },
  'cuerpo completo': { bg: 'bg-greenfit-primary/15', text: 'text-greenfit-primary' },
  default: { bg: 'bg-white/10', text: 'text-gray-300' },
}

export function colorGrupoMuscular(grupo) {
  const clave = (grupo ?? '').trim().toLowerCase()
  return COLORES_GRUPO[clave] ?? COLORES_GRUPO.default
}
