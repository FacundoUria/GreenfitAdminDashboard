export const PLANTILLAS_WHATSAPP = {
  vencida:
    '¡Hola {nombre}! Te recordamos desde GreenFit que tu cuota ha vencido. Podés renovarla en recepción o por transferencia. ¡Te esperamos para seguir entrenando! 💪',
  reactivacion:
    '¡Hola {nombre}! Te extrañamos por GreenFit 💪 ¿Cómo estás? Queríamos saber si vas a volver a entrenar este mes. ¡Contanos y vemos cómo te ayudamos a retomar!',
}

export function reemplazarVariables(plantilla, socio) {
  return plantilla.replaceAll('{nombre}', socio.nombre ?? '')
}

// Normalización best-effort para Argentina: si ya viene con código de país (54)
// lo dejamos, si no se lo agregamos. No intentamos adivinar el "9" de celular
// ni sacar el "15" local porque no hay forma confiable de saberlo por número.
export function normalizarTelefono(telefono) {
  const soloDigitos = (telefono ?? '').replace(/\D/g, '')
  if (!soloDigitos) return null
  return soloDigitos.startsWith('54') ? soloDigitos : `54${soloDigitos}`
}

export function construirLinkWhatsapp(telefono, mensaje) {
  const numero = normalizarTelefono(telefono)
  if (!numero) return null
  return `https://api.whatsapp.com/send?phone=${numero}&text=${encodeURIComponent(mensaje)}`
}
