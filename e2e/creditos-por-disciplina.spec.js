import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT } from './support/fixtures.js'
import { irASocios } from './support/nav.js'
import { mockAdminFijarCreditosDisciplina } from './support/rpcMocks.js'

// BUG CRÍTICO DE SINCRONIZACIÓN (2026-08-07): un socio con más de una
// disciplina de créditos (ej. CrossFit + Boxeo) mostraba en la tabla de
// Socios un solo número GLOBAL (`socios.creditos`, la suma de las dos) con
// un <select> oculto para elegir a cuál disciplina viajaba el ajuste hacia
// la app -- fácil de dejar en la disciplina equivocada sin darse cuenta, y
// el panel no mostraba en ningún lado el balance REAL que ya tenía la PWA
// por disciplina. Fix: una fila por disciplina en la celda de Créditos,
// mostrando el balance real de `user_credits` (no el pozo global) -- nunca
// ambiguo sobre a cuál disciplina corresponde cada número.
//
// Rediseño posterior (sacar los steppers de la tabla): esa celda pasó a
// ser de SOLO LECTURA -- el ajuste +1/-1 por disciplina, que antes vivía
// ahí mismo, ahora vive en "Editar Socio" (CreditosEditablesSocio.jsx). El
// test de abajo que verifica la celda de la tabla sigue intacto; los que
// ejercitan el ajuste abren el modal primero.

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
// expires_at futuro en las dos filas -- créditos por lotes (ver
// supabase_migration_lotes_creditos_fase1/2.sql): fetchCreditosPorDisciplina
// solo suma lotes ACTIVOS (remaining_credits>0 Y expires_at>ahora), mismo
// criterio que fetchUserBalances() del lado de la PWA. En producción real
// esto siempre está poblado (sincronizarCreditosPwa lo setea en cada
// escritura) -- acá se declara explícito para que el fixture represente un
// lote real, no uno inválido/legacy.
//
// Boxeo arranca en 2 (no 0): desde el fix de "plan único", tanto
// CreditosCell (SociosTabla.jsx) como CreditosEditablesSocio.jsx solo
// muestran disciplinas con al menos un lote ACTIVO real -- con 0, Boxeo
// directamente no aparecería en ningún lado y no habría nada que ajustar
// ni ninguna fila que leer. Se usa 2 (distinto de los 6 de CrossFit) para
// seguir pudiendo distinguir "balance real por disciplina" de "pozo
// global" (ver el test de abajo).
const EN_30_DIAS = new Date(Date.now() + 30 * 86_400_000).toISOString()

