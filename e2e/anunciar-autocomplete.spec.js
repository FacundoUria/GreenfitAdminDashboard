import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, PROFILE_MARTINA } from './support/fixtures.js'

// Cubre el checklist del autocomplete de "Anunciar": reemplaza el viejo
// input rígido de DNI por una búsqueda en tiempo real por Nombre/Apellido/
// DNI (mismo buscador que ya usa Check-in Rápido, buscarSociosParaCheckin),
// un dropdown con avatar/iniciales + nombre + DNI, y vincula el user_id
// exacto al seleccionar -- sin volver a resolverlo por DNI al enviar.
test('buscar un socio por nombre, seleccionarlo del dropdown y enviar el anuncio', async ({ page }) => {
  let bodyEnviado = null

  await loginComoAdmin(page, {
    tables: { ...tablasBase(), profiles: [PROFILE_MARTINA] },
    functions: {
      'send-push': (request) => {
        bodyEnviado = request.postDataJSON()
        return { destinatarios: 1, enviados: 1, expirados: 0, errores: [] }
      },
    },
  })

  await page.getByRole('link', { name: 'Anunciar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Anunciar' })).toBeVisible()

  await page.getByLabel('Audiencia').selectOption('user')

  // Busca por NOMBRE (no DNI) -- confirma el filtro real, no solo un
  // pass-through de la fixture.
  await page.getByLabel('Buscar socio').fill('Martina')
  await expect(page.getByText('DNI 30111222')).toBeVisible()

  await page.getByText('Martina Ríos', { exact: true }).click()

  // El dropdown se cierra y queda la "tarjeta" del socio seleccionado.
  await expect(page.getByLabel('Buscar socio')).toHaveCount(0)
  await expect(page.getByText('DNI 30111222')).toBeVisible()

  await page.getByPlaceholder('Ej: ¡Clase de mañana reprogramada!').fill('Aviso para Martina')
  await page.getByPlaceholder('Escribí el anuncio...').fill('Che, no te olvides de tu clase de mañana.')

  await page.getByRole('button', { name: 'Enviar anuncio' }).click()

  await expect(page.getByText('Anuncio enviado a 1 socio(s)', { exact: false })).toBeVisible()
  // El body mandado a la function usa el user_id exacto resuelto por el
  // autocomplete, no un DNI de texto libre.
  expect(bodyEnviado.targetUserId).toBe(PROFILE_MARTINA.id)
  expect(bodyEnviado.audience).toBe('user')
})

test('cambiar de socio seleccionado vuelve a mostrar el buscador', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: { ...tablasBase(), profiles: [PROFILE_MARTINA] },
    functions: { 'send-push': () => ({ destinatarios: 1, enviados: 1, expirados: 0, errores: [] }) },
  })

  await page.getByRole('link', { name: 'Anunciar', exact: true }).click()
  await page.getByLabel('Audiencia').selectOption('user')
  await page.getByLabel('Buscar socio').fill('30111222') // busca por DNI esta vez
  await page.getByText('Martina Ríos', { exact: true }).click()
  await expect(page.getByText('DNI 30111222')).toBeVisible()

  await page.getByLabel('Cambiar socio').click()
  await expect(page.getByLabel('Buscar socio')).toBeVisible()
  await expect(page.getByText('DNI 30111222')).toHaveCount(0)
})
