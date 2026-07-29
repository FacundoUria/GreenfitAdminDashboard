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

export async function deleteExercise(id) {
  const { error } = await supabase.from('exercises').delete().eq('id', id)
  if (error) throw new Error(error.message)
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

function mapRoutineFull(routine, days) {
  return {
    id: routine.id,
    userId: routine.user_id,
    title: routine.title,
    coachName: routine.coach_name ?? '',
    notes: routine.notes ?? '',
    isTemplate: routine.is_template,
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
              sets: re.sets,
              reps: re.reps,
              restSeconds: re.rest_seconds,
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

// Guarda la rutina entera (título/coach/notas + días + ejercicios) de una.
// Estrategia simple: upsert la cabecera, borrar todos los días existentes
// (cascadea a routine_exercises) y volver a insertar los del formulario tal
// cual quedaron editados -- evita tener que diffear árboles anidados. Ojo:
// esto reinicia routine_completions de esos ejercicios (cascade), aceptable
// porque el progreso que importa es el de HOY, no un historial.
export async function saveRoutineFull({ id, title, coachName, notes, isTemplate, userId, days }) {
  const cabecera = {
    title: title.trim(),
    coach_name: coachName?.trim() || null,
    notes: notes?.trim() || null,
    is_template: isTemplate,
    user_id: userId || null,
  }

  let routineId = id
  if (routineId) {
    const { error } = await supabase.from('routines').update(cabecera).eq('id', routineId)
    if (error) throw new Error(error.message)
    const { error: deleteError } = await supabase.from('routine_days').delete().eq('routine_id', routineId)
    if (deleteError) throw new Error(deleteError.message)
  } else {
    const { data, error } = await supabase.from('routines').insert(cabecera).select('id').single()
    if (error) throw new Error(error.message)
    routineId = data.id
  }

  for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
    const day = days[dayIndex]
    const { data: dayRow, error: dayError } = await supabase
      .from('routine_days')
      .insert({ routine_id: routineId, title: day.title.trim() || `Día ${dayIndex + 1}`, order_index: dayIndex })
      .select('id')
      .single()
    if (dayError) throw new Error(dayError.message)

    for (let exIndex = 0; exIndex < day.exercises.length; exIndex += 1) {
      const bloque = day.exercises[exIndex]
      let exerciseId = bloque.exerciseId
      if (!exerciseId) {
        const nuevo = await saveExercise({
          name: bloque.exerciseName,
          muscleGroup: bloque.muscleGroup,
          description: bloque.exerciseDescription,
          videoUrl: bloque.exerciseVideoUrl,
        })
        exerciseId = nuevo.id
      }

      const { error: reError } = await supabase.from('routine_exercises').insert({
        day_id: dayRow.id,
        exercise_id: exerciseId,
        sets: Number(bloque.sets) || null,
        reps: bloque.reps?.trim() || null,
        rest_seconds: Number(bloque.restSeconds) || null,
        weight_suggestion: bloque.weightSuggestion?.trim() || null,
        notes: bloque.notes?.trim() || null,
        order_index: exIndex,
      })
      if (reError) throw new Error(reError.message)
    }
  }

  return routineId
}

export async function deleteRoutine(id) {
  const { error } = await supabase.from('routines').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// Duplica una rutina (plantilla o asignada) completa -- útil tanto para
// "duplicar" en la Biblioteca como para asignar una plantilla a un socio
// (se duplica la plantilla con user_id del socio e is_template=false).
export async function duplicateRoutine(routineId, { title, userId, isTemplate }) {
  const original = await fetchRoutineFull(routineId)
  return saveRoutineFull({
    id: null,
    title: title ?? `${original.title} (copia)`,
    coachName: original.coachName,
    notes: original.notes,
    isTemplate: isTemplate ?? original.isTemplate,
    userId: userId ?? null,
    days: original.days,
  })
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

export async function fetchSocioActiveRoutine(userId) {
  const { data, error } = await supabase
    .from('routines')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return fetchRoutineFull(data.id)
}
