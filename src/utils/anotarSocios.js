import { supabase } from '../lib/supabaseClient'
import { fetchTodasLasFilas } from './fichaSocioPwa'

// Datos del buscador de "Ver inscriptos" -- se piden UNA vez al abrir el
// modal y se filtra en el navegador (ver buscarSocios.js). Ninguna de estas
// dos consultas escribe nada.

// Todos los socios con cuenta en la app (profiles role='socio') -- son los
// únicos a los que admin_book_class puede anotar (necesita un user_id real).
// Paginado con .range() (tope de ~1000 filas de PostgREST) y con un orden
// estable (nombre + id) para que las páginas no se pisen entre sí.
export async function fetchSociosParaAnotar() {
  const { data, error } = await fetchTodasLasFilas(() =>
    supabase
      .from('profiles')
      .select('id, full_name, dni')
      .eq('role', 'socio')
      .order('full_name', { ascending: true })
      .order('id', { ascending: true }),
  )
  if (error) throw new Error(error.message)
  return data ?? []
}

// Créditos VIGENTES de cada socio en la disciplina de ESTA clase: filas con
// saldo y fecha futura, sumadas por user_id (Map user_id -> cantidad). Mismo
// criterio de "vigente" que usa admin_book_class para descontar: la fecha de
// vencimiento tiene que ser futura y el saldo mayor a 0. Un socio sin ninguna
// fila así no aparece en el Map (= 0).
export async function fetchCreditosVigentesPorSocio(disciplinaId) {
  const ahora = new Date().toISOString()
  const { data, error } = await fetchTodasLasFilas(() =>
    supabase
      .from('user_credits')
      .select('user_id, remaining_credits')
      .eq('discipline_id', disciplinaId)
      .gte('remaining_credits', 1)
      .gte('expires_at', ahora)
      .order('id', { ascending: true }),
  )
  if (error) throw new Error(error.message)

  const porSocio = new Map()
  for (const fila of data ?? []) {
    porSocio.set(fila.user_id, (porSocio.get(fila.user_id) ?? 0) + (fila.remaining_credits ?? 0))
  }
  return porSocio
}
