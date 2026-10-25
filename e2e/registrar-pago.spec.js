import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'
import { mockAdminAcreditarCreditosManual } from './support/rpcMocks.js'

// Cubre el checklist del modal "Registrar Pago": captura Monto/Método y
// persiste en pagos_socio (además del flujo ya existente de socios/créditos).
test('Registrar Pago carga Monto/Método y confirma sin errores', async ({ page }) => {
  const tables = tablasBase()
  await loginComoAdmin(page, { tables, rpc: { admin_acreditar_creditos_manual: mockAdminAcreditarCreditosManual(tables) } })

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

// T1 (R2): un pago invalida TODOS los créditos anteriores. Un lote en 0 que
// todavía tenía fecha futura (plan viejo) también queda vencido -- si no, un
// +1 al cancelar lo "revivía" con la fecha vieja. Un lote que ya venía vencido
// conserva su fecha real.
test('Registrar Pago vence también los lotes en 0 con fecha futura (R2)', async ({ page }) => {
  const tables = tablasBase()
  const enVeinteDias = new Date(Date.now() + 20 * 86_400_000).toISOString()
  const haceDiezDias = new Date(Date.now() - 10 * 86_400_000).toISOString()
  tables.user_credits.push(
    {
      id: 'uc-martina-cero-futuro',
      user_id: tables.user_credits[0].user_id,
      discipline_id: tables.user_credits[0].discipline_id,
      remaining_credits: 0,
      expires_at: enVeinteDias,
      created_at: '2026-06-01T00:00:00.000Z',
      discipline: tables.user_credits[0].discipline,
    },
    {
      id: 'uc-martina-cero-vencido',
      user_id: tables.user_credits[0].user_id,
      discipline_id: tables.user_credits[0].discipline_id,
      remaining_credits: 0,
      expires_at: haceDiezDias,
      created_at: '2026-05-01T00:00:00.000Z',
      discipline: tables.user_credits[0].discipline,
    },
  )
  await loginComoAdmin(page, { tables, rpc: { admin_acreditar_creditos_manual: mockAdminAcreditarCreditosManual(tables) } })

  await irASocios(page)
  await expect(page.getByRole('table').getByText('Martina Ríos')).toBeVisible()
  await page.locator('[title="Registrar Pago / Renovar Cuota"]:visible').click()
  await expect(page.getByText('Registrar Pago / Renovar Cuota')).toBeVisible()
  await page.getByRole('button', { name: '+8' }).last().click()
  await page.getByRole('button', { name: 'Confirmar' }).click()
  await expect(page.getByText('Pago registrado correctamente')).toBeVisible({ timeout: 10_000 })

  const ahora = new Date().toISOString()
  const fila = (id) => tables.user_credits.find((f) => f.id === id)
  // El lote en 0 con fecha futura quedó vencido (antes de T1 seguía con su fecha).
  expect(fila('uc-martina-cero-futuro').remaining_credits).toBe(0)
  expect(fila('uc-martina-cero-futuro').expires_at < ahora).toBe(true)
  // El lote con saldo, igual que siempre: en 0 y vencido.
  expect(fila('uc-martina-crossfit').remaining_credits).toBe(0)
  expect(fila('uc-martina-crossfit').expires_at < ahora).toBe(true)
  // El que ya venía vencido conserva su fecha real.
  expect(fila('uc-martina-cero-vencido').expires_at).toBe(haceDiezDias)
  // Queda un solo lote vigente de CrossFit: el nuevo.
  const vigentes = tables.user_credits.filter(
    (f) => f.discipline_id === tables.user_credits[0].discipline_id && f.expires_at > ahora,
  )
  expect(vigentes).toHaveLength(1)
  expect(vigentes[0].remaining_credits).toBeGreaterThan(0)
})
