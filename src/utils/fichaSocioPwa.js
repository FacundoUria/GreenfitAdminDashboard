import { supabase } from '../lib/supabaseClient'

// Puente de lectura entre el panel admin (tabla legacy `socios`) y el schema
// real que usa la PWA de socios (profiles/bookings/xp_events/routines,
// mismo proyecto de Supabase) -- ver creditosPwa.js para el puente de
// ESCRITURA equivalente (créditos/vencimiento/baja). Todo acá se resuelve
// por DNI (profiles.dni = socios.dni), igual que el resto del panel.
//
// Requiere backend/../supabase_migration_ficha360.sql corrida (amplía
// xp_events a admin + crea pagos_socio) -- hasta entonces, todo lo de acá
// cae con gracia a "vacío" en vez de romper la ficha del socio.

export const XP_POR_NIVEL = 500

export function calcularNivel(totalXp) {
  return Math.floor(Math.max(0, totalXp ?? 0) / XP_POR_NIVEL) + 1
}

// 42P01 = undefined_table (Postgres). PGRST205/PGRST202 = PostgREST no
// encuentra la tabla/función -- mismo criterio "todavía no existe" que ya
// usa la PWA (comunidadApi.ts / xpApi.ts).
function esErrorDeRelacionFaltante(error) {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST202') return true
  const mensaje = (error.message ?? '').toLowerCase()
  return mensaje.includes('does not exist') || mensaje.includes('schema cache') || mensaje.includes('could not find')
}

export async function resolverUserIdPorDni(dni) {
  if (!dni) return null
  const { data } = await supabase.from('profiles').select('id').eq('dni', dni).maybeSingle()
  return data?.id ?? null
}

// ============================================================
// Tabla principal: avatar + nivel de TODOS los socios listados, en 2
// queries batch (no 1 por fila) -- clave para que la tabla siga andando
// bien con cientos de socios.
// ============================================================

export async function fetchAvataresYNiveles(dnis) {
  const dnisValidos = Array.from(new Set((dnis ?? []).filter(Boolean)))
  if (dnisValidos.length === 0) return new Map()

  const { data: perfiles, error: perfilesError } = await supabase
    .from('profiles')
    .select('id, dni, avatar_url')
    .in('dni', dnisValidos)
  if (perfilesError) {
    console.error('No se pudieron traer los perfiles PWA para la tabla de socios:', perfilesError.message)
    return new Map()
  }

  const userIds = (perfiles ?? []).map((p) => p.id)
  const xpPorUsuario = new Map()
  if (userIds.length > 0) {
    const { data: eventos, error: xpError } = await supabase.from('xp_events').select('user_id, xp_amount').in('user_id', userIds)
    if (xpError && !esErrorDeRelacionFaltante(xpError)) {
      // No es "tabla ausente" (esperable antes de la migración) -- puede ser
      // que la policy admin todavía no se haya actualizado. No rompe la
      // tabla, el badge de nivel simplemente no aparece.
      console.error('No se pudo traer XP para la tabla de socios:', xpError.message)
    } else {
      for (const evento of eventos ?? []) {
        xpPorUsuario.set(evento.user_id, (xpPorUsuario.get(evento.user_id) ?? 0) + (evento.xp_amount ?? 0))
      }
    }
  }

  const resultado = new Map()
  for (const perfil of perfiles ?? []) {
    const totalXp = xpPorUsuario.get(perfil.id) ?? 0
    resultado.set(perfil.dni, {
      userId: perfil.id,
      avatarUrl: perfil.avatar_url ?? null,
      nivel: calcularNivel(totalXp),
      totalXp,
    })
  }
  return resultado
}

// ============================================================
// Ficha 360° -- Historial único de Asistencias y Entrenamientos
// ============================================================

