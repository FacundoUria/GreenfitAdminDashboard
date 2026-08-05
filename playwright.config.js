import { defineConfig, devices } from '@playwright/test'

// Suite E2E de navegador real -- corre contra `vite build --mode e2e` +
// `vite preview` (más estable/rápido que el server de dev para CI). El
// backend de Supabase se mockea 100% a nivel de red (ver
// e2e/support/supabaseMock.js): VITE_SUPABASE_URL en modo "e2e" (.env.e2e,
// ver ese archivo) apunta a un dominio FALSO a propósito -- si algún
// request se escapa sin mockear, falla por DNS en vez de pegarle en
// silencio a producción.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4390',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `vite preview` sirve el `dist/` ya generado tal cual -- las env vars
    // quedan fijas desde el build (`--mode e2e`), preview no las vuelve a
    // leer, así que no hace falta repetir el --mode acá.
    // --host 127.0.0.1 explícito: sin esto, Vite bindea solo a `[::1]`
    // (IPv6) y Playwright (que apunta a 127.0.0.1/IPv4) nunca lo detecta
    // arriba -- se comprobó en la práctica (timeout de 120s esperando el
    // webServer aunque `vite preview` ya estaba corriendo).
    command: 'npm run build:e2e && npx vite preview --host 127.0.0.1 --port 4390 --strictPort',
    url: 'http://127.0.0.1:4390',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
