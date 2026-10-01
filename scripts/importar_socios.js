import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from 'csv-parse/sync'
import { createClient } from '@supabase/supabase-js'
import { clasificarFilas, upsertPorLotes } from './filasImportacion.js'

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

  const { aImportar, descartadas } = clasificarFilas(filasCrudas)
  const sinFechaAlta = aImportar.filter((f) => !f.created_at).length

  console.log(`A importar (por DNI): ${aImportar.length}`)
  console.log(`Descartadas antes de importar: ${descartadas.length}`)
  console.log(`Sin fecha de alta histórica (usarán la fecha de hoy): ${sinFechaAlta}`)
  console.log('')

  const { importados, rechazadas } = await upsertPorLotes(
    aImportar,
    async (lote) => {
      const { data, error } = await supabase.from('socios').upsert(lote, { onConflict: 'dni' }).select('id')
      return { cantidad: data?.length ?? 0, error: error?.message ?? null }
    },
    TAMANO_LOTE,
  )

  console.log('\n=== Resumen de importación ===')
  console.log(`Total filas en el CSV:          ${filasCrudas.length}`)
  console.log(`Importados/actualizados:        ${importados} / ${aImportar.length}`)
  console.log(`Descartadas antes de importar:  ${descartadas.length}`)
  console.log(`Rechazadas por la base:         ${rechazadas.length}`)

  // La base no acepta socios sin DNI válido (trigger socios_validar_dni):
  // estas filas NO se importaron. Corregirlas en el CSV y volver a correr.
  if (descartadas.length > 0) {
    console.log(`\nFilas descartadas (${descartadas.length}) -- NO se importaron:`)
    descartadas.forEach((d) =>
      console.log(`  - línea ${d.linea}: ${d.nombre} | DNI: ${d.dni ?? '(vacío)'} | email: ${d.email ?? '(sin email)'} -> ${d.motivo}`),
    )
  }

  if (rechazadas.length > 0) {
    console.log(`\nFilas rechazadas por la base (${rechazadas.length}) -- NO se importaron:`)
    rechazadas.forEach((r) => console.log(`  - ${r.fila.nombre} ${r.fila.apellido} | DNI: ${r.fila.dni} -> ${r.error}`))
  }

  if (descartadas.length > 0 || rechazadas.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('Error fatal en la importación:', error)
  process.exitCode = 1
})
