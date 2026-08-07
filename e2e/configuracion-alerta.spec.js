import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irAConfiguracion } from './support/nav.js'

// "Alerta Global / Anuncio Flotante" -- bloque nuevo en Configuración. La
// mitad "la PWA la muestra y se puede descartar" ya la cubre la suite de
// greenfit-app (e2e/alerta-global.spec.ts); acá se prueba la mitad del
// Admin: activarla + escribir el mensaje efectivamente persiste en
// `configuracion` (alerta_app_activa/alerta_app_mensaje).
test('activar la Alerta Global con un mensaje se guarda en configuracion', async ({ page }) => {
  const tablas = tablasBase()
  await loginComoAdmin(page, { tables: tablas })

  await irAConfiguracion(page)
  await expect(page.getByRole('heading', { name: 'Alerta Global' })).toBeVisible()

  const alertaCard = page.getByRole('heading', { name: 'Alerta Global' }).locator('..')
  await expect(alertaCard.getByRole('switch')).toHaveAttribute('aria-checked', 'false')

  await alertaCard.getByRole('switch').click()
  await alertaCard.getByPlaceholder(/El sábado el gimnasio cierra/).fill('El gimnasio abre normal el feriado')

  await page.getByRole('button', { name: 'Guardar Cambios' }).click()
  await expect(page.getByText('Cambios guardados correctamente')).toBeVisible()

  expect(tablas.configuracion[0].alerta_app_activa).toBe(true)
  expect(tablas.configuracion[0].alerta_app_mensaje).toBe('El gimnasio abre normal el feriado')
})
