import { supabase } from '../lib/supabaseClient'

// ── Biblioteca de ejercicios ────────────────────────────────────────

export async function fetchExercises() {
  const { data, error } = await supabase.from('exercises').select('*').order('name')
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function saveExercise({ id, name, muscleGroup, description, videoUrl }) {
  const payload = {
    name: name.trim(),
    muscle_group: muscleGroup,
    description: description?.trim() || null,
    video_url: videoUrl?.trim() || null,
  }
  const { data, error } = id
    ? await supabase.from('exercises').update(payload).eq('id', id).select().single()
    : await supabase.from('exercises').insert(payload).select().single()
  if (error) throw new Error(error.message)
  return data
}

// El error se lanza CON el código de Postgres: un 23503 (foreign key) quiere
// decir que el ejercicio está en uso -- desde
// supabase_migration_ejercicios_fk_restrict.sql la base no deja borrarlo
// (antes cascadeaba y desaparecía de todas las rutinas, con los pesos de
// cada socio). La pantalla lo distingue de cualquier otro error.
export const CODIGO_EJERCICIO_EN_USO = '23503'

export async function deleteExercise(id) {
  const { error } = await supabase.from('exercises').delete().eq('id', id)
  if (error) {
    const err = new Error(error.message)
    err.code = error.code
    throw err
  }
}

// Dónde se usa cada ejercicio: rutinas de socios, plantillas, socios y pesos
// cargados. Lo cuenta el servidor (función admin_uso_ejercicios, SECURITY
// DEFINER con is_admin()): los pesos son de otros socios y la RLS no deja
// leerlos desde el panel. `ids` null = todos los ejercicios.
// Devuelve Map exercise_id -> { rutinasAsignadas, plantillas, socios, pesos }.
export async function fetchUsoEjercicios(ids = null) {
  const { data, error } = await supabase.rpc('admin_uso_ejercicios', { p_exercise_ids: ids })
  if (error) throw new Error(error.message)
  return new Map(
    (data ?? []).map((fila) => [
      fila.exercise_id,
      {
        rutinasAsignadas: fila.rutinas_asignadas ?? 0,
        plantillas: fila.plantillas ?? 0,
        socios: fila.socios ?? 0,
        pesos: fila.pesos ?? 0,
      },
    ]),
  )
}

// ── Rutinas (plantillas y asignadas) ────────────────────────────────

// Listado liviano (sin días/ejercicios) para las grillas de Biblioteca y
// Asignación -- el detalle completo se trae aparte solo al abrir el editor.
export async function fetchRoutinesList({ isTemplate }) {
  let query = supabase
    .from('routines')
    .select('id, user_id, title, coach_name, notes, created_at, is_template, profiles(full_name, dni)')
    .order('created_at', { ascending: false })
  if (isTemplate !== undefined) query = query.eq('is_template', isTemplate)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => ({
    id: r.id,
    userId: r.user_id,
    title: r.title,
    coachName: r.coach_name,
    notes: r.notes,
    createdAt: r.created_at,
    isTemplate: r.is_template,
    socioNombre: r.profiles?.full_name ?? null,
    socioDni: r.profiles?.dni ?? null,
  }))
}

// Errores propios del historial de rutinas (supabase_migration_historial_rutinas_f1.sql):
// GFR01 = rutina del historial (solo lectura), GFR02 = una rutina de socio no se borra,
// GFR03 = cambio no permitido, GFR04 = "Guardar cambios" borraría ejercicios con tildes del
// socio (su registro): no se guarda nada y el editor ofrece "Guardar como rutina nueva".
// El mensaje del servidor ya está en criollo.
export const CODIGO_RUTINA_HISTORIAL = 'GFR01'
export const CODIGO_BORRARIA_REGISTRO = 'GFR04'

function errorConCodigo(error) {
  const err = new Error(error.message)
  err.code = error.code
  return err
}

function mapRoutineFull(routine, days) {
  return {
    id: routine.id,
    userId: routine.user_id,
    title: routine.title,
    coachName: routine.coach_name ?? '',
    notes: routine.notes ?? '',
    isTemplate: routine.is_template,
    vigenteDesde: routine.vigente_desde ?? null,
    vigenteHasta: routine.vigente_hasta ?? null,
    days: (days ?? [])
      .slice()
      .sort((a, b) => a.order_index - b.order_index)
      .map((d) => ({
        id: d.id,
        title: d.title,
        orderIndex: d.order_index,
        exercises: (d.routine_exercises ?? [])
          .slice()
          .sort((a, b) => a.order_index - b.order_index)
          .map((re) => {
            const exercise = Array.isArray(re.exercise) ? re.exercise[0] : re.exercise
            return {
              id: re.id,
              exerciseId: re.exercise_id,
              exerciseName: exercise?.name ?? '',
              muscleGroup: exercise?.muscle_group ?? '',
              exerciseDescription: exercise?.description ?? '',
              exerciseVideoUrl: exercise?.video_url ?? '',
              // null de la base -> '' para el formulario: un input con
              // value={null} queda "no controlado" (React avisa y deja de
              // reflejar el estado). Al guardar, '' vuelve a ser null.
              sets: re.sets ?? '',
              reps: re.reps ?? '',
              restSeconds: re.rest_seconds ?? '',
              weightSuggestion: re.weight_suggestion ?? '',
              notes: re.notes ?? '',
              orderIndex: re.order_index,
            }
          }),
      })),
  }
}

