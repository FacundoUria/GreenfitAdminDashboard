import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

const valoresPorDefecto = ['tu_url_de_supabase', 'tu_anon_key_de_supabase', '']

const credencialesInvalidas =
  !supabaseUrl ||
  !supabaseAnonKey ||
  valoresPorDefecto.includes(supabaseUrl) ||
  valoresPorDefecto.includes(supabaseAnonKey)

if (credencialesInvalidas) {
  console.warn(
    '[Supabase] Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY o tienen valores por defecto. ' +
      'Configuralas en tu archivo .env.local antes de usar la app.',
  )
}

export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '')
