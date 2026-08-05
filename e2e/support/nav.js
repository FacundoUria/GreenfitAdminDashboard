// El Dashboard tiene un link "Ir a Socios" (widget de Cuotas por Vencer)
// que también matchea /socios/i -- exact:true para quedarse solo con el
// del Sidebar.
export async function irASocios(page) {
  await page.getByRole('link', { name: 'Socios', exact: true }).click()
}
