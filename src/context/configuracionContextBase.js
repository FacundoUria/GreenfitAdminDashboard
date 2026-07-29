import { createContext } from 'react'

export const ConfiguracionContext = createContext(null)

export const configuracionPorDefecto = {
  precio_crossfit: 0,
  precio_boxeo: 0,
  precio_kickboxing: 0,
  precio_aparatos: 0,
  dias_tolerancia: 5,
  limite_cancelacion_hs: 2,
  alias_cvu: '',
  titular_cuenta: '',
  notif_vencimiento_activo: true,
  notif_vencimiento_dias_antes: 3,
  notif_clase_activo: true,
  notif_clase_horas_antes: 2,
}