function userCreditsIniciales() {
  return [
    {
      id: 'uc-1',
      user_id: PROFILE_MULTI.id,
      discipline_id: 'disc-crossfit',
      remaining_credits: 6,
      expires_at: EN_30_DIAS,
      created_at: '2026-08-01T00:00:00.000Z',
      discipline: { id: 'disc-crossfit', name: 'CrossFit', kind: 'credits' },
    },
    {
      id: 'uc-2',
      user_id: PROFILE_MULTI.id,
      discipline_id: 'disc-boxeo',
      remaining_credits: 2,
      expires_at: EN_30_DIAS,
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
  // Boxeo=2 (si mostrara el pozo global de socios.creditos, Boxeo también
  // mostraría 6, que es exactamente el bug reportado).
  await expect(filaTabla.getByTitle('Créditos reales de CrossFit en la app')).toHaveText('6')
  await expect(filaTabla.getByTitle('Créditos reales de Boxeo en la app')).toHaveText('2')
})

// Simula server-side lo mínimo indispensable de
// admin_ajustar_credito_disciplina() (ver supabase_migration_editar_
// creditos_disciplina.sql) -- fusiona con un lote ACTIVO existente
// (remaining_credits>0) de la misma disciplina si hay uno, si no crea uno
// nuevo. No reimplementa el chequeo de "mismo día calendario Argentina"
// de la fusión real (ese matiz está cubierto por las verificaciones
// manuales comentadas en la migración) -- alcanza con esto para probar que
// la UI llama al RPC con los parámetros correctos y refleja el resultado.
function rpcAjustarCredito(tables) {
  return (request) => {
    const { p_user_id: userId, p_discipline_id: disciplineId, p_delta: delta } = request.postDataJSON()
    if (delta > 0) {
      const activo = tables.user_credits.find(
        (f) => f.user_id === userId && f.discipline_id === disciplineId && (f.remaining_credits ?? 0) > 0,
      )
      if (activo) {
        activo.remaining_credits += delta
      } else {
        tables.user_credits.push({
          id: `uc-e2e-${tables.user_credits.length + 1}`,
          user_id: userId,
          discipline_id: disciplineId,
          remaining_credits: delta,
          expires_at: EN_30_DIAS,
          created_at: new Date().toISOString(),
          discipline: tables.disciplines.find((d) => d.id === disciplineId),
        })
      }
    } else if (delta < 0) {
      let restante = Math.abs(delta)
      const activos = tables.user_credits
        .filter((f) => f.user_id === userId && f.discipline_id === disciplineId && (f.remaining_credits ?? 0) > 0)
        .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at))
      for (const fila of activos) {
        if (restante <= 0) break
        const descuento = Math.min(fila.remaining_credits, restante)
        fila.remaining_credits -= descuento
        restante -= descuento
      }
    }
    return null
  }
}

// Rediseño (sacar los steppers de la tabla): el ajuste rápido +1/-1 ahora
// vive en "Editar Socio" -> sección Créditos (CreditosEditablesSocio.jsx),
// no en la fila de la tabla -- mismo título de botón de siempre
// ("Sumar 1 crédito a Boxeo"), solo cambia DÓNDE vive.
//
// FIX de "plan único" (ver CreditosEditablesSocio.jsx): esa sección ya no
// lee socio.plan -- solo muestra disciplinas con al menos un lote ACTIVO
// real. userCreditsIniciales() ya le da a Boxeo un balance inicial > 0
// (ver el comentario junto a esa función): sin ningún lote activo, el
// botón "Sumar 1 crédito a Boxeo" directamente no existiría.
test('sumar créditos en la fila de Boxeo NUNCA impacta a CrossFit -- cada disciplina tiene su propio +1/-1', async ({ page }) => {
  const tables = {
    ...tablasBase(),
    disciplines: [...tablasBase().disciplines, DISCIPLINA_BOXEO],
    socios: [SOCIO_MULTI],
    profiles: [PROFILE_MULTI],
    user_credits: userCreditsIniciales(),
  }
  await loginComoAdmin(page, { tables, rpc: { admin_ajustar_credito_disciplina: rpcAjustarCredito(tables) } })

  await irASocios(page)
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Facundo Uria/ })
  await filaTabla.getByTitle('Editar').click()
  await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

  await page.getByTitle('Sumar 1 crédito a Boxeo').click()

  // Boxeo (balance previo real: 2) suma a 3 -- CrossFit no se toca.
  await expect.poll(() =>
    tables.user_credits
      .filter((f) => f.user_id === PROFILE_MULTI.id && f.discipline_id === 'disc-boxeo')
      .reduce((total, f) => total + (f.remaining_credits ?? 0), 0),
  ).toBe(3)
  expect(tables.user_credits.find((f) => f.id === 'uc-1').remaining_credits).toBe(6) // CrossFit intacto
})

// Caso real reportado: Aixa en Kickstrike. La migración inicial solo sembró
// filas de user_credits para CrossFit -- un socio que además tiene
// Kickstrike en su plan pero NUNCA tuvo créditos cargados ahí no tenía
// ninguna fila en user_credits para esa disciplina puntual. Antes, sumarle
// créditos rompía la sincronización con la app ("Crédito al plan
// actualizado pero no se pudo sincronizar Kickstrike con la app"). Ahora
// sincronizarCreditosPwa hace un UPSERT estricto: si no hay fila previa,
// inicializa una nueva en vez de fallar.
const DISCIPLINA_KICKSTRIKE = { id: 'disc-kickstrike', name: 'Kickstrike', kind: 'credits' }

