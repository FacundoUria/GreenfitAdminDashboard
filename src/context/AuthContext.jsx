import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { AuthContext } from './authContextBase'

// Trae el profile solo si es admin — un socio que por error intentara
// loguearse acá (o cuya cuenta perdió el rol) no debe poder entrar al panel.
// `id` se expone además de nombre/rol para poder atribuir quién registró
// una acción (ej: created_by en pagos_socio -- Ficha 360°).
async function fetchAdminProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('id, full_name, role').eq('id', userId).single()
  if (error || !data || data.role !== 'admin') return null
  return { id: data.id, nombre: data.full_name, rol: 'Administrador' }
}

export function AuthProvider({ children }) {
  const [usuario, setUsuario] = useState(null)
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    async function bootstrap() {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (session?.user) {
        const perfil = await fetchAdminProfile(session.user.id)
        if (perfil) {
          setUsuario(perfil)
        } else {
          await supabase.auth.signOut()
        }
      }
      setCargando(false)
    }
    bootstrap()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session?.user) setUsuario(null)
    })

    return () => subscription.unsubscribe()
  }, [])

  // Devuelve true/false en vez de tirar excepción: Login.jsx solo necesita
  // saber si mostrar el error, no distinguir credenciales inválidas de "no
  // es admin" — misma UX que tenía el login hardcodeado anterior.
  const login = async (email, clave) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: clave })
    if (error || !data.user) return false

    const perfil = await fetchAdminProfile(data.user.id)
    if (!perfil) {
      await supabase.auth.signOut()
      return false
    }

    setUsuario(perfil)
    return true
  }

  const logout = async () => {
    await supabase.auth.signOut()
    setUsuario(null)
  }

  return <AuthContext.Provider value={{ usuario, cargando, login, logout }}>{children}</AuthContext.Provider>
}
