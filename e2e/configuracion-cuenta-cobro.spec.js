import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irAConfiguracion } from './support/nav.js'

// "Cuentas de Cobro (Mostrador)" -- Alias/CVU y Titular que la PWA muestra
// en "Elegí tu pack" / "¿Preferís transferencia?" (ver
// greenfit-app/src/context/ConfiguracionContext.tsx y HomeScreen.tsx). Este
// spec prueba la mitad del Admin: editar y guardar persiste de verdad en
// `configuracion`, con los nombres de campo reales (alias_cvu/titular_cuenta).

test('editar Alias/CVU y Titular en Configuración persiste en Supabase', async ({ page }) => {
  const tablas = tablasBase()
  await loginComoAdmin(page, { tables: tablas })

  await irAConfiguracion(page)
  const cuentaCobroCard = page.getByRole('heading', { name: 'Cuentas de Cobro (Mostrador)' }).locator('..')
  await expect(cuentaCobroCard).toBeVisible()

  // TextField no asocia <label> con <input> (sin htmlFor/id) -- mismo
  // criterio que configuracion-alerta.spec.js: se escopea a la tarjeta y se
  // ubica por placeholder en vez de por label.
  await cuentaCobroCard.getByPlaceholder('greenfit.gym').fill('greenfit.nueva.cuenta')
  await cuentaCobroCard.getByPlaceholder('Greenfit SRL').fill('Sebastián Greenfit SRL')

  await page.getByRole('button', { name: 'Guardar Cambios' }).click()
  await expect(page.getByText('Cambios guardados correctamente')).toBeVisible()

  expect(tablas.configuracion[0].alias_cvu).toBe('greenfit.nueva.cuenta')
  expect(tablas.configuracion[0].titular_cuenta).toBe('Sebastián Greenfit SRL')
})

// Regresión: antes, cualquier falla al guardar Configuración (constraint
// real, RLS, lo que sea) mostraba siempre el mismo genérico "No se pudo
// guardar la configuración. Intentá nuevamente." sin ninguna pista real.
test('si falla el guardado de Configuración, muestra el motivo real (no el genérico)', async ({ page }) => {
  const tablas = tablasBase()
  await loginComoAdmin(page, { tables: tablas })

  // Simula un UPDATE de `configuracion` bloqueado (Postgrest real responde
  // 200 con 0 filas cuando una policy RLS bloquea la escritura, sin `error`).
  await page.route('**/rest/v1/configuracion*', async (route) => {
    const request = route.request()
    if (request.method() !== 'PATCH') {
      await route.fallback()
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })

  await irAConfiguracion(page)
  const cuentaCobroCard = page.getByRole('heading', { name: 'Cuentas de Cobro (Mostrador)' }).locator('..')
  await cuentaCobroCard.getByPlaceholder('Greenfit SRL').fill('Titular que no se va a guardar')
  await page.getByRole('button', { name: 'Guardar Cambios' }).click()

  const mensajeError = page.locator('text=No se pudo guardar la configuración:')
  await expect(mensajeError).toBeVisible()
  // No es el genérico viejo sin motivo real.
  await expect(page.getByText('No se pudo guardar la configuración. Intentá nuevamente.')).toHaveCount(0)
})
