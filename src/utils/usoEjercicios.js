// Dónde se usa un ejercicio de la biblioteca (lo cuenta la función
// admin_uso_ejercicios del servidor, ver fetchUsoEjercicios en routinesApi.js)
// y los textos que ve Seba antes de borrar.
//
// Desde supabase_migration_ejercicios_fk_restrict.sql la base NO deja borrar
// un ejercicio que esté en alguna rutina (de un socio o plantilla) o que tenga
// pesos cargados por algún socio: antes el borrado cascadeaba en silencio y
// el ejercicio desaparecía de todas las rutinas, con los pesos de cada socio.

// uso: { rutinasAsignadas, plantillas, socios, pesos } (todos números).
export function estaEnUso(uso) {
  if (!uso) return false
  return uso.rutinasAsignadas > 0 || uso.plantillas > 0 || uso.pesos > 0
}

function plural(n, singular, pluralTexto) {
  return `${n} ${n === 1 ? singular : pluralTexto}`
}

// Etiqueta corta para la fila de la biblioteca, ej. "En uso: 3 rutinas, 1 plantilla".
export function textoUsoCorto(uso) {
  const partes = []
  if (uso.rutinasAsignadas > 0) partes.push(plural(uso.rutinasAsignadas, 'rutina', 'rutinas'))
  if (uso.plantillas > 0) partes.push(plural(uso.plantillas, 'plantilla', 'plantillas'))
  if (uso.pesos > 0) partes.push(`pesos de ${plural(uso.pesos, 'socio', 'socios')}`)
  return `En uso: ${partes.join(', ')}`
}

// Por qué no se puede borrar, ej. "No se puede borrar: lo usan 3 rutinas de 2 socios y 1 plantilla."
export function textoNoSePuedeBorrar(uso) {
  const usos = []
  if (uso.rutinasAsignadas > 0) {
    usos.push(
      `${plural(uso.rutinasAsignadas, 'rutina', 'rutinas')} de ${plural(uso.socios, 'socio', 'socios')}`,
    )
  }
  if (uso.plantillas > 0) usos.push(plural(uso.plantillas, 'plantilla', 'plantillas'))

  const frases = []
  if (usos.length > 0) {
    const verbo = uso.rutinasAsignadas + uso.plantillas === 1 ? 'lo usa' : 'lo usan'
    frases.push(`${verbo} ${usos.join(' y ')}`)
  }
  if (uso.pesos > 0) frases.push(`tiene pesos cargados por ${plural(uso.pesos, 'socio', 'socios')}`)

  return `No se puede borrar: ${frases.join(', y ')}.`
}
