import { supabase } from '../lib/supabaseClient'

// Log robusto para cualquier error de Supabase de este archivo -- antes cada
// función armaba a mano `{ message: error.message, details: error.details,
// ... }`, que revienta en un `TypeError` (o imprime valores vacíos sin
// avisar) si `error` llega null/undefined/con una forma rara, dejando en la
// consola justo el síntoma reportado ("Error updating user credits: null")
// en vez del detalle real que hacía falta para depurar. Acá se valida antes
// de desarmarlo Y se loguea el objeto crudo aparte (JSON.stringify, con
// Object.getOwnPropertyNames porque PostgrestError no siempre trae sus
// campos como enumerables propios de forma consistente entre versiones).
function logErrorSupabase(contexto, error) {
  if (!error) {
    console.error(`[creditosPwa] ${contexto}: la llamada falló pero Supabase no devolvió ningún objeto de error (revisá RLS -- una fila que no matchea ninguna policy puede volver "sin error" con 0 filas afectadas).`)
    return
  }
  console.error(`[creditosPwa] ${contexto}:`, {
    message: error.message ?? '(sin message)',
    details: error.details ?? '(sin details)',
    hint: error.hint ?? '(sin hint)',
    code: error.code ?? '(sin code)',
  })
  try {
    console.error(`[creditosPwa] ${contexto} (crudo):`, JSON.stringify(error, Object.getOwnPropertyNames(error)))
  } catch {
    // Si ni siquiera esto serializa, ya se logueó lo de arriba -- no hay más para hacer.
  }
}

// La cuenta de la app de socios se auto-provisiona por DNI (trigger
// on_socio_dni_upsert) -- ese es el puente de siempre. Pero el import
// masivo de Crossfy (scripts/importar_socios.js) trajo ~750 socios SIN DNI
// cargado (matcheados solo por email en ese script) -- para esos, buscar
// por DNI nunca va a encontrar nada, y antes de este cambio quedaban para
// siempre sin poder sincronizar créditos/vencimiento con la PWA (bug
// reportado: los botones de crédito no tenían ningún balance real sobre el
// que operar). Ahora, si no hay DNI (o no matchea), se intenta por EMAIL
// como respaldo -- mismo criterio que ya usa
// sincronizacion_crossfy_v2.sql para el mismo problema.
async function resolverUserId({ dni, email } = {}) {
  if (dni) {
    const { data, error } = await supabase.from('profiles').select('id').eq('dni', dni).maybeSingle()
    if (error) logErrorSupabase(`resolverUserId (por DNI ${dni})`, error)
    if (data?.id) return data.id
  }
  if (email) {
    const { data, error } = await supabase.from('profiles').select('id').ilike('email', email.trim()).maybeSingle()
    if (error) logErrorSupabase(`resolverUserId (por email ${email})`, error)
    if (data?.id) return data.id
  }
  // Ni el DNI ni el email matchean ninguna fila en `profiles` -- el socio
  // (ej. Aixa) todavía no tiene una cuenta creada en la app (no se registró
  // o el admin todavía no le generó el acceso). Esto NO es un error de
  // Supabase -- es un estado real y esperable, distinto de una falla
  // técnica, por eso el llamador lo trata con su propio mensaje ('Guardado
  // en el panel, pero el socio todavía no está registrado en la app') en
  // vez del genérico de "no se pudo sincronizar".
  return null
}

