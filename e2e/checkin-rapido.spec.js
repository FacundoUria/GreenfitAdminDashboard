import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'

// Cubre el checklist del botón "Check-in Rápido ⚡" del Navbar: modal
// buscador por DNI/Nombre, +100 XP con un clic, y el límite de 1 vez por
// día (índice único server-side -- acá simulado con un 23505 la segunda
// vez que se otorga al mismo socio).
//
// Socio dedicado (sin XP/bookings previos en las fixtures) para que el
// widget de "Actividad Reciente" del Dashboard no muestre su nombre de
// entrada y ambigüe el `getByText` -- ver la nota de "Martina Ríos" en
// socios-tabla.spec.js/ficha360.spec.js para el mismo tipo de problema.
const SOCIO_CHECKIN = {
  id: 'e2e-profile-checkin',
  dni: '40222333',
  full_name: 'Bruno Test',
  avatar_url: null,
  role: 'socio',
  created_at: '2025-01-01T00:00:00.000Z',
}

test('Check-in Rápido otorga +100 XP y respeta el límite de 1 por día', async ({ page }) => {
  let otorgado = false
  await loginComoAdmin(page, {
    tables: { ...tablasBase(), profiles: [SOCIO_CHECKIN], xp_events: [] },
    rpc: {
      admin_otorgar_checkin_musculacion: (request) => {
        const { p_user_id: userId } = request.postDataJSON()
        expect(userId).toBe(SOCIO_CHECKIN.id) // el Admin manda el user_id exacto del socio buscado
        if (otorgado) {
          return { __e2eError: { status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint' } } }
        }
        otorgado = true
        return null
      },
    },
  })

  // El botón vive en el Header, disponible en cualquier pantalla del panel
  // -- no hace falta navegar a Socios. getByRole (no getByText) porque el
  // texto del botón vive en un <span> hijo: un getByText exacto matchea
  // TANTO el <button> como ese <span> (mismo texto normalizado en los dos).
  await page.getByRole('button', { name: 'Check-in Rápido' }).click()
  await expect(page.getByLabel('Buscar socio')).toBeVisible()

  await page.getByLabel('Buscar socio').fill('Bruno')
  await expect(page.getByText('DNI 40222333')).toBeVisible()

  await page.getByRole('button', { name: 'Otorgar' }).click()
  // exact:true -- el párrafo de ayuda del modal ("Buscá un socio y otorgale
  // +100 XP de entreno libre...") contiene el mismo substring, y una vez
  // otorgado también matchea. Con más workers en paralelo (suite más
  // grande) esto se volvió flaky de verdad en vez de "ganarle por
  // timing" a la ambigüedad.
  await expect(page.getByText('+100 XP', { exact: true })).toBeVisible()

  // Cierra y vuelve a abrir -- el estado local del modal se resetea, pero
  // el índice único del lado del servidor (simulado acá) sigue recordando
  // que este socio ya tiene su check-in de hoy.
  // getByLabel('Cerrar') matchea también el botón "Cerrar menú" del Sidebar
  // mobile (mismo prefijo) -- name exacto para quedarse solo con el del modal.
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click()
  await page.getByText('Check-in Rápido', { exact: true }).click()
  // El modal resetea su búsqueda cada vez que se reabre (useEffect en
  // `visible`) -- si el .fill() de abajo corre ANTES de que ese reset
  // termine de aplicarse, el reset gana la carrera y pisa el 'Bruno'
  // recién tipeado. Se espera el placeholder de "sin búsqueda todavía"
  // para asegurarse de tipear DESPUÉS de que el reset ya se aplicó.
  await expect(page.getByText('Empezá a escribir para buscar un socio.')).toBeVisible()
  await page.getByLabel('Buscar socio').fill('Bruno')
  await expect(page.getByText('DNI 40222333')).toBeVisible()
  await page.getByRole('button', { name: 'Otorgar' }).click()
  await expect(page.getByText('Ya registrado hoy')).toBeVisible()
})
