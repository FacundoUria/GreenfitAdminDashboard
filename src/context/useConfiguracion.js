import { useContext } from 'react'
import { ConfiguracionContext } from './configuracionContextBase'

export function useConfiguracion() {
  const context = useContext(ConfiguracionContext)
  if (!context) {
    throw new Error('useConfiguracion debe usarse dentro de <ConfiguracionProvider>')
  }
  return context
}
