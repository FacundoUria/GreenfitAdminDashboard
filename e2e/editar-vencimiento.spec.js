import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, PROFILE_MARTINA, DISCIPLINA_CROSSFIT } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// Socio de plan "por vencimiento" (Aparatos) con fecha ya
// cargada -- para probar la edición DIRECTA, sin pasar por "Registrar Pago".
const SOCIO_APARATOS = {
  id: 'e2e-socio-aparatos',
  nombre: 'Lucía',
  apellido: 'Paz',
  dni: '30222333',
  email: 'lucia@e2e.test',
  telefono: '2610000001',
  plan: ['Aparatos'],
  estado: 'Activo',
  fecha_vencimiento: '2026-08-10',
  dia_corte: 10,
  created_at: '2025-02-01T00:00:00.000Z',
  ultimo_pago: '2026-07-10',
  creditos: 0,
  activo: true,
}

const PROFILE_APARATOS = {
  id: 'e2e-profile-aparatos',
  dni: SOCIO_APARATOS.dni,
  full_name: 'Lucía Paz',
  role: 'socio',
  created_at: '2025-02-01T00:00:00.000Z',
}

test.describe('Admin -- Edición directa de vencimiento (sin pasar por "Cobrar")', () => {
  test('editar la fecha de vencimiento desde "Editar Socio" persiste en socios Y sincroniza con la PWA', async ({
    page,
  }) => {
    const tablas = { ...tablasBase(), socios: [SOCIO_APARATOS], profiles: [PROFILE_APARATOS] }
    await loginComoAdmin(page, { tables: tablas })

    await irASocios(page)
    await expect(page.getByRole('table').getByText('Lucía Paz')).toBeVisible()
    await page.locator('[title="Editar"]:visible').click()

    await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()
    const inputFecha = page.getByLabel('Fecha de vencimiento')
    await expect(inputFecha).toHaveValue('2026-08-10')

    await inputFecha.fill('2026-09-15')
    await page.getByRole('button', { name: 'Guardar' }).click()

    await expect(page.getByText('Vencimiento actualizado')).toBeVisible()

    // Persistió en `socios` -- el vencimiento nuevo y el dia_corte
    // recalculado del día-del-mes de esa fecha (15).
    expect(tablas.socios[0].fecha_vencimiento).toBe('2026-09-15')
    expect(tablas.socios[0].dia_corte).toBe(15)

    // Se sincronizó con la PWA -- sin esto, la app le seguiría mostrando la
    // fecha vieja hasta el próximo "Registrar Pago" (el bug que se pidió cerrar).
    const filaSync = tablas.user_credits.find((uc) => uc.user_id === PROFILE_APARATOS.id)
    expect(filaSync, 'esperaba una fila nueva en user_credits para el socio').toBeTruthy()
    expect(filaSync.expires_at).toContain('2026-09-15')
  })

  // Bug reportado: antes el campo de vencimiento SOLO aparecía si el socio
  // tenía Aparatos/Pase Libre -- un socio 100% de créditos (CrossFit/Boxeo)
  // no tenía forma de que el Admin le asigne/renueve un vencimiento. Ahora
  // aparece igual, y al guardar sincroniza con user_credits SIN pisar el
  // balance de créditos real (a diferencia de una membresía, acá
  // remaining_credits tiene que preservarse).
  test('un socio 100% de créditos SÍ muestra el campo de vencimiento al editar, y guardarlo preserva el balance de créditos', async ({
    page,
  }) => {
    const tablas = {
      ...tablasBase(), // socio base del fixture: plan ['CrossFit'], dni '30111222'
      user_credits: [
        {
          id: 'uc-martina-crossfit',
          user_id: PROFILE_MARTINA.id,
          discipline_id: DISCIPLINA_CROSSFIT.id,
          remaining_credits: 9,
          expires_at: null,
          created_at: '2026-07-01T00:00:00.000Z',
        },
      ],
    }
    await loginComoAdmin(page, { tables: tablas })

    await irASocios(page)
    await page.locator('[title="Editar"]:visible').click()
    await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

    const inputFecha = page.getByLabel('Fecha de vencimiento')
    await expect(inputFecha).toBeVisible()

    await inputFecha.fill('2026-09-20')
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect(page.getByText('Vencimiento actualizado')).toBeVisible()

    // La fila MÁS RECIENTE de user_credits para CrossFit tiene que traer el
    // expires_at nuevo, pero SIGUE con los 9 créditos reales -- no null, no
    // 0 -- esto es justo lo que distingue a sincronizarVencimientoCreditoPwa
    // de sincronizarVencimientoPwa (esa sí pisa con null, correcto para
    // Aparatos, pero rompería el balance acá).
    const filasCrossfit = tablas.user_credits
      .filter((uc) => uc.user_id === PROFILE_MARTINA.id && uc.discipline_id === DISCIPLINA_CROSSFIT.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    const masReciente = filasCrossfit[0]
    expect(masReciente.expires_at).toContain('2026-09-20')
    expect(masReciente.remaining_credits).toBe(9)
  })
})
