import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Reportes from './pages/Reportes'
import Socios from './pages/Socios'
import Configuracion from './pages/Configuracion'
import Clases from './pages/Clases'
import Home from './pages/Home'

function Placeholder({ title }) {
  return (
    <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-2 text-center">
      <h2 className="text-xl font-semibold text-white">{title}</h2>
      <p className="text-sm text-gray-400">Esta sección está en construcción.</p>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="socios" element={<Socios />} />
          <Route path="clases" element={<Clases />} />
          <Route path="cajas" element={<Placeholder title="Cajas / Pagos" />} />
          <Route path="reportes" element={<Reportes />} />
          <Route path="configuracion" element={<Configuracion />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