export async function fetchRoutineFull(routineId) {
  const { data: routine, error: routineError } = await supabase
    .from('routines')
    .select('*')
    .eq('id', routineId)
    .single()
  if (routineError) throw new Error(routineError.message)

  const { data: days, error: daysError } = await supabase
    .from('routine_days')
    .select(
      'id, title, order_index, routine_exercises(id, exercise_id, sets, reps, rest_seconds, weight_suggestion, notes, order_index, exercise:exercises(id, name, muscle_group, description, video_url))',
    )
    .eq('routine_id', routineId)
  if (daysError) throw new Error(daysError.message)

  return mapRoutineFull(routine, days)
}

const textoONull = (valor) => String(valor ?? '').trim() || null

// Lo que manda el editor -> el JSON que espera admin_guardar_rutina. Los ids de días y
// ejercicios viajan: el servidor actualiza en el lugar lo que sigue (conserva ids y los
// tildes de hoy del socio) en vez de borrar y volver a crear. Vacío -> null (el
// placeholder "ej: 20kg" nunca se guarda). Un bloque sin ejercicio de la biblioteca va
// con `nuevo`: el servidor lo crea en la misma transacción.
export function armarPayloadRutina({ id, title, coachName, notes, userId, days, comoNueva = false }) {
  const payload = {
    id: id ?? null,
    user_id: userId ?? null,
    como_nueva: !!comoNueva,
    title: title.trim(),
    notes: textoONull(notes),
    days: days.map((day, dayIndex) => ({
      id: day.id ?? null,
      title: textoONull(day.title) ?? `Día ${dayIndex + 1}`,
      exercises: day.exercises.map((bloque) => ({
        id: bloque.id ?? null,
        exercise_id: bloque.exerciseId ?? null,
        nuevo: bloque.exerciseId
          ? null
          : {
              name: textoONull(bloque.exerciseName) ?? '',
              muscle_group: bloque.muscleGroup,
              description: textoONull(bloque.exerciseDescription),
              video_url: textoONull(bloque.exerciseVideoUrl),
            },
        sets: Number(bloque.sets) || null,
        reps: textoONull(bloque.reps),
        rest_seconds: Number(bloque.restSeconds) || null,
        weight_suggestion: textoONull(bloque.weightSuggestion),
        notes: textoONull(bloque.notes),
      })),
    })),
  }
  // Solo si se pasa: el editor no edita el coach, y así no lo borra al guardar.
  if (coachName !== undefined) payload.coach_name = textoONull(coachName)
  return payload
}

// Guarda la rutina entera (cabecera + días + ejercicios) en UNA transacción del servidor
// (admin_guardar_rutina). Antes eran decenas de INSERT desde el navegador: si se cortaba a
// mitad quedaba una rutina vacía o incompleta -- así nacieron 9 rutinas vacías en
// producción. Con `id`: "Guardar cambios" (actualiza en el lugar). Con `id` y `comoNueva`:
// "Guardar como rutina nueva" (la actual pasa al historial del socio intacta). Sin `id`:
// crea (con `userId` = rutina del socio, que pasa a ser su vigente; sin él = plantilla).
export async function saveRoutineFull({ id, title, coachName, notes, userId, days, comoNueva = false }) {
  const { data, error } = await supabase.rpc('admin_guardar_rutina', {
    p_rutina: armarPayloadRutina({ id, title, coachName, notes, userId, days, comoNueva }),
  })
  if (error) throw errorConCodigo(error)
  return data
}

// Solo plantillas: las rutinas de los socios no se borran nunca (la base lo rechaza con
// GFR02). En la Fase 2 del historial de rutinas, "Eliminar" pasa a "Archivar".
export async function deleteRoutine(id) {
  const { error } = await supabase.from('routines').delete().eq('id', id)
  if (error) throw errorConCodigo(error)
}

// Duplica una plantilla en la Biblioteca. Para darle una rutina a un socio se usa
// asignarRutina (copia en el servidor, en una transacción).
export async function duplicateRoutine(routineId, { title } = {}) {
  const original = await fetchRoutineFull(routineId)
  return saveRoutineFull({
    id: null,
    title: title ?? `${original.title} (copia)`,
    coachName: original.coachName,
    notes: original.notes,
    userId: null,
    days: original.days.map((day) => ({
      title: day.title,
      exercises: day.exercises.map((bloque) => ({ ...bloque, id: null })),
    })),
  })
}

