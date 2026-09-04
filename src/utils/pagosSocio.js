import { supabase } from '../lib/supabaseClient'

// Fase 3 -- revisión manual de comprobantes de transferencia (ver
// backend/../supabase_migration_transferencia_comprobante_fase1.sql y
// _insert_socio.sql, en el repo PAGINA SUPABASE). El socio sube el
// comprobante desde la PWA (queda 'pendiente' en pagos_socio, bucket
// privado 'comprobantes-pago'); acá Seba lo aprueba o lo descarta.

export const BUCKET_COMPROBANTES = 'comprobantes-pago'

// 10 minutos -- alcanza de sobra para que Seba mire la imagen ampliada
// mientras revisa un comprobante puntual; se vuelve a pedir cada vez que
// fetchComprobantesPendientes() corre de nuevo (carga inicial, refresco
// manual, o el disparador de Realtime), así que no hace falta que dure más.
const SIGNED_URL_EXPIRES_SEGUNDOS = 600

// "8 créditos CrossFit + 8 créditos Boxeo" / "Aparatos + 12 créditos
// CrossFit" / "Aparatos Pase Libre" -- mismo criterio y misma salida que
// buildPackSubtitle() en PlanesPacksCard.jsx (Admin) y en
// greenfit-app/src/lib/creditsApi.ts (PWA), para que el texto que ve Seba
// en el modal de confirmación describa EXACTAMENTE lo que
// admin_aprobar_comprobante() va a acreditar del lado servidor.
export function buildCreditosTexto(pack, disciplinasPorId) {
  if (!pack) return null
  const creditosRaw = Array.isArray(pack.creditos) ? pack.creditos : []
  const partes = creditosRaw
    .map((c) => {
      const disciplina = disciplinasPorId.get(c.discipline_id)
      return disciplina ? `${c.credits} créditos ${disciplina.name}` : null
    })
    .filter(Boolean)
  if (pack.incluye_aparatos && partes.length === 0) return 'Aparatos Pase Libre'
  if (pack.incluye_aparatos) return ['Aparatos', ...partes].join(' + ')
  return partes.join(' + ')
}

// 42P01 = undefined_table / PGRST205 = PostgREST no encuentra la relación
// (schema cache) -- mismo criterio de "todavía no corrió la migración" que
// ya usa fichaSocioPwa.js.
function esErrorDeRelacionFaltante(error) {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST202') return true
  const mensaje = (error.message ?? '').toLowerCase()
  return mensaje.includes('does not exist') || mensaje.includes('schema cache') || mensaje.includes('could not find')
}

// Solo el conteo -- para el badge del Sidebar, sin traer filas completas ni
// resolver URLs firmadas (eso es carga de más para algo que solo necesita
// un número).
export async function fetchCountComprobantesPendientes() {
  const { count, error } = await supabase
    .from('pagos_socio')
    .select('id', { count: 'exact', head: true })
    .eq('estado', 'pendiente')
    .eq('origen', 'transferencia_comprobante')

  if (error) {
    if (esErrorDeRelacionFaltante(error)) return 0
    throw new Error(error.message)
  }
  return count ?? 0
}

// Listado completo para la pantalla "Pagos": comprobantes pendientes, más
// recientes primero, con el nombre del socio, el pack real (para poder
// mostrar qué créditos se van a otorgar) y una URL firmada temporal de la
// imagen (el bucket es privado -- getPublicUrl() no sirve acá).
export async function fetchComprobantesPendientes() {
  const [{ data: pagos, error: pagosError }, { data: disciplinas, error: discError }] = await Promise.all([
    supabase
      .from('pagos_socio')
      // FK explícita: pagos_socio tiene TRES columnas que referencian
      // profiles (user_id, created_by, reviewed_by -- ver
      // supabase_migration_ficha360.sql y _fase1.sql) -- sin el hint,
      // PostgREST no puede elegir cuál usar (mismo motivo documentado en
      // fetchActividadReciente, fichaSocioPwa.js). Acá siempre queremos el
      // nombre del SOCIO que subió el comprobante (user_id).
      .select(
        'id, user_id, paquete, monto, pack_id, comprobante_url, created_at, profiles!pagos_socio_user_id_fkey(full_name), packs(id, name, creditos, incluye_aparatos, dias_vigencia)',
      )
      .eq('estado', 'pendiente')
      .eq('origen', 'transferencia_comprobante')
      .order('created_at', { ascending: false }),
    supabase.from('disciplines').select('id, name'),
  ])

  if (pagosError) {
    if (esErrorDeRelacionFaltante(pagosError)) return []
    throw new Error(pagosError.message)
  }
  if (discError) throw new Error(discError.message)

  const disciplinasPorId = new Map((disciplinas ?? []).map((d) => [d.id, d]))
  const filas = pagos ?? []

  // Signed URLs en un solo batch (no 1 request por fila) -- createSignedUrls
  // preserva el orden del array de paths que se le manda, así que se puede
  // mapear 1:1 por índice sin depender de que cada resultado eco su `path`.
  const paths = filas.map((p) => p.comprobante_url).filter(Boolean)
  let signedUrlPorPath = new Map()
  if (paths.length > 0) {
    const { data: signedData, error: signedError } = await supabase.storage
      .from(BUCKET_COMPROBANTES)
      .createSignedUrls(paths, SIGNED_URL_EXPIRES_SEGUNDOS)
    if (signedError) {
      // No crítico -- la fila sigue siendo revisable (nombre/pack/monto),
      // solo no se puede mostrar la imagen. No bloquea el resto del listado.
      console.error('No se pudieron generar las URLs firmadas de los comprobantes:', signedError.message)
    } else {
      signedUrlPorPath = new Map(
        paths.map((path, i) => [path, signedData?.[i]?.signedUrl ?? null]).filter(([, url]) => url),
      )
    }
  }

  return filas.map((p) => {
    const perfil = Array.isArray(p.profiles) ? p.profiles[0] : p.profiles
    const pack = Array.isArray(p.packs) ? p.packs[0] : p.packs
    return {
      id: p.id,
      userId: p.user_id,
      socioNombre: perfil?.full_name ?? 'Socio',
      paquete: p.paquete,
      pack,
      creditosTexto: buildCreditosTexto(pack, disciplinasPorId),
      monto: p.monto,
      fecha: p.created_at,
      comprobanteUrl: p.comprobante_url ? (signedUrlPorPath.get(p.comprobante_url) ?? null) : null,
    }
  })
}

// admin_aprobar_comprobante(): acredita los créditos reales (ver la RPC en
// supabase_migration_transferencia_comprobante_fase1.sql) y notifica al
// socio. Devuelve `creditoOtorgado=false` (sin tirar error) si la fila ya
// había sido revisada antes -- ej. otra pestaña de Seba ya la aprobó/
// rechazó -- para que la UI pueda avisar "ya fue revisado" en vez de
// festejar una acreditación que no ocurrió.
export async function aprobarComprobante(pagoId) {
  const { data, error } = await supabase.rpc('admin_aprobar_comprobante', { p_pagos_socio_id: pagoId })
  if (error) throw new Error(error.message)
  const fila = Array.isArray(data) ? data[0] : data
  return { creditoOtorgado: Boolean(fila?.credito_otorgado) }
}

// admin_rechazar_comprobante(): NO acredita nada y NO notifica al socio
// (mismo criterio que la función real -- ver el comentario en la Fase 1).
export async function rechazarComprobante(pagoId) {
  const { error } = await supabase.rpc('admin_rechazar_comprobante', { p_pagos_socio_id: pagoId })
  if (error) throw new Error(error.message)
}
