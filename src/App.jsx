import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Reportes from './pages/Reportes'
import Socios from './pages/Socios'
import Configuracion from './pages/Configuracion'
import Clases from './pages/Clases'
import Home from './pages/Home'
import Notas from './pages/Notas'
import Login from './pages/Login'
import { AuthProvider } from './context/AuthContext'
import { useAuth } from './context/useAuth'

function RutaProtegida() {
  const { usuario } = useAuth()

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
              <Route path="clases" element={<Clases />} />
              <Route path="reportes" element={<Reportes />} />
              <Route path="notas" element={<Notas />} />
              <Route path="configuracion" element={<Configuracion />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