const SOCIO_AIXA = {
  id: 'e2e-socio-aixa',
  nombre: 'Aixa',
  apellido: 'Gómez',
  dni: '40222333',
  email: 'aixa@e2e.test',
  telefono: null,
  plan: ['Kickstrike'],
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

// FIX de "plan único" (ver CreditosEditablesSocio.jsx): esa sección ya no
// lee socio.plan para decidir qué mostrar -- SOLO disciplinas con al menos
// un lote activo real. Consecuencia directa e inevitable: ya no se puede
// inicializar desde acá el crédito de una disciplina que el socio nunca
// tuvo (sin fila en user_credits, no hay ninguna fila que mostrar, así que
// no hay ningún botón que clickear). Para eso sigue estando "Registrar
// Pago" (acreditar_pack), que sí crea el lote inicial -- este test ahora
// verifica que la sección de Créditos directamente no aparece en ese caso,
// en vez de mostrar un botón que ya no existe.
test('caso Aixa: una disciplina que el socio NUNCA tuvo inicializada en la app no aparece en "Editar Socio" -- solo queda "+ Agregar Aparatos" disponible (CAMBIO 5)', async ({
  page,
}) => {
  const tables = {
    ...tablasBase(),
    disciplines: [...tablasBase().disciplines, DISCIPLINA_KICKSTRIKE],
    socios: [SOCIO_AIXA],
    profiles: [PROFILE_AIXA],
    user_credits: [], // Ninguna fila todavía para Aixa -- ni siquiera de CrossFit.
  }
  await loginComoAdmin(page, { tables })

  await irASocios(page)
  // CAMBIO 3 (bug real: "Activo" sin nada real) -- Aixa no tiene ni un
  // crédito real ni fecha_vencimiento, así que ahora cuenta como "Inactivo"
  // (antes, sin este fix, el default optimista la mostraba "Activa" igual)
  // -- el filtro por defecto de la pantalla ('Activo') ya no la incluye.
  await page.locator('select').first().selectOption('todos')
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Aixa Gómez/ })
  await filaTabla.getByTitle('Editar').click()
  await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

  // CAMBIO 5 -- a diferencia de antes (sin "+ Agregar Aparatos" todavía),
  // la sección de Créditos SÍ aparece ahora: Aixa tiene cuenta PWA (userId
  // real) y Aparatos no está vigente, así que el único botón disponible es
  // "+ Agregar Aparatos" -- ni una fila de crédito real (sigue sin ninguna),
  // ni "+ Agregar disciplina" (el catálogo de este test no tiene ninguna
  // disciplina con is_active=true).
  await expect(page.getByRole('heading', { name: 'Créditos', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Agregar Aparatos' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Agregar disciplina' })).toHaveCount(0)
  expect(tables.user_credits).toHaveLength(0)
})

