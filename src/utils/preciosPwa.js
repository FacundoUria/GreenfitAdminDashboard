import { supabase } from '../lib/supabaseClient'

// Los precios que edita Configuración (por disciplina) son la única fuente
// de verdad -- la PWA muestra y cobra el precio de `packs.price`, así que
// cada vez que se guarda acá hay que empujarlo también a los packs de esa
// disciplina. Sin esto, un pack queda con el precio de cuando se creó y se
// desincroniza en silencio del número que el admin ve en su propia pantalla.
const CAMPO_A_DISCIPLINA = [
  { campo: 'precio_crossfit', disciplina: 'CrossFit' },
  { campo: 'precio_boxeo', disciplina: 'Boxeo' },
  { campo: 'precio_kickstrike', disciplina: 'Kickstrike' },
  { campo: 'precio_aparatos', disciplina: 'Aparatos' },
]

export async function sincronizarPreciosPacks(precios) {
  const errores = []

  for (const { campo, disciplina } of CAMPO_A_DISCIPLINA) {
    const nuevoPrecio = precios[campo]
    if (nuevoPrecio == null) continue

    const { data: disciplinaRow } = await supabase
      .from('disciplines')
      .select('id')
      .ilike('name', disciplina)
      .maybeSingle()
    if (!disciplinaRow) continue

    const { error } = await supabase.from('packs').update({ price: nuevoPrecio }).eq('discipline_id', disciplinaRow.id)
    if (error) {
      console.error(`No se pudo sincronizar el precio de ${disciplina} con la PWA:`, error.message)
      errores.push(disciplina)
    }
  }

  return { synced: errores.length === 0, errores }
}
