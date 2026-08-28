import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Header from './Header'
import RecordatorioToast from './RecordatorioToast'
import { ConfiguracionProvider } from '../context/ConfiguracionContext'
import { NotasProvider } from '../context/NotasContext'

function Layout() {
  const [sidebarAbierto, setSidebarAbierto] = useState(false)

  return (
    <ConfiguracionProvider>
      <NotasProvider>
        {/* min-h-dvh (no min-h-screen/100vh) -- en tablet, al abrir el
            teclado virtual, 100vh sigue midiendo el viewport COMPLETO (sin
            descontar el teclado), así que este contenedor no se achica y el
            <main> de abajo termina con una porción tapada por el teclado en
            vez de scrollear hasta ahí. dvh (dynamic viewport height) se
            recalcula con el teclado abierto, así que el layout se ajusta de
            verdad y el <main> (que ya tiene su propio overflow-y-auto) queda
            100% scrolleable dentro del espacio real y visible. */}
        <div className="flex min-h-dvh bg-greenfit-dark text-white">
          <Sidebar abierto={sidebarAbierto} onCerrar={() => setSidebarAbierto(false)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <Header onAbrirSidebar={() => setSidebarAbierto(true)} />
            <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
              <Outlet />
            </main>
          </div>
        </div>
        <RecordatorioToast />
      </NotasProvider>
    </ConfiguracionProvider>
  )
}

export default Layout
