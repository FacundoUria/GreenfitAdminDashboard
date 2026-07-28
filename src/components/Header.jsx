function Header({ title = 'Panel de administración' }) {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/5 bg-greenfit-dark px-6">
      <h1 className="text-lg font-semibold text-white">{title}</h1>

      <div className="flex items-center gap-3">
        <div className="text-right">
          <p className="text-sm font-medium text-white">Facundo Rial</p>
          <p className="text-xs text-gray-400">Administrador</p>
        </div>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-greenfit-primary text-sm font-semibold text-greenfit-dark">
          FR
        </div>
      </div>
    </header>
  )
}

export default Header
