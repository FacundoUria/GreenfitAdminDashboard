import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// Cubre el checklist de la tabla principal de Socios: avatar real
// sincronizado desde profiles.avatar_url + badge "N{x}" de nivel.
test('la tabla de Socios muestra el avatar real y el badge de nivel', async ({ page }) => {
  await loginComoAdmin(page, { tables: tablasBase() })

  await irASocios(page)

  // Móvil (SocioCard) y desktop (<table>) están ambos en el DOM, ocultos
  // por CSS según viewport, no por render condicional -- se escopea a la
  // tabla (visible en el viewport desktop default de Playwright).
  await expect(page.getByRole('table').getByText('Martina Ríos')).toBeVisible()
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Martina Ríos/ })
  // Avatar real (no el fallback de iniciales).
  await expect(filaTabla.locator(`img[src*="martina/avatar.jpg"]`)).toBeVisible()
  // Nivel real: 700 + 450 = 1150 XP -> NIVEL 3.
  await expect(filaTabla.getByText('N3', { exact: true })).toBeVisible()
})
