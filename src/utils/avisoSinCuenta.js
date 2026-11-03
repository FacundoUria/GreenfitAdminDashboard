import { planesDeVencimiento } from './planes'
import { formatFecha } from './fecha'

// T5 -- aviso al cobrar (o dar de alta) a un socio que NO tiene cuenta en la app.
//
// Desde T5 el copiador de la app (sync_my_membership) ya no copia la ficha a
// user_credits cuando el socio entra por primera vez (regla E: créditos y
// fechas solo por un pago o por carga manual de Seba). Por eso, cuando Seba
// cobra a alguien sin cuenta, el pago queda SOLO en la ficha (socios) y Seba
// tiene que cargarle los créditos a mano cuando tenga cuenta. Este aviso se lo
// dice en vez del viejo "Pago registrado correctamente", y le deja anotado lo
// cobrado: la ficha guarda solo el TOTAL de créditos, no cuánto era de cada
// disciplina.

// Mismo criterio que NuevoSocioModal.jsx, handle_socio_dni_upsert y
// validar_dni_socio (6 a 10 dígitos): sin un DNI así, la cuenta de la app no
// se crea nunca.
const DNI_REGEX = /^\d{6,10}$/

export function tieneDniValido(dni) {
  return DNI_REGEX.test(String(dni ?? '').trim())
}

export const TEXTO_SIN_CUENTA =
  'Este socio no tiene cuenta en la app. Cuando se registre, cargale los créditos desde Editar Socio → Créditos.'

export const TEXTO_SIN_DNI =
  'Este socio no tiene DNI cargado, así que no puede tener cuenta en la app. Cargale el DNI en Editar Socio; cuando tenga cuenta, cargale los créditos desde Editar Socio → Créditos.'

// "CrossFit 8 créditos, Boxeo 8 créditos, Aparatos — vence el 02/12/2026".
// `creditosPorDisciplina`: [{ disciplina, cantidad }] (mismo formato que
// RegistrarPagoModal/NuevoSocioModal). `plan`: lista de planes del cobro (de
// ahí salen las actividades por vencimiento, ej. Aparatos/Pase Libre).
export function detalleDelCobro({ creditosPorDisciplina, plan, fechaVencimiento } = {}) {
  const partes = (creditosPorDisciplina ?? [])
    .filter((item) => Number(item?.cantidad) > 0)
    .map((item) => `${item.disciplina} ${Number(item.cantidad)} créditos`)
  partes.push(...planesDeVencimiento(plan))
  const texto = partes.join(', ')
  if (!fechaVencimiento) return texto
  const vence = `vence el ${formatFecha(fechaVencimiento)}`
  return texto ? `${texto} — ${vence}` : vence
}

// Arma el aviso completo { titulo, mensaje, detalle, extra }.
//   - errorVerificacion: no se pudo saber si tiene cuenta (error de red/RLS al
//     buscar en profiles). R5: no se confunde con "no tiene cuenta".
//   - extra: otro aviso del mismo cobro que no se tiene que perder (ej. la
//     fecha de inicio que no se guardó).
export function avisoSinCuenta({ dni, detalle, errorVerificacion, extra, titulo = 'Pago guardado en la ficha' } = {}) {
  let mensaje
  if (errorVerificacion) {
    mensaje =
      `No se pudo verificar si el socio tiene cuenta en la app (${errorVerificacion}), así que no se cargó nada en la app. ` +
      'Revisá Editar Socio → Créditos.'
  } else if (!tieneDniValido(dni)) {
    mensaje = TEXTO_SIN_DNI
  } else {
    mensaje = TEXTO_SIN_CUENTA
  }
  return {
    titulo,
    mensaje,
    detalle: detalle ? `Anotá lo cobrado: ${detalle}.` : null,
    extra: extra ?? null,
  }
}
