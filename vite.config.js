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
    // Vitest por defecto matchea *.spec.js -- sin esto, intenta correr los
    // specs de Playwright de e2e/ como si fueran tests de Vitest (y
    // explota: Playwright detecta que no lo estás llamando vía
    // `playwright test` y tira "did not expect test() to be called here").
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
})
