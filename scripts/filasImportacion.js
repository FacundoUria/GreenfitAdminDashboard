// Lógica pura de scripts/importar_socios.js (sin red ni archivos), separada
// para poder testearla.

// Mismo criterio que NuevoSocioModal.jsx, handle_socio_dni_upsert() y el
// trigger socios_validar_dni (supabase_migration_socios_dni_obligatorio.sql):
// la base rechaza cualquier alta con un DNI que no cumpla esto.
export const DNI_REGEX = /^\d{6,10}$/

function convertirFecha(valor) {
  const limpio = (valor ?? '').trim()
  if (!limpio) return null

  const match = limpio.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!match) return null

  const [, dia, mes, anio] = match
  return `${anio}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`
}

function mapearEstado(valor) {
  const limpio = (valor ?? '').trim().toLowerCase()
  return limpio === 'activo' ? 'Activo' : 'Vencido'
}

function parsearCreditos(valor) {
  const numero = Number.parseInt(valor, 10)
  return Number.isNaN(numero) ? 0 : numero
}

function limpiar(valor) {
  const limpio = (valor ?? '').trim()
  return limpio || null
}

// "30.111.222" o "30 111 222" son el mismo DNI que "30111222": se le sacan
// los puntos y espacios de formato. Cualquier otra cosa (letras, guiones) NO
// se adivina -- queda como vino y la fila se descarta por DNI inválido.
export function normalizarDni(valor) {
  const limpio = limpiar(valor)
  return limpio ? limpio.replace(/[.\s]/g, '') || null : null
}

export function mapearFila(fila) {
  const nombre = limpiar(fila['Nombre'])
  const apellido = limpiar(fila['Apellido'])
  const dni = normalizarDni(fila['DNI o CI'])
  const email = limpiar(fila['Email'])?.toLowerCase() ?? null
  const telefono = limpiar(fila['Teléfono']) ?? limpiar(fila['Celular'])

  // 'Fecha Ingreso' está vacía en el 88% de las filas; 'Fecha de registro' está
  // completa en el 100%. Usamos Ingreso cuando existe (fecha real de alta al
  // gimnasio) y si no, Registro (fecha de carga en Crossfy) como mejor proxy.
  // Sin esto, created_at quedaba en la fecha de ESTA importación para las
  // 968 filas, disparando falsos "Nuevos del Mes" en el dashboard.
  const fechaAlta = convertirFecha(fila['Fecha Ingreso']) ?? convertirFecha(fila['Fecha de registro'])

  return {
    nombre,
    apellido: apellido ?? '',
    dni,
    email,
    telefono,
    fecha_vencimiento: convertirFecha(fila['Fecha vencimiento paquete']),
    creditos: parsearCreditos(fila['Clases disponibles']),
    estado: mapearEstado(fila['Estado']),
    ...(fechaAlta ? { created_at: fechaAlta } : {}),
  }
}

// Separa las filas del CSV en las que se pueden importar y las que NO, con el
// motivo de cada descarte -- para que una fila con el DNI mal no haga fallar
// el lote entero (y se pierdan los socios buenos que venían con ella), y para
// que quede la lista de a quién hay que corregir en el CSV.
//
// Sin DNI válido la fila se descarta SIEMPRE: la base ya no acepta socios sin
// DNI (antes los sin DNI se importaban por email y quedaban sin cuenta en la
// app ni cruce posible con sus créditos).
//
// Devuelve { aImportar, descartadas }:
//   aImportar: filas listas para el upsert por DNI. Si un DNI se repite, queda
//     la ÚLTIMA aparición (Postgres no permite el mismo valor de conflicto dos
//     veces en un INSERT ... ON CONFLICT; asumimos que es la exportación más
//     reciente de Crossfy para ese socio).
//   descartadas: [{ linea, nombre, dni, email, motivo }] -- `linea` es el
//     número de línea en el CSV (la 1 es el encabezado) y `dni` es el valor
//     tal cual vino.
export function clasificarFilas(filasCrudas) {
  const porDni = new Map()
  const descartadas = []

  ;(filasCrudas ?? []).forEach((filaCruda, indice) => {
    const fila = mapearFila(filaCruda)
    const descartar = (motivo) =>
      descartadas.push({
        linea: indice + 2,
        nombre: [fila.nombre, fila.apellido].filter(Boolean).join(' ') || '(sin nombre)',
        dni: limpiar(filaCruda['DNI o CI']),
        email: fila.email,
        motivo,
      })

    if (!fila.nombre) return descartar('sin nombre')
    if (!fila.dni) return descartar('sin DNI')
    if (!DNI_REGEX.test(fila.dni)) return descartar('DNI inválido (tiene que tener entre 6 y 10 dígitos)')

    porDni.set(fila.dni, fila)
  })

  return { aImportar: [...porDni.values()], descartadas }
}

// Sube `filas` de a lotes. Si un lote falla (una sola fila rechazada por la
// base hace fallar el lote ENTERO), se reintenta fila por fila: se importan
// las buenas y solo las que realmente fallan quedan en `rechazadas`, cada una
// con su error.
//   upsertLote(filas) -> Promise<{ cantidad, error }> (error = mensaje o null)
export async function upsertPorLotes(filas, upsertLote, tamanoLote) {
  let importados = 0
  const rechazadas = []

  for (let i = 0; i < filas.length; i += tamanoLote) {
    const lote = filas.slice(i, i + tamanoLote)
    const resultado = await upsertLote(lote)

    if (!resultado.error) {
      importados += resultado.cantidad
      continue
    }

    for (const fila of lote) {
      const individual = await upsertLote([fila])
      if (individual.error) rechazadas.push({ fila, error: individual.error })
      else importados += individual.cantidad
    }
  }

  return { importados, rechazadas }
}
