import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// BUG CRÍTICO DE SINCRONIZACIÓN (2026-08-07): un socio con más de una
// disciplina de créditos (ej. CrossFit + Boxeo) mostraba en la tabla de
// Socios un solo número GLOBAL (`socios.creditos`, la suma de las dos) con
// un <select> oculto para elegir a cuál disciplina viajaba el ajuste hacia
// la app -- fácil de dejar en la disciplina equivocada sin darse cuenta, y
// el panel no mostraba en ningún lado el balance REAL que ya tenía la PWA
// por disciplina. Fix: una fila por disciplina en la celda de Créditos,
// mostrando el balance real de `user_credits` (no el pozo global) y con
// steppers que nunca son ambiguos sobre a cuál disciplina afectan.

const DISCIPLINA_BOXEO = { id: 'disc-boxeo', name: 'Boxeo', kind: 'credits' }

const SOCIO_MULTI = {
  id: 'e2e-socio-multi',
  nombre: 'Facundo',
  apellido: 'Uria',
  dni: '20333444',
  email: 'facundo@e2e.test',
  telefono: null,
  plan: ['CrossFit', 'Boxeo'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  created_at: '2025-01-01T00:00:00.000Z',
  ultimo_pago: '2026-08-01',
  creditos: 6, // pozo global legacy -- YA NO es lo que se muestra por disciplina
  activo: true,
}

const PROFILE_MULTI = {
  id: 'e2e-profile-multi',
  dni: SOCIO_MULTI.dni,
  full_name: 'Facundo Uria',
  avatar_url: null,
  created_at: '2025-01-01T00:00:00.000Z',
  role: 'socio',
}

// El mock E2E (supabaseMock.js) no resuelve joins de verdad -- una fila de
// user_credits necesita el `discipline: {...}` YA embebido a mano (mismo
// alias que pide el `.select('...discipline:disciplines(...)...')` real),
// si no fetchCreditosPorDisciplina no tiene de dónde sacar kind/name y
// descarta la fila entera.
function userCreditsIniciales() {
  return [
    {
      id: 'uc-1',
      user_id: PROFILE_MULTI.id,
      discipline_id: 'disc-crossfit',
      remaining_credits: 6,
      created_at: '2026-08-01T00:00:00.000Z',
      discipline: { id: 'disc-crossfit', name: 'CrossFit', kind: 'credits' },
    },
    {
      id: 'uc-2',
      user_id: PROFILE_MULTI.id,
      discipline_id: 'disc-boxeo',
      remaining_credits: 0,
      created_at: '2026-08-01T00:00:00.000Z',
      discipline: { id: 'disc-boxeo', name: 'Boxeo', kind: 'credits' },
    },
  ]
}

test('un socio con CrossFit + Boxeo muestra el balance REAL de cada disciplina, no el pozo global', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: {
      ...tablasBase(),
      disciplines: [...tablasBase().disciplines, DISCIPLINA_BOXEO],
      socios: [SOCIO_MULTI],
      profiles: [PROFILE_MULTI],
      user_credits: userCreditsIniciales(),
    },
  })

  await irASocios(page)
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Facundo Uria/ })
  await expect(filaTabla).toBeVisible()

  // Ya NO existe el selector oculto que definía a ciegas a cuál disciplina
  // viajaba el ajuste.
  await expect(filaTabla.getByLabel('Disciplina a ajustar')).toHaveCount(0)

  // El balance real de cada disciplina se ve por separado -- CrossFit=6,
  // Boxeo=0 (si mostrara el pozo global de socios.creditos, Boxeo también
  // mostraría 6, que es exactamente el bug reportado).
  await expect(filaTabla.getByTitle('Créditos reales de CrossFit en la app')).toHaveText('6')
  await expect(filaTabla.getByTitle('Créditos reales de Boxeo en la app')).toHaveText('0')
})

