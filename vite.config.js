import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // Sin `globals: true` a propósito -- cada test importa describe/it/
    // expect/vi de 'vitest' explícito, así ESLint no necesita un config de
    // globals nuevo para los archivos de test.
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
  },
})
