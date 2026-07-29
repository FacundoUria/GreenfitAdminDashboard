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
        <div className="flex min-h-screen bg-greenfit-dark text-white">
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