test('sumar créditos en la fila de Boxeo NUNCA impacta a CrossFit -- cada fila tiene su propio stepper', async ({ page }) => {
  // `tables` queda como referencia mutable (mockSupabase la muta in place)
  // -- se usa una variable propia en vez de un objeto inline para poder
  // inspeccionar directo qué terminó pasando en user_credits. UPSERT
  // estricto (ver creditosPwa.js): como Boxeo YA tiene una fila (uc-2), el
  // ajuste la ACTUALIZA en el lugar en vez de insertar una nueva -- por eso
  // acá se pollea el valor de esa fila puntual, no la longitud del array
  // (que con el UPSERT se queda igual).
  const tables = {
    ...tablasBase(),
    disciplines: [...tablasBase().disciplines, DISCIPLINA_BOXEO],
    socios: [SOCIO_MULTI],
    profiles: [PROFILE_MULTI],
    user_credits: userCreditsIniciales(),
  }
  await loginComoAdmin(page, { tables })

  await irASocios(page)
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Facundo Uria/ })

  await filaTabla.getByTitle('Asignar pack de 4 créditos a Boxeo').click()

  // Espera a que el UPDATE real llegue al mock (async: PATCH de
  // socios.creditos + sincronizarCreditosPwa) en vez de un timeout fijo.
  await expect.poll(() => tables.user_credits.find((f) => f.id === 'uc-2')?.remaining_credits).toBe(4)

  // Ningún insert nuevo -- sigue habiendo exactamente 2 filas (una por
  // disciplina), la de Boxeo se actualizó EN EL LUGAR.
  expect(tables.user_credits).toHaveLength(2)
  const filaBoxeo = tables.user_credits.find((f) => f.id === 'uc-2')
  expect(filaBoxeo.discipline_id).toBe('disc-boxeo') // NUNCA 'disc-crossfit' -- ese es exactamente el bug reportado
  expect(filaBoxeo.remaining_credits).toBe(4) // 0 (balance previo de Boxeo) + 4
  // La fila de CrossFit no se tocó.
  expect(tables.user_credits.find((f) => f.id === 'uc-1').remaining_credits).toBe(6)
})

// Caso real reportado: Aixa en Kickboxing. La migración inicial solo sembró
// filas de user_credits para CrossFit -- un socio que además tiene
// Kickboxing en su plan pero NUNCA tuvo créditos cargados ahí no tenía
// ninguna fila en user_credits para esa disciplina puntual. Antes, sumarle
// créditos rompía la sincronización con la app ("Crédito al plan
// actualizado pero no se pudo sincronizar Kickboxing con la app"). Ahora
// sincronizarCreditosPwa hace un UPSERT estricto: si no hay fila previa,
// inicializa una nueva en vez de fallar.
const DISCIPLINA_KICKBOXING = { id: 'disc-kickboxing', name: 'Kickboxing', kind: 'credits' }

const SOCIO_AIXA = {
  id: 'e2e-socio-aixa',
  nombre: 'Aixa',
  apellido: 'Gómez',
  dni: '40222333',
  email: 'aixa@e2e.test',
  telefono: null,
  plan: ['Kickboxing'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  created_at: '2025-06-01T00:00:00.000Z',
  ultimo_pago: '2026-08-01',
  creditos: 0,
  activo: true,
}

const PROFILE_AIXA = {
  id: 'e2e-profile-aixa',
  dni: SOCIO_AIXA.dni,
  full_name: 'Aixa Gómez',
  avatar_url: null,
  created_at: '2025-06-01T00:00:00.000Z',
  role: 'socio',
}

test('caso Aixa: sumar créditos en una disciplina que el socio NUNCA tuvo inicializada en la app crea la fila en vez de romper la sincronización', async ({
  page,
}) => {
  const tables = {
    ...tablasBase(),
    disciplines: [...tablasBase().disciplines, DISCIPLINA_KICKBOXING],
    socios: [SOCIO_AIXA],
    profiles: [PROFILE_AIXA],
    user_credits: [], // Ninguna fila todavía para Aixa -- ni siquiera de CrossFit.
  }
  await loginComoAdmin(page, { tables })

  await irASocios(page)
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Aixa Gómez/ })

  await filaTabla.getByTitle('Sumar 1 crédito a Kickboxing').click()

  // Antes de este fix, esto disparaba el toast de "no se pudo sincronizar"
  // -- ahora tiene que sincronizar bien y no mostrar ningún aviso de error.
  await expect.poll(() => tables.user_credits.length).toBe(1)

  const filaNueva = tables.user_credits[0]
  expect(filaNueva.discipline_id).toBe('disc-kickboxing')
  expect(filaNueva.remaining_credits).toBe(1)
  expect(filaNueva.user_id).toBe(PROFILE_AIXA.id)

  // Y el toast de "no se pudo sincronizar" NUNCA aparece.
  await expect(page.getByText(/no se pudo sincronizar Kickboxing con la app/)).toHaveCount(0)
})