// Le asigna al socio una COPIA de una plantilla, o de una rutina de su historial ("volver
// a asignar"), como su rutina vigente. La que tenía pasa a su historial, con fecha de fin.
// Todo en el servidor y en una transacción (admin_asignar_rutina). Devuelve el id nuevo.
export async function asignarRutina(userId, origenId) {
  const { data, error } = await supabase.rpc('admin_asignar_rutina', { p_user_id: userId, p_origen_id: origenId })
  if (error) throw errorConCodigo(error)
  return data
}

// ── Asignación a socios ─────────────────────────────────────────────

export async function searchSocios(query) {
  if (!query.trim()) return []
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, dni')
    .eq('role', 'socio')
    .or(`full_name.ilike.%${query.trim()}%,dni.ilike.%${query.trim()}%`)
    .limit(10)
  if (error) throw new Error(error.message)
  return data ?? []
}

// La rutina VIGENTE del socio (vigente_hasta null; la base garantiza que hay una sola).
export async function fetchSocioActiveRoutine(userId) {
  const { data, error } = await supabase
    .from('routines')
    .select('id')
    .eq('user_id', userId)
    .is('vigente_hasta', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return fetchRoutineFull(data.id)
}

// ── Historial de rutinas del socio ──────────────────────────────────

function mapCabeceraRutina(r) {
  return {
    id: r.id,
    title: r.title,
    coachName: r.coach_name ?? null,
    notes: r.notes ?? null,
    createdAt: r.created_at,
    vigenteDesde: r.vigente_desde ?? r.created_at,
    vigenteHasta: r.vigente_hasta ?? null,
  }
}

const masNuevaPrimero = (a, b) => (a.vigenteDesde < b.vigenteDesde ? 1 : a.vigenteDesde > b.vigenteDesde ? -1 : 0)

// La vigente y las anteriores (más nueva primero) de un socio. Las archivadas (las 9
// copias vacías que dejó el panel viejo) no aparecen.
export async function fetchRutinasDelSocio(userId) {
  const { data, error } = await supabase
    .from('routines')
    .select('id, title, coach_name, notes, created_at, is_template, vigente_desde, vigente_hasta, archivada_en')
    .eq('user_id', userId)
    .is('archivada_en', null)
    .order('vigente_desde', { ascending: false })
  if (error) throw new Error(error.message)
  const rutinas = (data ?? []).filter((r) => !r.is_template).map(mapCabeceraRutina)
  return {
    vigente: rutinas.find((r) => !r.vigenteHasta) ?? null,
    anteriores: rutinas.filter((r) => r.vigenteHasta).sort(masNuevaPrimero),
  }
}

// routine_id -> cuántos entrenamientos ("Finalizar") registró el socio en esa rutina.
// Seba ve todos, también los que el socio ocultó. Las sesiones de antes de la Fase 1 no
// tienen rutina todavía (se atribuyen en la Fase 2).
export async function fetchEntrenamientosPorRutina(userId) {
  const { data, error } = await supabase
    .from('routine_history')
    .select('routine_id, sesion_id')
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  const sesiones = new Map()
  for (const fila of data ?? []) {
    if (!fila.routine_id) continue
    if (!sesiones.has(fila.routine_id)) sesiones.set(fila.routine_id, new Set())
    sesiones.get(fila.routine_id).add(fila.sesion_id)
  }
  return new Map(Array.from(sesiones, ([routineId, ids]) => [routineId, ids.size]))
}

// Entrenamientos registrados en UNA rutina, más nuevo primero, con lo que hizo en cada uno
// (foto de ese momento: series, reps y la carga que usó).
export async function fetchSesionesDeRutina(routineId) {
  const { data, error } = await supabase
    .from('routine_history')
    .select('id, sesion_id, fecha, titulo_dia, nombre_ejercicio, series, repeticiones, peso, orden, total_ejercicios, completo, created_at, oculta_en')
    .eq('routine_id', routineId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return agruparSesiones(data ?? [])
}

export function agruparSesiones(filas) {
  const sesiones = new Map()
  for (const f of filas) {
    if (!sesiones.has(f.sesion_id)) {
      sesiones.set(f.sesion_id, {
        sesionId: f.sesion_id,
        fecha: f.fecha,
        creadoEn: f.created_at,
        tituloDia: f.titulo_dia,
        totalEjercicios: f.total_ejercicios,
        completo: f.completo,
        oculta: !!f.oculta_en,
        ejercicios: [],
      })
    }
    sesiones.get(f.sesion_id).ejercicios.push({
      id: f.id,
      nombre: f.nombre_ejercicio,
      series: f.series,
      repeticiones: f.repeticiones,
      peso: f.peso,
      orden: f.orden,
    })
  }
  return Array.from(sesiones.values())
    .map((s) => ({ ...s, ejercicios: s.ejercicios.slice().sort((a, b) => a.orden - b.orden) }))
    .sort((a, b) => (a.creadoEn < b.creadoEn ? 1 : a.creadoEn > b.creadoEn ? -1 : 0))
}
