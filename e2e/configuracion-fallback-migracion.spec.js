import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irAConfiguracion } from './support/nav.js'

// Hotfix de resiliencia (producción): si `alerta_app_activa` (o cualquier
// otra columna de una migración pendiente) todavía no existe, Postgrest
// rechaza el UPDATE completo de `configuracion` -- sin este fallback, ni
// siquiera datos vitales como Alias/CVU o Titular se guardaban. Mismo
// patrón que el fallback de `fecha_inicio_cuota` en cobro-mostrador.spec.js.
test('si falta la columna alerta_app_activa (migración pendiente), el resto de la configuración se guarda igual y avisa por toast', async ({
  page,
}) => {
  const tablas = tablasBase()
  await loginComoAdmin(page, { tables: tablas })

  // Cualquier PATCH a `configuracion` que incluya `alerta_app_activa` en el
  // payload responde con el error real de producción; sin esa columna, deja
  // pasar al mock compartido normalmente (simula que el resto de columnas sí
  // existen en la tabla real).
  await page.route('**/rest/v1/configuracion*', async (route) => {
    const request = route.request()
    if (request.method() !== 'PATCH') {
      await route.fallback()
      return
    }
    const payload = request.postDataJSON()
    if (payload && 'alerta_app_activa' in payload) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'PGRST204',
          message: "Could not find the 'alerta_app_activa' column of 'configuracion' in the schema cache",
          details: null,
          hint: null,
        }),
      })
      return
    }
    await route.fallback()
  })

  await irAConfiguracion(page)
  const cuentaCobroCard = page.getByRole('heading', { name: 'Cuentas de Cobro (Mostrador)' }).locator('..')
  await cuentaCobroCard.getByPlaceholder('greenfit.gym').fill('greenfit.fallback')
  await cuentaCobroCard.getByPlaceholder('Greenfit SRL').fill('Titular Fallback SRL')

  await page.getByRole('button', { name: 'Guardar Cambios' }).click()

  // Toast informa el fallback -- no el genérico de éxito sin más.
  await expect(page.getByText(/Datos guardados, pero se omitieron campos por una migración pendiente/)).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByText('alerta_app_activa', { exact: false })).toBeVisible()
  await expect(page.getByText('Cambios guardados correctamente')).toHaveCount(0)

  // Los datos vitales SÍ se guardaron -- no se perdieron por la columna faltante.
  expect(tablas.configuracion[0].alias_cvu).toBe('greenfit.fallback')
  expect(tablas.configuracion[0].titular_cuenta).toBe('Titular Fallback SRL')
  // La columna sin migrar nunca se mandó en el segundo intento -- no quedó
  // ningún valor pisado en el mock.
  expect(tablas.configuracion[0].alerta_app_activa).toBeUndefined()
})

// No es un caso de columna faltante -- una falla real (RLS, constraint, lo
// que sea) tiene que seguir mostrando el motivo real sin reintentar en bucle
// ni confundirlo con el aviso de "migración pendiente".
test('un error real (no de columna faltante) sigue mostrando el motivo real, sin activar el fallback', async ({
  page,
}) => {
  const tablas = tablasBase()
  await loginComoAdmin(page, { tables: tablas })

  await page.route('**/rest/v1/configuracion*', async (route) => {
    const request = route.request()
    if (request.method() !== 'PATCH') {
      await route.fallback()
      return
    }
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        code: '23514',
        message: 'new row for relation "configuracion" violates check constraint "configuracion_dias_tolerancia_check"',
        details: null,
        hint: null,
      }),
    })
  })

  await irAConfiguracion(page)
  await page.getByRole('button', { name: 'Guardar Cambios' }).click()

  await expect(page.getByText(/violates check constraint/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/migración pendiente/)).toHaveCount(0)
})
