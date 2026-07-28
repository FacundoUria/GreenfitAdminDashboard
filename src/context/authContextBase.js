import { createContext } from 'react'

export const AuthContext = createContext(null)

// Credenciales simples para proteger el dashboard en Netlify. No es un
// sistema de auth real (no hay backend de usuarios) — alcanza para que la
// app no quede abierta a cualquiera que tenga la URL.
export const CREDENCIALES = {
  usuario: 'seba',
  clave: 'greenfit2026',
  nombre: 'Sebastián',
  rol: 'Administrador',
}

export const AUTH_STORAGE_KEY = 'greenfit_auth'
