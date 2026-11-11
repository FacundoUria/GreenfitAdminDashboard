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

// DNI-C -- mensaje EXACTO con el que validar_dni_socio() rechaza cambiarle el
// DNI a un socio que ya tiene cuenta en la app
// (supabase_migration_dni_bloquear_cambio_con_cuenta.sql). El Admin lo
// muestra tal cual; si se cambia acá, cambiarlo también en la base.
export const TEXTO_DNI_CON_CUENTA = 'Este socio ya tiene cuenta en la app. Para corregir el DNI avisale a Facundo.'

// La cuenta de la app la crea on_socio_dni_upsert de forma asíncrona (pg_net):
// tarda unos segundos desde que se guarda el DNI.
export const TEXTO_CREANDO_CUENTA = 'Creando la cuenta en la app…'
export const TEXTO_CUENTA_EN_CREACION =
  'La cuenta de la app de este socio se está creando (tarda unos segundos). Cuando esté lista vas a poder cargarle los créditos.'
export const TEXTO_CUENTA_NO_CREADA = 'No se pudo crear la cuenta de la app. Avisale a Facundo.'

// Cuánto se espera a que aparezca una cuenta recién pedida (~15 s en el modal,
// ~20 s en Créditos). Pasado eso se dice TEXTO_CUENTA_NO_CREADA.
export const ESPERA_CUENTA_MODAL = { intentos: 19, esperaMs: 800 }
export const ESPERA_CUENTA_CREDITOS = { intentos: 10, esperaMs: 2000 }

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