// ilike a propósito: `plan` es texto libre cargado por el staff y no
// siempre calza en mayúsculas/minúsculas con `disciplines.name`.
//
// Antes esto usaba .maybeSingle(), que ERRORA (silenciosamente -- el
// error nunca se chequeaba) si el ilike matchea MÁS de una fila. Como la
// unique constraint de disciplines.name es case-sensitive, dos filas que
// difieren solo en mayúsculas (ej. "Kickstrike" y "kickstrike", el mismo
// tipo de incongruencia de nomenclatura que motivó el rename Kickboxing ->
// Kickstrike) son perfectamente "únicas" para Postgres pero ambiguas para
// ilike -- .maybeSingle() nunca elegía ninguna, y sincronizarCreditosPwa
// terminaba devolviendo 'disciplina_no_encontrada' aunque la disciplina sí
// existiera. Ahora se trae TODO lo que matchea y se elige a mano: primero
// la que calza EXACTO (case-sensitive) contra el nombre que vino de
// socios.plan; si ninguna calza exacto, la más antigua (la fila "real",
// con historial real detrás, no un duplicado reciente por error de tipeo).
// Exportada (antes privada) -- CreditosEditablesSocio.jsx la necesita para
// resolver el discipline_id real de cada fila del socio antes de llamar a
// admin_fijar_creditos_disciplina()/admin_ajustar_credito_disciplina(),
// mismo criterio robusto de siempre (duplicados por mayúsculas, etc.).
export async function resolverDisciplinaId(nombrePlan) {
  if (!nombrePlan) return null
  const nombreTrim = nombrePlan.trim()
  const { data, error } = await supabase.from('disciplines').select('id, name, created_at').ilike('name', nombreTrim)
  if (error) {
    logErrorSupabase(`resolverDisciplinaId (nombre "${nombrePlan}")`, error)
    return null
  }
  if (!data || data.length === 0) return null
  if (data.length === 1) return data[0].id

  const exacta = data.find((d) => d.name === nombreTrim)
  const elegida = exacta ?? [...data].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]
  console.warn(
    `[creditosPwa] resolverDisciplinaId: "${nombrePlan}" matchea ${data.length} filas en disciplines (${data
      .map((d) => `"${d.name}" id=${d.id}`)
      .join(', ')}) -- usando ${exacta ? 'la que calza EXACTO' : 'la más antigua'} (id=${elegida.id}). Esto es un ` +
      'problema de datos (probablemente una fila duplicada por mayúsculas/minúsculas en el catálogo de Disciplinas) -- conviene consolidarlas.',
  )
  return elegida.id
}

// T5 -- acá vivían sincronizarCreditosPwa, sincronizarVencimientoPwa y
// sincronizarVencimientoCreditoPwa: escribían user_credits DIRECTO desde el
// navegador (INSERT/UPDATE sueltos, una segunda fecha por disciplina). Nadie
// las llamaba desde la Fase 2 (cobro y alta usan admin_acreditar_creditos_manual,
// el editor usa admin_fijar/ajustar_credito_disciplina) y se borraron: el
// Admin ya no escribe user_credits por fuera de un RPC.

// Baja lógica: `profiles.active` es lo que de verdad bloquea el login y las
// reservas (AuthContext y el RPC book_class lo chequean del lado servidor);
// `socios.activo` es solo el reflejo de esto en el panel admin. Sin este
// puente, dar de baja a alguien acá no le impediría seguir usando la PWA.
export async function sincronizarEstadoCuentaPwa({ dni, email, activo }) {
  try {
    const userId = await resolverUserId({ dni, email })
    if (!userId) return { synced: false, reason: 'sin_cuenta_pwa' }

    const { error } = await supabase.from('profiles').update({ active: activo }).eq('id', userId)
    if (error) {
      logErrorSupabase(`sincronizarEstadoCuentaPwa: UPDATE de profiles (userId=${userId})`, error)
      return { synced: false, reason: 'error_supabase' }
    }
    return { synced: true }
  } catch (err) {
    console.error('[creditosPwa] ERROR inesperado sincronizando estado de cuenta con la PWA:', err)
    return { synced: false, reason: 'error_supabase' }
  }
}

