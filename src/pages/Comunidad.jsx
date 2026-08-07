import { useState } from 'react'
import { MessageCircle, Newspaper, Trophy } from 'lucide-react'
import FeedAdmin from '../components/comunidad/FeedAdmin'
import RankingAdmin from '../components/comunidad/RankingAdmin'

// Vista de supervisión de la Comunidad de la PWA -- Feed y Ranking, de solo
// lectura. Mensajes privados queda AFUERA a propósito (privacidad: el Admin
// no debe poder leer chats 1 a 1 entre socios).
const TABS = [
  { value: 'feed', label: 'Feed', icon: Newspaper },
  { value: 'ranking', label: 'Ranking', icon: Trophy },
]

function Comunidad() {
  const [tab, setTab] = useState('feed')

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-greenfit-primary/15">
          <MessageCircle className="h-5 w-5 text-greenfit-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Comunidad</h2>
          <p className="text-sm text-gray-400">
            Publicaciones y ranking de XP de la app de socios -- solo lectura.
          </p>
        </div>
      </div>

      <div className="flex gap-2 border-b border-white/5">
        {TABS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`flex min-h-[44px] items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors ${
              tab === value
                ? 'border-greenfit-primary text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'feed' ? <FeedAdmin /> : <RankingAdmin />}
    </div>
  )
}

export default Comunidad
