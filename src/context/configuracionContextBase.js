import { createContext } from 'react'

export const ConfiguracionContext = createContext(null)

export const configuracionPorDefecto = {
  precio_crossfit: 0,
  precio_boxeo: 0,
  precio_kickstrike: 0,
  precio_aparatos: 0,
  dias_tolerancia: 5,
  limite_cancelacion_hs: 2,
  banner_activo: false,
  banner_mensaje: '',
  alias_cvu: '',
  titular_cuenta: '',
}