export async function fetchHistorialAsistencias(userId) {
  const [{ data: reservas, error: reservasError }, { data: checkins, error: checkinsError }] = await Promise.all([
    supabase
      .from('bookings')
      .select('id, booking_date, classes(title, instructor)')
      .eq('user_id', userId)
      .eq('attended', true)
      .order('booking_date', { ascending: false }),
    supabase
      .from('xp_events')
      .select('id, event_date')
      .eq('user_id', userId)
      .eq('event_type', 'asistencia')
      .is('reference_id', null) // sin reference_id = autoreportado ("¡Hoy entrené!"), no una clase reservada
      .order('event_date', { ascending: false }),
  ])
  if (reservasError && !esErrorDeRelacionFaltante(reservasError)) throw new Error(reservasError.message)
  if (checkinsError && !esErrorDeRelacionFaltante(checkinsError)) throw new Error(checkinsError.message)

  const itemsReservas = (reservas ?? []).map((booking) => {
    const clase = Array.isArray(booking.classes) ? booking.classes[0] : booking.classes
    return {
      id: `booking-${booking.id}`,
      fecha: booking.booking_date,
      tipo: `Clase: ${clase?.title ?? 'Sin nombre'}`,
      detalle: clase?.instructor ? `Prof. ${clase.instructor}` : '—',
      estado: 'Asistió',
    }
  })

  const itemsCheckins = (checkins ?? []).map((checkin) => ({
    id: `checkin-${checkin.id}`,
    fecha: checkin.event_date,
    tipo: 'Entrenamiento Libre: ¡Hoy entrené!',
    detalle: 'Autoreportado desde la app',
    estado: 'Registrado',
  }))

  return [...itemsReservas, ...itemsCheckins].sort((a, b) => (a.fecha < b.fecha ? 1 : -1))
}

// ============================================================
// Ficha 360° -- Rutinas y Disciplinas Asignadas
// ============================================================

export async function fetchHistorialRutinas(userId) {
  const { data, error } = await supabase
    .from('routines')
    .select('id, title, coach_name, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map((rutina) => ({
    id: rutina.id,
    titulo: rutina.title,
    coach: rutina.coach_name,
    creadaEl: rutina.created_at,
  }))
}

// ============================================================
// Ficha 360° -- Métricas Globales de Gamificación
// ============================================================

function formatFechaISO(date) {
  const anio = date.getFullYear()
  const mes = String(date.getMonth() + 1).padStart(2, '0')
  const dia = String(date.getDate()).padStart(2, '0')
  return `${anio}-${mes}-${dia}`
}

