import { useState } from 'react'
import { AUTH_STORAGE_KEY, AuthContext, CREDENCIALES } from './authContextBase'

function leerSesionGuardada() {
  try {
    const guardado = localStorage.getItem(AUTH_STORAGE_KEY)
    return guardado ? JSON.parse(guardado) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }) {
  const [usuario, setUsuario] = useState(leerSesionGuardada)

  const login = (usuarioIngresado, claveIngresada) => {
    const coincide =
      usuarioIngresado.trim().toLowerCase() === CREDENCIALES.usuario &&
      claveIngresada === CREDENCIALES.clave

    if (!coincide) return false

    const sesion = { nombre: CREDENCIALES.nombre, rol: CREDENCIALES.rol }
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sesion))
    setUsuario(sesion)
    return true
  }

  const logout = () => {
    localStorage.removeItem(AUTH_STORAGE_KEY)
    setUsuario(null)
  }

  return <AuthContext.Provider value={{ usuario, login, logout }}>{children}</AuthContext.Provider>
}
