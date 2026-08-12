import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT } from './support/fixtures.js'
import { irAClases } from './support/nav.js'

// Disciplinas "por vencimiento" (ej. Aparatos: acceso libre, sin cupo que
// reservar) no tienen que figurar en las agendas -- Clases.jsx (Admin) y el
// widget "Próximas Clases de Hoy" de Home.jsx. `show_in_agenda=false` es el
// MISMO flag que ya usa loadClassesForDate() en la PWA (classesApi.ts) para
// excluir Aparatos de "Mi Agenda" del socio, así que Admin y PWA quedan
// mostrando exactamente el mismo criterio.
const DISCIPLINA_APARATOS_SIN_AGENDA = {
  id: 'disc-aparatos-sin-agenda',
  name: 'Aparatos',
  kind: 'membership',
  is_active: true,
  show_in_agenda: false,
}

const HOY = new Date()
const DIA_HOY = HOY.getDay()

const CLASE_CROSSFIT = {
  id: 'clase-crossfit-hoy',
  discipline_id: DISCIPLINA_CROSSFIT.id,
  title: 'CrossFit',
  instructor: 'Seba',
  capacity: 20,
  days_of_week: [DIA_HOY],
  start_time: '18:00:00',
  end_time: '19:00:00',
}

// Horario REAL de gimnasio cargado para Aparatos (para que la landing y la
// tarjeta de Disciplinas.jsx lo muestren, ver disciplinas-horarios.spec.js)
// -- justamente el caso que antes también se filtraba, sin querer, a las
// agendas de clases reservables.
const CLASE_APARATOS = {
  id: 'clase-aparatos-hoy',
  discipline_id: DISCIPLINA_APARATOS_SIN_AGENDA.id,
  title: 'Aparatos',
  instructor: null,
  capacity: 0,
  days_of_week: [DIA_HOY],
  start_time: '08:00:00',
  end_time: '22:00:00',
}

// El mock compartido (supabaseMock.js) no resuelve joins de verdad -- el
// embed `disciplines(show_in_agenda)` que ahora piden Clases.jsx/Home.jsx no
// vendría poblado, y el filtro "fail-open" (undefined !== false -> visible)
// dejaría pasar todo sin probar nada. Route handler LOCAL a este archivo que
// resuelve ESE embed a partir de discipline_id + tables.disciplines -- no
// toca el mock compartido ni el resto de la suite.
async function mockEmbedDisciplinesEnClasses(page, tables) {
  await page.route('**/rest/v1/classes*', async (route) => {
    const request = route.request()
    if (request.method() !== 'GET') {
      await route.fallback()
      return
    }
    const filas = (tables.classes ?? []).map((fila) => ({
      ...fila,
      disciplines: (tables.disciplines ?? []).find((d) => d.id === fila.discipline_id) ?? null,
    }))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(filas) })
  })
}

test('Admin -- Clases: una disciplina con show_in_agenda=false (Aparatos) no aparece en la agenda del día', async ({
  page,
}) => {
  const tables = {
    ...tablasBase(),
    disciplines: [DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS_SIN_AGENDA],
    classes: [CLASE_CROSSFIT, CLASE_APARATOS],
  }
  await loginComoAdmin(page, { tables })
  await mockEmbedDisciplinesEnClasses(page, tables)

  await irAClases(page)
  await expect(page.getByText('CrossFit', { exact: true })).toBeVisible()
  await expect(page.getByText('Aparatos', { exact: true })).toHaveCount(0)
})

test('Admin -- Home: el widget "Próximas Clases de Hoy" tampoco muestra Aparatos', async ({ page }) => {
  const tables = {
    ...tablasBase(),
    disciplines: [DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS_SIN_AGENDA],
    classes: [CLASE_CROSSFIT, CLASE_APARATOS],
  }
  await loginComoAdmin(page, { tables })
  // loginComoAdmin ya navegó a Home (post-login) ANTES de que se pueda
  // registrar acá el override del embed -- Home.jsx ya disparó su fetch con
  // el mock compartido (sin `disciplines`, fail-open). Un reload fuerza un
  // mount nuevo, esta vez con el override ya activo.
  await mockEmbedDisciplinesEnClasses(page, tables)
  await page.reload()

  await expect(page.getByText('Próximas Clases de Hoy')).toBeVisible()
  const seccion = page.getByText('Próximas Clases de Hoy').locator('../..')
  await expect(seccion.getByText('CrossFit', { exact: true })).toBeVisible()
  await expect(seccion.getByText('Aparatos', { exact: true })).toHaveCount(0)
})
