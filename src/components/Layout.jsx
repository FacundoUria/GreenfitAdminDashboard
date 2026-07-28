import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Header from './Header'
import RecordatorioToast from './RecordatorioToast'
import { ConfiguracionProvider } from '../context/ConfiguracionContext'
import { NotasProvider } from '../context/NotasContext'

function Layout() {
  return (
    <ConfiguracionProvider>
      <NotasProvider>
        <div className="flex min-h-screen bg-greenfit-dark text-white">
          <Sidebar />
          <div className="flex flex-1 flex-col">
            <Header />
            <main className="flex-1 overflow-y-auto p-6">
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
