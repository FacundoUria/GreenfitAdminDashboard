// El Dashboard tiene un link "Ir a Socios" (widget de Cuotas por Vencer)
// que también matchea /socios/i -- exact:true para quedarse solo con el
// del Sidebar.
export async function irASocios(page) {
  await page.getByRole('link', { name: 'Socios', exact: true }).click()
}

export async function irADisciplinas(page) {
  await page.getByRole('link', { name: 'Disciplinas', exact: true }).click()
}

export async function irAClases(page) {
  await page.getByRole('link', { name: 'Clases', exact: true }).click()
}

export async function irARutinas(page) {
  await page.getByRole('link', { name: 'Rutinas', exact: true }).click()
}

export async function irAConfiguracion(page) {
  await page.getByRole('link', { name: 'Configuración', exact: true }).click()
}

export async function irAComunidad(page) {
  await page.getByRole('link', { name: 'Comunidad', exact: true }).click()
}