// CAMBIO 2 -- "+ Agregar disciplina" (CreditosEditablesSocio.jsx): antes
// solo se podían AJUSTAR disciplinas que ya tenían algún lote activo --
// para dar de alta una nueva sin pasar por "Registrar Pago" no había
// forma. `disciplinasActivas` necesita is_active=true explícito en el
// fixture -- Socios.jsx filtra por esa columna al armar el combo.
test('CAMBIO 2 -- agregar una disciplina nueva a un socio que ya tiene otra activa -- las dos terminan con la MISMA fecha', async ({
  page,
}) => {
  const tables = {
    ...tablasBase(),
    disciplines: [
      { ...DISCIPLINA_CROSSFIT, is_active: true },
      { ...DISCIPLINA_BOXEO, is_active: true },
    ],
    socios: [SOCIO_MULTI],
    profiles: [PROFILE_MULTI],
    user_credits: [
      {
        id: 'uc-1',
        user_id: PROFILE_MULTI.id,
        discipline_id: 'disc-crossfit',
        remaining_credits: 6,
        expires_at: EN_30_DIAS,
        created_at: '2026-08-01T00:00:00.000Z',
        discipline: DISCIPLINA_CROSSFIT,
      },
    ],
  }
  await loginComoAdmin(page, { tables, rpc: { admin_fijar_creditos_disciplina: mockAdminFijarCreditosDisciplina(tables) } })

  await irASocios(page)
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Facundo Uria/ })
  await filaTabla.getByTitle('Editar').click()
  await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

  await page.getByRole('button', { name: /Agregar disciplina/ }).click()

  // El selector NO ofrece CrossFit (ya activo, tiene su propio "Fijar en" arriba) -- solo Boxeo.
  const opciones = await page.getByLabel('Disciplina a agregar').locator('option').allTextContents()
  expect(opciones).toContain('Boxeo')
  expect(opciones).not.toContain('CrossFit')

  await page.getByLabel('Disciplina a agregar').selectOption('disc-boxeo')
  await page.getByLabel('Créditos a agregar').fill('4')
  await page.getByRole('button', { name: 'Agregar', exact: true }).click()

  await expect.poll(() => tables.user_credits.some((f) => f.discipline_id === 'disc-boxeo')).toBe(true)

  const filaCrossfit = tables.user_credits.find((f) => f.discipline_id === 'disc-crossfit')
  const filaBoxeo = tables.user_credits.find((f) => f.discipline_id === 'disc-boxeo')
  expect(filaBoxeo.remaining_credits).toBe(4)
  // La garantía real: admin_fijar_creditos_disciplina() resuelve sola la
  // fecha del plan vigente -- Boxeo queda con EXACTAMENTE la misma fecha
  // que CrossFit, sin que el frontend calcule ni pase nada.
  expect(filaBoxeo.expires_at).toBe(filaCrossfit.expires_at)
})

test('CAMBIO 2 -- socio sin nada activo agrega su primera disciplina -- fecha nueva (hoy + 30 días)', async ({ page }) => {
  const tables = {
    ...tablasBase(),
    disciplines: [{ ...DISCIPLINA_CROSSFIT, is_active: true }, { ...DISCIPLINA_KICKSTRIKE, is_active: true }],
    socios: [SOCIO_AIXA],
    profiles: [PROFILE_AIXA],
    user_credits: [], // Nada activo todavía -- ni siquiera de Kickstrike (su plan de siempre).
  }
  await loginComoAdmin(page, { tables, rpc: { admin_fijar_creditos_disciplina: mockAdminFijarCreditosDisciplina(tables) } })

  await irASocios(page)
  // CAMBIO 3 -- mismo motivo que el test de arriba: sin nada real todavía,
  // Aixa cuenta como "Inactivo" -- el filtro por defecto ('Activo') no la
  // incluye.
  await page.locator('select').first().selectOption('todos')
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Aixa Gómez/ })
  await filaTabla.getByTitle('Editar').click()
  await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

  await page.getByRole('button', { name: /Agregar disciplina/ }).click()
  await page.getByLabel('Disciplina a agregar').selectOption('disc-kickstrike')
  await page.getByLabel('Créditos a agregar').fill('10')
  await page.getByRole('button', { name: 'Agregar', exact: true }).click()

  await expect.poll(() => tables.user_credits.length).toBe(1)
  const fila = tables.user_credits[0]
  expect(fila.discipline_id).toBe('disc-kickstrike')
  expect(fila.remaining_credits).toBe(10)

  const hoy = new Date()
  const esperado = new Date(hoy)
  esperado.setUTCDate(esperado.getUTCDate() + 30)
  expect(fila.expires_at.slice(0, 10)).toBe(esperado.toISOString().slice(0, 10))
})