// Mismo criterio que calcularRachaDias de xpApi.ts en la PWA (días
// consecutivos contando hacia atrás desde hoy, se corta apenas hay un
// hueco) -- duplicado a propósito acá, son dos proyectos separados sin un
// paquete compartido entre PWA y panel admin.
export function calcularRacha(fechasAsistencia, hoy = new Date()) {
  const fechasSet = new Set(fechasAsistencia)
  const cursor = new Date(hoy)
  cursor.setHours(0, 0, 0, 0)
  if (!fechasSet.has(formatFechaISO(cursor))) cursor.setDate(cursor.getDate() - 1)
  let racha = 0
  while (fechasSet.has(formatFechaISO(cursor))) {
    racha += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return racha
}

export async function fetchMetricasGamificacion(userId) {
  const [{ data: eventos, error: eventosError }, { data: perfil, error: perfilError }] = await Promise.all([
    supabase.from('xp_events').select('event_type, event_date, xp_amount').eq('user_id', userId),
    supabase.from('profiles').select('created_at').eq('id', userId).maybeSingle(),
  ])
  if (eventosError && !esErrorDeRelacionFaltante(eventosError)) throw new Error(eventosError.message)
  if (perfilError) throw new Error(perfilError.message)

  const filas = eventos ?? []
  const totalXp = filas.reduce((acumulado, evento) => acumulado + (evento.xp_amount ?? 0), 0)
  const fechasAsistencia = Array.from(
    new Set(filas.filter((evento) => evento.event_type === 'asistencia').map((evento) => evento.event_date)),
  )

  return {
    nivel: calcularNivel(totalXp),
    totalXp,
    racha: calcularRacha(fechasAsistencia),
    totalAsistencias: fechasAsistencia.length,
    miembroDesde: perfil?.created_at ?? null,
  }
}

// ============================================================
// Ficha 360° -- Historial de Pagos y Suscripciones
// ============================================================

export async function fetchHistorialPagos(userId) {
  const { data, error } = await supabase.from('pagos_socio').select('*').eq('user_id', userId).order('fecha', { ascending: false })
  if (error) {
    if (esErrorDeRelacionFaltante(error)) return []
    throw new Error(error.message)
  }
  return (data ?? []).map((pago) => ({
    id: pago.id,
    fecha: pago.fecha,
    paquete: pago.paquete,
    monto: pago.monto,
    metodoPago: pago.metodo_pago,
    periodoDesde: pago.periodo_desde,
    periodoHasta: pago.periodo_hasta,
    estado: pago.estado,
    origen: pago.origen,
  }))
}

// Registra un cobro/renovación manual hecho por Seba desde "Registrar
// Pago". Silencioso si pagos_socio todavía no existe (migración sin
// correr) -- no debe cortar el resto del flujo de cobro (créditos/
// vencimiento en socios y en la PWA), que sigue funcionando igual que antes.
export async function registrarPago({ userId, paquete, monto, metodoPago, periodoDesde, periodoHasta, estado, creadoPor }) {
  const { error } = await supabase.from('pagos_socio').insert({
    user_id: userId,
    paquete,
    monto: monto || null,
    metodo_pago: metodoPago || null,
    periodo_desde: periodoDesde || null,
    periodo_hasta: periodoHasta || null,
    estado: estado ?? 'pagado',
    origen: 'manual',
    created_by: creadoPor || null,
  })
  if (error && !esErrorDeRelacionFaltante(error)) throw new Error(error.message)
}

// ============================================================
// Check-in Rápido de Musculación (botón "Check-in Rápido ⚡" del Navbar)
// ============================================================

export async function buscarSociosParaCheckin(query) {
  const termino = query.trim()
  if (!termino) return []
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, dni, avatar_url')
    .eq('role', 'socio')
    .or(`full_name.ilike.%${termino}%,dni.ilike.%${termino}%`)
    .limit(10)
  if (error) throw new Error(error.message)
  return (data ?? []).map((p) => ({ userId: p.id, nombre: p.full_name, dni: p.dni, avatarUrl: p.avatar_url ?? null }))
}

export const CHECKIN_OTORGADO = 'otorgado'
export const CHECKIN_YA_REGISTRADO = 'ya_registrado_hoy'

// +100 XP de entreno libre (Musculación/Aparatos), 1 vez por día por socio
// -- lo hace cumplir el índice único de xp_events del lado del servidor
// (idx_xp_events_asistencia_por_dia_disciplina): un segundo intento el
// mismo día tira 23505, que acá se trata como "ya registrado hoy", no
// como un error real.
export async function otorgarCheckinMusculacion(userId) {
  const { error } = await supabase.rpc('admin_otorgar_checkin_musculacion', { p_user_id: userId })
  if (error) {
    if (error.code === '23505') return CHECKIN_YA_REGISTRADO
    throw new Error(error.message)
  }
  return CHECKIN_OTORGADO
}

// Le resta `minutos` a una hora "HH:MM:SS" -- para la ventana de "clase por
// arrancar" de abajo. Si cruza medianoche hacia atrás, ajusta el día
// (wrap-around simple, alcanza para franjas de gimnasio normales).
function restarMinutos(horaStr, minutos) {
  const [h, m, s] = (horaStr ?? '00:00:00').split(':').map(Number)
  const totalMin = (((h * 60 + m - minutos) % 1440) + 1440) % 1440
  const hh = String(Math.floor(totalMin / 60)).padStart(2, '0')
  const mm = String(totalMin % 60).padStart(2, '0')
  return `${hh}:${mm}:${String(s ?? 0).padStart(2, '0')}`
}

// "Sugerencias inteligentes" del Check-in Rápido: sin escribir nada en el
// buscador, esto trae a quién ya hay que darle presente AHORA MISMO --
// inscriptos (bookings de hoy) de cualquier clase que esté en curso o
// arranque dentro de los próximos 30 minutos. Si hay 2 turnos superpuestos
// (ej. CrossFit y Boxeo a la misma hora), aparecen las dos, cada fila con
// su propia disciplina/turno.
const VENTANA_PREVIA_MIN = 30

export async function buscarSociosClaseActiva() {
  const ahora = new Date()
  const diaSemana = ahora.getDay()
  const horaActual = ahora.toTimeString().slice(0, 8)
  const hoyStr = ahora.toISOString().slice(0, 10)

  const { data: clases, error: clasesError } = await supabase
    .from('classes')
    .select('id, title, start_time, end_time, days_of_week, discipline:disciplines(name)')
  if (clasesError) {
    if (esErrorDeRelacionFaltante(clasesError)) return []
    throw new Error(clasesError.message)
  }

  const clasesActivas = (clases ?? []).filter((c) => {
    if (!(c.days_of_week ?? []).includes(diaSemana)) return false
    if (!c.start_time || !c.end_time) return false
    const inicioConVentana = restarMinutos(c.start_time, VENTANA_PREVIA_MIN)
    return horaActual >= inicioConVentana && horaActual <= c.end_time
  })
  if (clasesActivas.length === 0) return []

  const { data: inscriptos, error: bookingsError } = await supabase
    .from('bookings')
    .select('id, user_id, class_id, attended, profiles(full_name, dni)')
    .in(
      'class_id',
      clasesActivas.map((c) => c.id),
    )
    .eq('booking_date', hoyStr)
  if (bookingsError) throw new Error(bookingsError.message)

  const claseById = new Map(clasesActivas.map((c) => [c.id, c]))
  return (inscriptos ?? []).map((b) => {
    const clase = claseById.get(b.class_id)
    const disciplina = Array.isArray(clase?.discipline) ? clase.discipline[0] : clase?.discipline
    return {
      bookingId: b.id,
      userId: b.user_id,
      nombre: b.profiles?.full_name ?? '(sin nombre)',
      dni: b.profiles?.dni ?? null,
      turno: clase
        ? `${disciplina?.name ?? clase.title} · ${(clase.start_time ?? '').slice(0, 5)} a ${(clase.end_time ?? '').slice(0, 5)}`
        : '',
      yaRegistrado: !!b.attended,
    }
  })
}

// "Dar Presente" de un inscripto real (viene de buscarSociosClaseActiva) --
// marca su booking de HOY como asistido, lo mismo que ya hace la pantalla
// de Clases fila por fila. Dispara el trigger award_xp_asistencia() en
// Supabase, que acredita los +100 XP con el discipline_id correcto de esa
// clase (a diferencia del Check-in de Musculación, que siempre usa la
// disciplina de membresía).
export async function darPresenteClase(bookingId) {
  const { error } = await supabase.from('bookings').update({ attended: true }).eq('id', bookingId)
  if (error) throw new Error(error.message)
}

// ============================================================
// Actividad Reciente (Dashboard) -- unifica Reservas creadas, Check-ins de
// Musculación, Asistencias confirmadas a clases y sus Reversiones en un
// solo stream cronológico.
// ============================================================

export async function fetchActividadReciente(limite = 20) {
  const [{ data: bookings, error: bookingsError }, { data: eventos, error: eventosError }] = await Promise.all([
    supabase
      .from('bookings')
      .select('id, created_at, profiles(full_name), classes(title)')
      .order('created_at', { ascending: false })
      .limit(limite),
    supabase
      .from('xp_events')
      // `xp_events` tiene DOS foreign keys a `profiles` (user_id -- quién
      // recibió el XP -- y created_by -- quién lo otorgó, ej. el admin desde
      // Check-in Rápido), así que el embed implícito `profiles(...)` es
      // ambiguo para PostgREST ("Could not embed because more than one
      // relationship was found for 'xp_events' and 'profiles'"). Se fuerza
      // la FK exacta -- acá siempre queremos el nombre del SOCIO (user_id),
      // no de quién otorgó el evento.
      .select('id, event_type, xp_amount, reference_id, created_at, profiles!xp_events_user_id_fkey(full_name), disciplines(name)')
      .in('event_type', ['asistencia', 'reversion'])
      .order('created_at', { ascending: false })
      .limit(limite),
  ])
  if (bookingsError) throw new Error(bookingsError.message)
  if (eventosError && !esErrorDeRelacionFaltante(eventosError)) throw new Error(eventosError.message)

  const eventosFilas = eventos ?? []
  // Qué eventos de XP ya tienen una reversión registrada -- para no ofrecer
  // "Revertir" dos veces sobre el mismo (el RPC igual lo bloquea del lado
  // servidor, esto es solo para no mostrar un botón que va a fallar).
  const revertidos = new Set(
    eventosFilas.filter((e) => e.event_type === 'reversion' && e.reference_id).map((e) => e.reference_id),
  )

  const itemsReservas = (bookings ?? []).map((b) => {
    const clase = Array.isArray(b.classes) ? b.classes[0] : b.classes
    const perfil = Array.isArray(b.profiles) ? b.profiles[0] : b.profiles
    return {
      id: `reserva-${b.id}`,
      tipo: 'reserva',
      fecha: b.created_at,
      socioNombre: perfil?.full_name ?? 'Socio',
      detalle: `Reservó ${clase?.title ?? 'una clase'}`,
      xpEventId: null,
      xpAmount: null,
      revertido: false,
    }
  })

  const itemsXp = eventosFilas.map((e) => {
    const disciplina = Array.isArray(e.disciplines) ? e.disciplines[0] : e.disciplines
    const perfil = Array.isArray(e.profiles) ? e.profiles[0] : e.profiles
    const esReversion = e.event_type === 'reversion'
    const esClase = !esReversion && e.reference_id != null
    return {
      id: `xp-${e.id}`,
      tipo: esReversion ? 'reversion' : esClase ? 'asistencia_clase' : 'checkin_musculacion',
      fecha: e.created_at,
      socioNombre: perfil?.full_name ?? 'Socio',
      detalle: esReversion
        ? `Reversión de ${disciplina?.name ?? 'un evento'} (${e.xp_amount} XP)`
        : esClase
          ? `Asistencia confirmada: ${disciplina?.name ?? 'clase'}`
          : `Check-in de ${disciplina?.name ?? 'Musculación'}`,
      xpEventId: esReversion ? null : e.id,
      xpAmount: e.xp_amount,
      revertido: !esReversion && revertidos.has(e.id),
    }
  })

  return [...itemsReservas, ...itemsXp].sort((a, b) => new Date(b.fecha) - new Date(a.fecha)).slice(0, limite)
}

// Revierte un evento de XP (clase confirmada o check-in de Musculación) --
// inserta una fila de compensación NEGATIVA server-side (admin_revertir_xp_evento),
// nunca borra el evento original: la Actividad Reciente y el historial de
// la Ficha 360° siguen mostrando ambos movimientos.
export async function revertirXpEvento(xpEventId) {
  const { error } = await supabase.rpc('admin_revertir_xp_evento', { p_xp_event_id: xpEventId })
  if (error) throw new Error(error.message)
}
