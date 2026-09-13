import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { irASocios } from './support/nav.js'
import { DISCIPLINA_CROSSFIT } from './support/fixtures.js'

// Cubre el fix de "Socios Activos"/"Cuotas Vencidas" mostrando números
// DISTINTOS en Home y en Socios para el mismo padrón de socios -- ambas
// pantallas ahora llaman a la misma getSocioMetrics()/estadoOperativoSocio()
// (src/utils/socioMetrics.js), así que este test arma un padrón mixto a
// propósito (activo por fecha, vencido, sin fecha_vencimiento -- plan de
// créditos, con y sin créditos reales -- y dado de baja) y verifica que
// Home y Socios muestren EXACTAMENTE el mismo valor para cada tarjeta.
//
// CAMBIO 1 (sacar "En Tolerancia" del todo) -- ya no hay tarjeta
// "kpi-tolerancia" en ninguna de las dos pantallas: un socio que antes caía
// "en tolerancia" (vencido hace pocos días) ahora es directamente 'vencido'.
//
// CAMBIO 3 (bug real: "Activo" sin nada real) -- un socio de créditos SIN
// fecha_vencimiento (nunca tuvo Aparatos) solo cuenta como "Activo" si tiene
// al menos un crédito real vigente en user_credits -- se cubren los dos
// casos (con y sin créditos reales) en el mismo padrón.

