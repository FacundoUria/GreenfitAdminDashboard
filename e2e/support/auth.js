import { expect } from '@playwright/test'
import { mockSupabase } from './supabaseMock.js'

export const ADMIN_DEMO = {
  id: 'e2e-admin-0000-0000-0000-000000000000',
  email: 'seba.e2e@greenfit.test',
  fullName: 'Seba E2E',
}

// Login real por UI (tipear Email + Contraseña + tocar "Ingresar") contra
// el backend mockeado -- ejercita el flujo de punta a punta tal cual lo usa
// el admin real, sin inyectar sesión "por atrás".
export async function loginComoAdmin(page, { user = ADMIN_DEMO, tables = {}, rpc = {} } = {}) {
  await mockSupabase(page, { user, tables, rpc })
  await page.goto('/')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Contraseña').fill('cualquier-clave')
  await page.getByRole('button', { name: 'Ingresar' }).click()
  // El Header muestra el nombre real del admin logueado (a diferencia del
  // saludo hardcodeado "¡Hola, Seba!" de Home.jsx, que no sirve para
  // confirmar la identidad real).
  await expect(page.getByText(user.fullName, { exact: true })).toBeVisible({ timeout: 15_000 })
  return user
}
