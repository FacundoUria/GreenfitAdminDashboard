import { LogOut, Menu } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth'

function Header({ title = 'Panel de administración', onAbrirSidebar = () => {} }) {
  const { usuario, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const iniciales = (usuario?.nombre ?? '?').charAt(0).toUpperCase()

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-white/5 bg-greenfit-dark px-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-1 sm:gap-3">
        <button
          type="button"
          onClick={onAbrirSidebar}
          aria-label="Abrir menú"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-300 transition-colors hover:bg-white/5 hover:text-white lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="truncate text-base font-semibold text-white sm:text-lg">{title}</h1>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <div className="hidden text-right sm:block">
          <p className="text-sm font-medium text-white">{usuario?.nombre}</p>
          <p className="text-xs text-gray-400">{usuario?.rol}</p>
        </div>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-greenfit-primary text-sm font-semibold text-greenfit-dark">
          {iniciales}
        </div>
        <button
          type="button"
          onClick={handleLogout}
          title="Cerrar sesión"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  )
}

export default Header
