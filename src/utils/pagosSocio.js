import { supabase } from '../lib/supabaseClient'

// Fase 3 -- los comprobantes de transferencia se acreditan AUTOMÁTICO al
// subirse desde la PWA (crear_pago_pendiente_transferencia -> acreditar_pack,
// ver supabase_migration_auto_acreditar_y_revertir_comprobante.sql). Ya no
// hay "pendiente" que aprobar/descartar -- esta pantalla es un HISTORIAL
// (pagado/anulado) con la posibilidad de revertir una acreditación ya hecha
// (admin_revertir_comprobante) si hace falta corregir algo.

export const BUCKET_COMPROBANTES = 'comprobantes-pago'

const SIGNED_URL_EXPIRES_SEGUNDOS = 600

// "8 créditos CrossFit + 8 créditos Boxeo" / "Aparatos + 12 créditos
// CrossFit" / "Aparatos Pase Libre" -- mismo criterio y misma salida que
// buildPackSubtitle() en PlanesPacksCard.jsx (Admin) y en
// greenfit-app/src/lib/creditsApi.ts (PWA).
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

// Igual que buildCreditosTexto, pero a partir de `detalle_acreditacion` (lo
// que de verdad se otorgó en su momento) en vez de `pack.creditos` (la
// definición ACTUAL del pack, que puede haber cambiado desde entonces) --
// esto es lo que hay que mostrarle a Seba en la confirmación de "Revertir":
// "esto es lo que le vas a quitar", no "esto es lo que el pack dice hoy".
export function buildDetalleRevertidoTexto(detalleAcreditacion, disciplinasPorId) {
  if (!detalleAcreditacion) return null
  const creditosRaw = Array.isArray(detalleAcreditacion.creditos) ? detalleAcreditacion.creditos : []
  const partes = creditosRaw
    .map((c) => {
      const disciplina = disciplinasPorId.get(c.discipline_id)
      return disciplina ? `${c.credits_otorgados} créditos ${disciplina.name}` : null
    })
    .filter(Boolean)
  if (detalleAcreditacion.aparatos) partes.unshift('la extensión de Aparatos')
  return partes.join(' + ') || null
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

// Badge del Sidebar -- se mantiene tal cual (sigue siendo una query válida)
// aunque en el flujo nuevo debería dar 0 casi siempre: solo puede quedar
// algo > 0 acá si sigue habiendo comprobantes 'pendiente' de ANTES del corte
// a este flujo (backlog viejo por drenar con admin_aprobar_comprobante,
// todavía disponible como red de seguridad transitoria -- ver el header de
// la migración de la Fase 3).
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

// Historial de comprobantes de transferencia (pagado/anulado), más
// recientes primero -- reemplaza a fetchComprobantesPendientes(). `limite`
// acotado por defecto (esto es un historial que crece para siempre, a
// diferencia de la bandeja de pendientes de antes, que se vaciaba sola).
export async function fetchHistorialComprobantes(limite = 50) {
  const [{ data: pagos, error: pagosError }, { data: disciplinas, error: discError }] = await Promise.all([
    supabase
      .from('pagos_socio')
      // Mismo hint de FK que ya usaba fetchComprobantesPendientes -- pagos_socio
      // tiene 3 columnas que referencian profiles (user_id, created_by,
      // reviewed_by), acá siempre queremos el socio DUEÑO del comprobante.
      .select(
        'id, user_id, paquete, monto, pack_id, comprobante_url, created_at, estado, reviewed_at, detalle_acreditacion, ' +
          'profiles!pagos_socio_user_id_fkey(full_name), packs(id, name, creditos, incluye_aparatos, dias_vigencia)',
      )
      .eq('origen', 'transferencia_comprobante')
      .in('estado', ['pagado', 'anulado'])
      .order('created_at', { ascending: false })
      .limit(limite),
    supabase.from('disciplines').select('id, name'),
  ])

  if (pagosError) {
    if (esErrorDeRelacionFaltante(pagosError)) return []
    throw new Error(pagosError.message)
  }
  if (discError) throw new Error(discError.message)

  const disciplinasPorId = new Map((disciplinas ?? []).map((d) => [d.id, d]))
  const filas = pagos ?? []

  // Signed URLs en un solo batch -- mismo criterio de siempre.
  const paths = filas.map((p) => p.comprobante_url).filter(Boolean)
  let signedUrlPorPath = new Map()
  if (paths.length > 0) {
    const { data: signedData, error: signedError } = await supabase.storage
      .from(BUCKET_COMPROBANTES)
      .createSignedUrls(paths, SIGNED_URL_EXPIRES_SEGUNDOS)
    if (signedError) {
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
      detalleRevertidoTexto: buildDetalleRevertidoTexto(p.detalle_acreditacion, disciplinasPorId),
      monto: p.monto,
      fecha: p.created_at,
      estado: p.estado,
      revertidoEl: p.reviewed_at,
      comprobanteUrl: p.comprobante_url ? (signedUrlPorPath.get(p.comprobante_url) ?? null) : null,
    }
  })
}

// admin_revertir_comprobante(): deshace una acreditación ya hecha (créditos
// y, si corresponde, la extensión de Aparatos) -- ver la RPC en
// supabase_migration_auto_acreditar_y_revertir_comprobante.sql. Devuelve
// `revertido=false` (sin tirar error) si la fila ya estaba anulada -- misma
// idempotencia que antes tenía aprobarComprobante() con reviewed_at.
// `aparatosAdvertencia` viene con texto SOLO si Aparatos no se pudo
// revertir automático (algo lo modificó después) -- la UI tiene que
// mostrarlo bien visible, no como un detalle chico.
export async function revertirComprobante(pagoId) {
  const { data, error } = await supabase.rpc('admin_revertir_comprobante', { p_pagos_socio_id: pagoId })
  if (error) throw new Error(error.message)
  const fila = Array.isArray(data) ? data[0] : data
  return {
    revertido: Boolean(fila?.reversion_ok),
    aparatosAdvertencia: fila?.aparatos_advertencia ?? null,
  }
}
