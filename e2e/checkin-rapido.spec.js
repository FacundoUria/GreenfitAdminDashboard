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
  // Texto de la bajada del modal, actualizado en la unificación de reglas
  // de XP (la acreditación es SIEMPRE vía check-in del Admin).
  await expect(
    page.getByText('Confirmá la asistencia del socio presente para acreditar sus +100 XP diarios de entrenamiento y registrar su presente.'),
  ).toBeVisible()

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
  // recién tipeado. Se espera el mensaje de "sin clase activa" (tablasBase()
  // no tiene ninguna clase cargada) para asegurarse de tipear DESPUÉS de que
  // el reset -- y la carga de sugerencias -- ya terminaron de aplicarse.
  await expect(page.getByText('No hay ninguna clase en curso ni por arrancar ahora.', { exact: false })).toBeVisible()
  await page.getByLabel('Buscar socio').fill('Bruno')
  await expect(page.getByText('DNI 40222333')).toBeVisible()
  await page.getByRole('button', { name: 'Otorgar' }).click()
  await expect(page.getByText('Ya registrado hoy')).toBeVisible()
})

// -- Sugerencias inteligentes (inscriptos de la clase activa/por arrancar) --
//
// Reloj CONGELADO (page.clock) en vez de relativo a `new Date()` real:
//  1) Determinismo total -- misma fecha/hora "Lunes 18:10, clase de 18 a 19"
//     que ya usan (y tienen probado) los unit tests de
//     fichaSocioPwa.test.js, en vez de reconstruir la ventana activa contra
//     el reloj real de la máquina en el momento de correr la suite.
//  2) `buscarSociosClaseActiva` compara strings "HH:MM:SS" de un solo día y
//     su helper interno (restarMinutos) resuelve el "30 min antes" con
//     wraparound (ej: 00:00 - 30min -> "23:30:00") -- si el reloj real de
//     la máquina cae en la madrugada (00:00 a 00:29), CUALQUIER clase
//     "activa ahora" construida en base a ese reloj real termina con ese
//     wraparound y el filtro la descarta. Congelar el reloj evita pelear
//     contra esa ventana angosta en vez de contra la lógica que se quiere
//     probar.
const HORA_CONGELADA = new Date('2026-08-10T18:10:00') // Lunes 18:10 -- clase de Lunes 18 a 19 en curso.

const CLASE_ACTIVA = {
  id: 'clase-e2e-activa',
  title: 'CrossFit 18hs',
  start_time: '18:00:00',
  end_time: '19:00:00',
  days_of_week: [1], // Lunes -- HORA_CONGELADA.getDay() === 1.
  discipline: { name: 'CrossFit' },
}

const INSCRIPTO_CLASE = {
  id: 'booking-e2e-activa',
  user_id: 'e2e-profile-inscripto-clase',
  class_id: 'clase-e2e-activa',
  booking_date: HORA_CONGELADA.toISOString().slice(0, 10), // misma fecha (UTC) que usa buscarSociosClaseActiva para filtrar bookings de "hoy".
  attended: false,
  profiles: { full_name: 'Carla Suárez', dni: '35444555' },
}

test('Check-in Rápido lista automáticamente a los inscriptos de la clase en curso y les da presente sin buscarlos', async ({ page }) => {
  await page.clock.setFixedTime(HORA_CONGELADA)
  await loginComoAdmin(page, {
    tables: { ...tablasBase(), classes: [CLASE_ACTIVA], bookings: [INSCRIPTO_CLASE] },
  })

  await page.getByRole('button', { name: 'Check-in Rápido' }).click()
  // Modal-scoped (role="dialog") -- el Dashboard debajo del modal también
  // puede mostrar a "Carla Suárez" en sus propios widgets de asistencias
  // recientes (misma reserva de hoy), así que un getByText sin acotar a
  // este diálogo puede resolver a más de un nodo.
  const modal = page.getByRole('dialog', { name: 'Check-in Rápido' })
  // Sin escribir nada en el buscador -- las sugerencias aparecen solas.
  await expect(modal.getByText('Inscriptos en la clase en curso')).toBeVisible()
  await expect(modal.getByText('Carla Suárez')).toBeVisible()
  await expect(modal.getByText('CrossFit · 18:00 a 19:00')).toBeVisible()

  await modal.getByRole('button', { name: /dar presente/i }).click()
  await expect(modal.getByText('Presente', { exact: true })).toBeVisible()
})

test('un inscripto que ya tiene la asistencia marcada aparece directo como "Presente", sin botón', async ({ page }) => {
  await page.clock.setFixedTime(HORA_CONGELADA)
  await loginComoAdmin(page, {
    tables: { ...tablasBase(), classes: [CLASE_ACTIVA], bookings: [{ ...INSCRIPTO_CLASE, attended: true }] },
  })

  await page.getByRole('button', { name: 'Check-in Rápido' }).click()
  const modal = page.getByRole('dialog', { name: 'Check-in Rápido' })
  await expect(modal.getByText('Carla Suárez')).toBeVisible()
  await expect(modal.getByText('Presente', { exact: true })).toBeVisible()
  await expect(modal.getByRole('button', { name: /dar presente/i })).toHaveCount(0)
})
