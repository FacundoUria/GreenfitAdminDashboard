import { useContext } from 'react'
import { NotasContext } from './notasContextBase'

export function useNotas() {
  const context = useContext(NotasContext)
  if (!context) {
    throw new Error('useNotas debe usarse dentro de <NotasProvider>')
  }
  return context
}