// ============================================================
// Edición directa de créditos por disciplina (CreditosEditablesSocio.jsx,
// dentro de "Editar Socio") -- reemplaza a los steppers -/+1/+4/+8/+12 que
// vivían sueltos en SociosTabla.jsx. A diferencia del resto de este
// archivo, acá NO se resuelve nada del lado del cliente (ni userId por
// DNI/email, ni disciplineId por nombre con fallback de duplicados) -- el
// caller (CreditosEditablesSocio.jsx) ya los tiene resueltos de antes, y
// TODO el trabajo real (consolidar lotes, fusión por día Argentina, FIFO)
// lo hace el RPC server-side -- ver supabase_migration_editar_creditos_
// disciplina.sql. Se relanza el error tal cual en vez de devolver un
// `{synced, reason}` como el resto del archivo: acá el llamador SÍ tiene
// sentido que trate el fallo como una excepción real (viene de un click
// puntual con su propio try/catch en la UI, no de un flujo batch).
export async function fijarCreditosDisciplina(userId, disciplineId, creditos) {
  const { error } = await supabase.rpc('admin_fijar_creditos_disciplina', {
    p_user_id: userId,
    p_discipline_id: disciplineId,
    p_creditos: creditos,
  })
  if (error) {
    logErrorSupabase(`fijarCreditosDisciplina (userId=${userId}, disciplineId=${disciplineId}, creditos=${creditos})`, error)
    throw error
  }
}

export async function ajustarCreditoDisciplina(userId, disciplineId, delta) {
  const { error } = await supabase.rpc('admin_ajustar_credito_disciplina', {
    p_user_id: userId,
    p_discipline_id: disciplineId,
    p_delta: delta,
  })
  if (error) {
    logErrorSupabase(`ajustarCreditoDisciplina (userId=${userId}, disciplineId=${disciplineId}, delta=${delta})`, error)
    throw error
  }
}

// CAMBIO 5 (re-agregar Aparatos) -- "+ Agregar Aparatos" en
// CreditosEditablesSocio.jsx. A diferencia de fijarCreditosDisciplina() (que
// rechaza kind='membership'), esto llama a un RPC chico y separado
// (admin_agregar_aparatos_socio, ver supabase_migration_admin_agregar_
// aparatos_socio.sql -- SIN CORRER TODAVÍA) que resuelve sola la fecha del
// plan vigente del socio (o now()+30 días si no tiene nada), igual que
// fijarCreditosDisciplina. No recibe discipline_id ni cantidad -- Aparatos
// no tiene créditos que contar, y el RPC ya sabe cuál es la única
// disciplina kind='membership' del catálogo.
export async function agregarAparatosSocio(userId) {
  const { error } = await supabase.rpc('admin_agregar_aparatos_socio', {
    p_user_id: userId,
  })
  if (error) {
    logErrorSupabase(`agregarAparatosSocio (userId=${userId})`, error)
    throw error
  }
}

// CAMBIO 3 ("editar la fecha del plan") -- "Vencimiento del plan" en
// CreditosEditablesSocio.jsx. RPC chico y separado (admin_editar_fecha_
// vencimiento_socio, ver supabase_migration_admin_editar_fecha_vencimiento_
// socio.sql -- SIN CORRER TODAVÍA), ADITIVO: no toca acreditar_pack,
// admin_acreditar_creditos_manual ni ningún camino de Cobrar/comprobantes.
// Solo mueve expires_at de las filas YA activas (créditos con saldo +
// Aparatos vigente) a la fecha elegida -- nunca cantidades. `p_nuevaFecha`
// es un string "YYYY-MM-DD" (el value crudo de un <input type="date">).
export async function editarFechaVencimientoSocio(userId, nuevaFechaISO) {
  const { data, error } = await supabase.rpc('admin_editar_fecha_vencimiento_socio', {
    p_user_id: userId,
    p_nueva_fecha: nuevaFechaISO,
  })
  if (error) {
    logErrorSupabase(`editarFechaVencimientoSocio (userId=${userId}, nuevaFecha=${nuevaFechaISO})`, error)
    throw error
  }
  return data // cantidad de filas actualizadas
}
