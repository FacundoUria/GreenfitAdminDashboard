import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Reportes from './pages/Reportes'
import Socios from './pages/Socios'
import Pagos from './pages/Pagos'
import Configuracion from './pages/Configuracion'
import Clases from './pages/Clases'
import Disciplinas from './pages/Disciplinas'
import Rutinas from './pages/Rutinas'
import Home from './pages/Home'
import Notas from './pages/Notas'
import Anunciar from './pages/Anunciar'
import Comunidad from './pages/Comunidad'
import Login from './pages/Login'
import { AuthProvider } from './context/AuthContext'
import { useAuth } from './context/useAuth'

function RutaProtegida() {
  const { usuario, cargando } = useAuth()

  // Mientras se restaura (o no) la sesión guardada de Supabase, no
  // redirigir todavía a /login -- si no, un refresh de página con sesión
  // válida te tira afuera un instante antes de volver a entrar.
  if (cargando) {
    return null
  }

  if (!usuario) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RutaProtegida />}>
            <Route element={<Layout />}>
              <Route index element={<Home />} />
              <Route path="socios" element={<Socios />} />
              <Route path="pagos" element={<Pagos />} />
              <Route path="clases" element={<Clases />} />
              <Route path="disciplinas" element={<Disciplinas />} />
              <Route path="rutinas" element={<Rutinas />} />
              <Route path="reportes" element={<Reportes />} />
              <Route path="notas" element={<Notas />} />
              <Route path="anunciar" element={<Anunciar />} />
              <Route path="configuracion" element={<Configuracion />} />
              <Route path="comunidad" element={<Comunidad />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
