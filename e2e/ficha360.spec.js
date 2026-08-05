import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, PROFILE_MARTINA } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// Cubre el checklist de la Ficha 360°: las 4 pestañas (Pagos/Asistencias/
// Rutinas/Métricas) con datos reales, resueltos por DNI contra el schema
// de la PWA.
test('la Ficha 360 muestra Pagos, Asistencias unificadas, Rutinas y Métricas reales', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: {
      ...tablasBase(),
      pagos_socio: [
        {
          id: 'pago-1',
          user_id: PROFILE_MARTINA.id,
          fecha: '2026-08-01',
          paquete: 'CrossFit',
          monto: 15000,
          metodo_pago: 'efectivo',
          periodo_desde: '2026-08-01',
          periodo_hasta: '2026-09-01',
          estado: 'pagado',
          origen: 'manual',
        },
      ],
      bookings: [
        {
          id: 'booking-1',
          user_id: PROFILE_MARTINA.id,
          booking_date: '2026-08-01',
          attended: true,
          classes: { title: 'CrossFit', instructor: 'Seba' },
        },
      ],
      routines: [
        { id: 'rutina-1', user_id: PROFILE_MARTINA.id, title: 'Rutina de Fuerza', coach_name: 'Seba', created_at: '2026-07-01T00:00:00.000Z' },
      ],
    },
  })

  await irASocios(page)
  // Móvil (SocioCard) y desktop (<table>) coexisten en el DOM (CSS
  // responsive, no render condicional) -- se escopea a la tabla.
  await expect(page.getByRole('table').getByText('Martina Ríos')).toBeVisible()
  await page.locator('[title="Editar"]:visible').click()

  // NuevoSocioModal (edición) queda montado ENCIMA de la tabla de Socios,
  // que sigue en el DOM -- toda esta ficha vive en un <form>, así que se
  // escopea ahí para no chocar con la misma fila (avatar/nombre/badge N3)
  // que sigue visible debajo (mismo problema que "Martina Ríos" arriba).
  const modal = page.locator('form')
  await expect(modal.getByText('Historial y Actividad del Socio')).toBeVisible()

  // Pagos (pestaña por defecto): Monto/Método/Estado reales. Intl.NumberFormat
  // ('es-AR') puede meter un espacio (a veces NBSP) entre "$" y el número
  // según el motor ICU -- regex en vez de substring exacto.
  await expect(modal.getByText(/\$\s?15\.000/)).toBeVisible()
  await expect(modal.getByText('Efectivo')).toBeVisible()
  await expect(modal.getByText('pagado')).toBeVisible()

  // Asistencias: clase reservada + check-in libre, unificados.
  await modal.getByText('📅 Asistencias').click()
  await expect(modal.getByText('Clase: CrossFit')).toBeVisible()
  await expect(modal.getByText('Prof. Seba')).toBeVisible()
  await expect(modal.getByText('Entrenamiento Libre: ¡Hoy entrené!')).toBeVisible()

  // Rutinas.
  await modal.getByText('🏋️ Rutinas').click()
  await expect(modal.getByText('Rutina de Fuerza')).toBeVisible()

  // Métricas: mismo nivel (N3) que ya mostraba la tabla principal.
  await modal.getByText('⚡ Métricas').click()
  await expect(modal.getByText('N3', { exact: true })).toBeVisible()
})
