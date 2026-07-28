export const PLANES_DE_CREDITOS = ['crossfit', 'boxeo', 'kickstrike']

export function esPlanDeCreditos(plan) {
  return PLANES_DE_CREDITOS.includes((plan ?? '').toLowerCase())
}
