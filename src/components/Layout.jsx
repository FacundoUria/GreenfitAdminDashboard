import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Header from './Header'
import { ConfiguracionProvider } from '../context/ConfiguracionContext'

function Layout() {
  return (
    <ConfiguracionProvider>
      <div className="flex min-h-screen bg-greenfit-dark text-white">
        <Sidebar />
        <div className="flex flex-1 flex-col">
          <Header />
          <main className="flex-1 overflow-y-auto p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </ConfiguracionProvider>
  )
}

export default Layout
