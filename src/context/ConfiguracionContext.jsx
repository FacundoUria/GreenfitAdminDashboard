import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { ConfiguracionContext, configuracionPorDefecto } from './configuracionContextBase'

export function ConfiguracionProvider({ children }) {
  const [configuracion, setConfiguracion] = useState(configuracionPorDefecto)
  const [loading, setLoading] = useState(true)

  // Ojo: no hacemos setLoading(true) acá. `refetch` reusa esta misma función
  // después de guardar cambios; si volviera a poner loading en true,
  // desmontaría momentáneamente a los consumidores (ej. ConfiguracionForm)
  // mientras esa refetch está en curso, perdiendo el estado local del toast
  // que se setea justo después de llamar a onGuardado().
  const fetchConfiguracion = async () => {
    const { data, error } = await supabase.from('configuracion').select('*').eq('id', 1).maybeSingle()

    if (error) {
      console.error('Error al cargar la configuración desde Supabase:', error.message)
    } else if (data) {
      setConfiguracion(data)
    }

    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchConfiguracion()
  }, [])

  return (
    <ConfiguracionContext.Provider value={{ configuracion, loading, refetch: fetchConfiguracion }}>
      {children}
    </ConfiguracionContext.Provider>
  )
}
