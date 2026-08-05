import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// Cubre el checklist del modal "Registrar Pago": captura Monto/Método y
// persiste en pagos_socio (además del flujo ya existente de socios/créditos).
test('Registrar Pago carga Monto/Método y confirma sin errores', async ({ page }) => {
  await loginComoAdmin(page, { tables: tablasBase() })

  await irASocios(page)
  // Móvil (SocioCard) y desktop (<table>) coexisten en el DOM (CSS
  // responsive, no render condicional) -- se escopea a la tabla.
  await expect(page.getByRole('table').getByText('Martina Ríos')).toBeVisible()
  await page.locator('[title="Registrar Pago / Renovar Cuota"]:visible').click()

  await expect(page.getByText('Registrar Pago / Renovar Cuota')).toBeVisible()

  // CrossFit ya viene pre-tildado (es el plan actual de Martina) -- se le
  // suma un pack de 8 créditos. El modal queda montado ENCIMA de la tabla
  // (no la reemplaza), así que el "+8" de CreditosCell (ajuste rápido de
  // la fila) sigue en el árbol de accesibilidad -- .last() porque
  // RegistrarPagoModal se renderiza después de SociosTabla en el JSX.
  await page.getByRole('button', { name: '+8' }).last().click()

  await page.getByLabel('Monto cobrado (opcional)').fill('15000')
  await page.getByLabel('Método de pago').selectOption('efectivo')

  await page.getByRole('button', { name: 'Confirmar' }).click()

  await expect(page.getByText('Pago registrado correctamente')).toBeVisible({ timeout: 10_000 })
})