function fechaOffset(dias) {
  const fecha = new Date()
  fecha.setDate(fecha.getDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

const SOCIOS_MIXTOS = [
  {
    id: 'socio-activo-fecha',
    nombre: 'Ana',
    apellido: 'Activa',
    dni: '10000001',
    email: 'ana@e2e.test',
    plan: ['Aparatos'],
    estado: 'Activo',
    fecha_vencimiento: fechaOffset(10), // vence en el futuro -> activo
    dia_corte: 10,
    creditos: 0,
    activo: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
  {
    // CAMBIO 1 -- ANTES "en tolerancia" (vencido hace 2 días, dentro de la
    // ventana de 5). Ahora, sin ninguna ventana de gracia, es 'vencido'
    // directo -- mismo bucket que Vicky.
    id: 'socio-vencido-reciente',
    nombre: 'Tomás',
    apellido: 'Vencido',
    dni: '10000002',
    email: 'tomas@e2e.test',
    plan: ['Aparatos'],
    estado: 'Vencido', // texto legacy A PROPÓSITO "equivocado" -- si algo
    // todavía leyera este campo en vez del cálculo real, este socio
    // aparecería mal categorizado y el test lo detectaría.
    fecha_vencimiento: fechaOffset(-2), // vencido hace 2 días
    dia_corte: 10,
    creditos: 0,
    activo: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'socio-vencido',
    nombre: 'Vicky',
    apellido: 'Vencida',
    dni: '10000003',
    email: 'vicky@e2e.test',
    plan: ['Aparatos'],
    estado: 'Activo', // texto legacy también "equivocado" a propósito.
    fecha_vencimiento: fechaOffset(-20), // vencido hace 20 días
    dia_corte: 10,
    creditos: 0,
    activo: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
  {
    // CAMBIO 3 -- plan de créditos, SIN fecha_vencimiento, CON un crédito
    // real vigente en user_credits (ver `profiles`/`user_credits` abajo) --
    // cuenta como "Activo".
    id: 'socio-creditos-reales',
    nombre: 'Cristian',
    apellido: 'Créditos',
    dni: '10000004',
    email: 'cristian@e2e.test',
    plan: ['CrossFit'],
    estado: 'Vencido', // texto legacy que, sin el fix, lo mandaba a "vencido".
    fecha_vencimiento: null,
    dia_corte: null,
    creditos: 8,
    activo: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
  {
    // CAMBIO 3 -- mismo caso, pero SIN ningún crédito real vigente (gastó
    // todo) -- bug real del ticket: antes esto contaba como "Activo" igual,
    // solo por no tener fecha_vencimiento. Ahora cuenta como "Inactivo".
    id: 'socio-creditos-agotados',
    nombre: 'Noelia',
    apellido: 'SinCreditos',
    dni: '10000006',
    email: 'noelia@e2e.test',
    plan: ['CrossFit'],
    estado: 'Activo', // texto legacy también "equivocado" a propósito.
    fecha_vencimiento: null,
    dia_corte: null,
    creditos: 0,
    activo: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'socio-de-baja',
    nombre: 'Bruno',
    apellido: 'Baja',
    dni: '10000005',
    email: 'bruno@e2e.test',
    plan: ['Aparatos'],
    estado: 'Activo',
    fecha_vencimiento: fechaOffset(10),
    dia_corte: 10,
    creditos: 0,
    activo: false, // dado de baja -- no debe contar en ningún bucket de arriba.
    created_at: '2024-01-01T00:00:00.000Z',
  },
]

// Por testId (kpi-activos/kpi-vencidos), no por texto de la etiqueta --
// "Cuotas Vencidas" (Home) vs "Cuota Vencida" (Socios) tienen distinto texto
// para el mismo concepto.
function localizadorKpi(page, testId) {
  return page.getByTestId(testId).locator('p.text-2xl')
}

// CAMBIO 3 -- Home/Socios ahora esperan un fetch ADICIONAL (créditos reales
// por disciplina, fetchCreditosPorDisciplina) antes de que el número final
// quede pintado -- un `.innerText()` de una sola lectura corre el riesgo de
// leer el valor transitorio de ANTES de que ese fetch resuelva. `toHaveText`
// reintenta sola hasta que el DOM matchea, así que hace falta el valor
// esperado de antemano (no solo leer "lo que haya" en este instante).
async function esperarKpi(page, testId, valorEsperado) {
  await expect(localizadorKpi(page, testId)).toHaveText(String(valorEsperado), { timeout: 10_000 })
}

test('Home y Socios muestran EXACTAMENTE los mismos números de Activos/Vencidos, y ya no hay tarjeta de Tolerancia', async ({
  page,
}) => {
  await loginComoAdmin(page, {
    tables: {
      socios: SOCIOS_MIXTOS,
      // Cristian SÍ tiene cuenta PWA con un crédito real vigente de
      // CrossFit -- Noelia también tiene cuenta, pero sin ningún crédito
      // real (todo en 0), para cubrir el caso "Activo sin nada real".
      profiles: [
        { id: 'profile-cristian', dni: '10000004', full_name: 'Cristian Créditos' },
        { id: 'profile-noelia', dni: '10000006', full_name: 'Noelia SinCreditos' },
      ],
      // `discipline: {...}` embebido a mano -- el mock (supabaseMock.js) no
      // resuelve joins reales, mismo criterio que ya usa
      // creditos-por-disciplina.spec.js para esta misma tabla.
      user_credits: [
        {
          id: 'uc-cristian-crossfit',
          user_id: 'profile-cristian',
          discipline_id: DISCIPLINA_CROSSFIT.id,
          remaining_credits: 8,
          expires_at: `${fechaOffset(20)}T12:00:00.000Z`,
          discipline: DISCIPLINA_CROSSFIT,
        },
        {
          id: 'uc-noelia-crossfit',
          user_id: 'profile-noelia',
          discipline_id: DISCIPLINA_CROSSFIT.id,
          remaining_credits: 0,
          expires_at: `${fechaOffset(-30)}T12:00:00.000Z`,
          discipline: DISCIPLINA_CROSSFIT,
        },
      ],
      xp_events: [],
      disciplines: [DISCIPLINA_CROSSFIT],
      configuracion: [{ id: 1, dias_tolerancia: 5, limite_cancelacion_minutos: 120, alias_cvu: null, titular_cuenta: null }],
      bookings: [],
      classes: [],
      routines: [],
      pagos_socio: [],
    },
  })

  // Home es la pantalla de aterrizaje tras el login. Valores esperados por
  // el padrón armado arriba, con el criterio ÚNICO ya fijado en
  // socioMetrics.js (no el legacy `estado` de cada fixture). `esperarKpi`
  // ya deja afirmado (con reintento incluido) el valor final -- no hace
  // falta un `.innerText()` extra después para "confirmar" lo mismo, ese
  // segundo read corre detrás de más re-renders (cada fetch en vuelo --
  // gamificación, créditos -- dispara los suyos) y puede leer un estado
  // intermedio en vez del final ya afirmado.
  const homeActivos = 2 // Ana (fecha futura) + Cristian (crédito real vigente)
  const homeVencidas = 2 // Tomás (CAMBIO 1 -- ya no "tolerancia") + Vicky
  await esperarKpi(page, 'kpi-activos', homeActivos)
  await esperarKpi(page, 'kpi-vencidos', homeVencidas)
  // CAMBIO 1 -- la tarjeta de Tolerancia ya no existe en ninguna pantalla.
  await expect(page.getByTestId('kpi-tolerancia')).toHaveCount(0)

  await irASocios(page)
  // Las tarjetas de KPI de Socios.jsx se renderizan ANTES de que termine
  // NINGÚN fetch (arrancan en 0 mientras `loading` es true) -- esperar a que
  // la tabla muestre a Ana (activa por FECHA) NO alcanza acá: Cristian
  // depende de un fetch aparte (fetchCreditosPorDisciplina, CAMBIO 3), que
  // puede resolver en un tick posterior al que ya pintó a Ana. `esperarKpi`
  // reintenta sola hasta que el número final (créditos incluidos) está --
  // mismo valor literal que Home, la garantía real es que ACÁ TAMBIÉN se
  // llega a ese mismo 2 (no solo que "matchea lo que Home leyó").
  await esperarKpi(page, 'kpi-activos', homeActivos)
  await expect(page.getByTestId('kpi-tolerancia')).toHaveCount(0)
  // Ticket de simplificación de tarjetas -- Socios.jsx ya no tiene tarjeta
  // de "Cuota Vencida" (solo quedan "Socios Activos" y "Nuevos del Mes");
  // ese número sigue viviendo en Home ("Cuotas Vencidas", ya afirmado
  // arriba) y en el conteo interno de getSocioMetrics (counts.vencido, lo
  // sigue necesitando el filtro "Inactivo" de más abajo).
  await expect(page.getByTestId('kpi-vencidos')).toHaveCount(0)

  // CAMBIO 2 -- el desplegable de filtro ya no ofrece "Cuota Vencida" ni
  // "Inactivos (dados de baja)" por separado, solo "Inactivo" (unificado).
  const opciones = await page.locator('select').first().locator('option').allTextContents()
  expect(opciones).toContain('Inactivo')
  expect(opciones).not.toContain('Cuota Vencida')
  expect(opciones).not.toContain('En Tolerancia')
  expect(opciones).not.toContain('Inactivos (dados de baja)')

  // CAMBIO 2 -- filtrando por "Inactivo" aparecen TANTO los vencidos
  // (Tomás, Vicky, Noelia) COMO el dado de baja (Bruno) -- todos con el
  // MISMO badge, sin distinguir la razón.
  await page.locator('select').first().selectOption('inactivo')
  const tabla = page.getByRole('table')
  await expect(tabla.getByText('Tomás Vencido')).toBeVisible()
  await expect(tabla.getByText('Vicky Vencida')).toBeVisible()
  await expect(tabla.getByText('Noelia SinCreditos')).toBeVisible()
  await expect(tabla.getByText('Bruno Baja')).toBeVisible()
  await expect(tabla.getByText('Ana Activa')).toHaveCount(0)
  await expect(tabla.getByText('Cristian Créditos')).toHaveCount(0)

  const badgesInactivo = await tabla.getByText('Inactivo').all()
  expect(badgesInactivo.length).toBe(4)
  const clases = await Promise.all(badgesInactivo.map((el) => el.getAttribute('class')))
  expect(new Set(clases).size).toBe(1) // un solo estilo visual, sin distinguir la razón
})
