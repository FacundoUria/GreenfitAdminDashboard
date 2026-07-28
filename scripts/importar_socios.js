import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from 'csv-parse/sync'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAIZ_PROYECTO = join(__dirname, '..')
const CSV_PATH = join(RAIZ_PROYECTO, 'usuariosgreenfit.csv')
const TAMANO_LOTE = 200

function leerEnvLocal() {
  const contenido = readFileSync(join(RAIZ_PROYECTO, '.env.local'), 'utf-8')
  const env = {}

  for (const linea of contenido.split('\n')) {
    const limpia = linea.trim()
    if (!limpia || limpia.startsWith('#')) continue

    const indice = limpia.indexOf('=')
    if (indice === -1) continue

    env[limpia.slice(0, indice).trim()] = limpia.slice(indice + 1).trim()
  }

  return env
}

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

function mapearFila(fila) {
  const nombre = limpiar(fila['Nombre'])
  const apellido = limpiar(fila['Apellido'])
  const dni = limpiar(fila['DNI o CI'])
  const email = limpiar(fila['Email'])?.toLowerCase() ?? null
  const telefono = limpiar(fila['Teléfono']) ?? limpiar(fila['Celular'])

  if (!nombre || (!dni && !email)) return null

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

// Postgres no permite que un mismo valor de conflicto aparezca dos veces en el
// mismo INSERT ... ON CONFLICT; nos quedamos con la última aparición de cada
// clave (asumimos que es la exportación más reciente de Crossfy para ese socio).
function dedupePorClave(filas, clave) {
  const mapa = new Map()
  for (const fila of filas) {
    mapa.set(fila[clave], fila)
  }
  return [...mapa.values()]
}

async function upsertPorLotes(supabase, filas, onConflict, etiqueta) {
  let importados = 0
  const errores = []

  for (let i = 0; i < filas.length; i += TAMANO_LOTE) {
    const lote = filas.slice(i, i + TAMANO_LOTE)
    const { data, error } = await supabase.from('socios').upsert(lote, { onConflict }).select('id')

    if (error) {
      errores.push(`Lote ${etiqueta} #${i / TAMANO_LOTE + 1}: ${error.message}`)
      continue
    }

    importados += data?.length ?? 0
    console.log(`  Lote ${etiqueta} #${i / TAMANO_LOTE + 1}: ${data?.length ?? 0} filas OK`)
  }

  return { importados, errores }
}

async function main() {
  const env = leerEnvLocal()
  const supabaseUrl = env.VITE_SUPABASE_URL
  const supabaseKey = env.VITE_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY en .env.local')
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  const contenidoCsv = readFileSync(CSV_PATH, 'latin1')
  const filasCrudas = parse(contenidoCsv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  })

  console.log(`Filas leídas del CSV: ${filasCrudas.length}`)

  const filasMapeadas = filasCrudas.map(mapearFila)
  const omitidas = filasMapeadas.filter((f) => f === null).length
  const validas = filasMapeadas.filter((f) => f !== null)

  const conDni = dedupePorClave(
    validas.filter((f) => f.dni),
    'dni',
  )
  const soloEmail = dedupePorClave(
    validas.filter((f) => !f.dni && f.email),
    'email',
  )

  const sinFechaAlta = validas.filter((f) => !f.created_at).length

  console.log(`Filas omitidas (sin nombre o sin DNI/email): ${omitidas}`)
  console.log(`A importar por DNI: ${conDni.length}`)
  console.log(`A importar por Email (sin DNI): ${soloEmail.length}`)
  console.log(`Sin fecha de alta histórica (usarán la fecha de hoy): ${sinFechaAlta}`)
  console.log('')

  const resultadoDni = await upsertPorLotes(supabase, conDni, 'dni', 'DNI')
  const resultadoEmail = await upsertPorLotes(supabase, soloEmail, 'email', 'Email')

  const totalImportados = resultadoDni.importados + resultadoEmail.importados
  const todosLosErrores = [...resultadoDni.errores, ...resultadoEmail.errores]

  console.log('\n=== Resumen de importación ===')
  console.log(`Total filas en el CSV:        ${filasCrudas.length}`)
  console.log(`Omitidas (datos insuficientes): ${omitidas}`)
  console.log(`Importados/actualizados por DNI:   ${resultadoDni.importados} / ${conDni.length}`)
  console.log(`Importados/actualizados por Email: ${resultadoEmail.importados} / ${soloEmail.length}`)
  console.log(`Total importado correctamente:  ${totalImportados}`)

  if (todosLosErrores.length > 0) {
    console.log(`\nErrores (${todosLosErrores.length}):`)
    todosLosErrores.forEach((e) => console.log(`  - ${e}`))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('Error fatal en la importación:', error)
  process.exitCode = 1
})
