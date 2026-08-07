import { useEffect, useState } from 'react'
import { Loader2, Package, Pencil, Plus, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import PackModal from './PackModal'

function formatMonto(monto) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(monto ?? 0)
}

// "8 créditos CrossFit + 8 créditos Boxeo" / "Aparatos + 12 créditos
// CrossFit" / "Aparatos Pase Libre" -- MISMO criterio (y misma salida) que
// buildPackSubtitle() en greenfit-app/src/lib/creditsApi.ts, para que lo
// que ve Seba acá sea idéntico a lo que ve el socio en "Elegí tu pack".
// Recibe `creditosConNombre` (ya cruzado con disciplinas) por separado --
// `pack.creditos` en sí queda SIN TOCAR (shape crudo de la base,
// discipline_id) porque es lo que PackModal necesita para precargar sus
// filas al editar.
function buildPackSubtitle(pack, creditosConNombre) {
  const partesCreditos = creditosConNombre.map((c) => `${c.credits} créditos ${c.disciplinaNombre}`)
  if (pack.incluye_aparatos && partesCreditos.length === 0) return 'Aparatos Pase Libre'
  if (pack.incluye_aparatos) return ['Aparatos', ...partesCreditos].join(' + ')
  return partesCreditos.join(' + ')
}

function creditosConNombrePara(pack, disciplinasPorId) {
  const creditosRaw = Array.isArray(pack.creditos) ? pack.creditos : []
  return creditosRaw
    .map((c) => {
      const disciplina = disciplinasPorId.get(c.discipline_id)
      return disciplina ? { disciplinaNombre: disciplina.name, credits: c.credits } : null
    })
    .filter(Boolean)
}

// Gestión completa de `packs` -- la MISMA tabla que "Elegí tu pack" lee en
// tiempo real en la PWA (fetchPacks() en creditsApi.ts) y que la Edge
// Function create-payment-preference usa para resolver el precio real de
// Mercado Pago. Un pack ya no es "1 disciplina <-> 1 pack": puede ser un
// combo real de N disciplinas (creditos, jsonb) + opcionalmente Aparatos
// (incluye_aparatos + dias_vigencia configurable). Si Seba crea un pack
// nuevo acá, aparece solo en la app -- no hay ningún paso intermedio ni
// redeploy de nada.
//
// Autocontenida (mismo criterio que DiasCerradosCard.jsx): fetch/estado/
// CRUD propios, vive como una tarjeta más en la grilla de Configuración.
function PlanesPacksCard() {
  const [packs, setPacks] = useState([])
  const [disciplinas, setDisciplinas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [modalAbierto, setModalAbierto] = useState(false)
  const [packEnEdicion, setPackEnEdicion] = useState(null)

  // Dos queries separadas + merge acá en vez de un embed -- `creditos`
  // (jsonb) solo guarda discipline_id, no el nombre, así que hace falta
  // cruzar contra `disciplines` para armar el subtítulo. Además, un pack
  // recién creado/editado no tiene por qué esperar a ningún timing de
  // resolución de join, esto siempre refleja la disciplina real apenas
  // fetchDatos() vuelve a correr.
  const fetchDatos = async () => {
    setCargando(true)
    const [{ data: packsData, error: packsError }, { data: disciplinasData, error: discError }] = await Promise.all([
      supabase
        .from('packs')
        .select('id, name, price, is_active, incluye_aparatos, dias_vigencia, creditos')
        .order('name'),
      supabase.from('disciplines').select('id, name, kind').order('name'),
    ])

    if (packsError) console.error('Error al cargar packs desde Supabase:', packsError.message)
    if (discError) console.error('Error al cargar disciplinas desde Supabase:', discError.message)

    setPacks(packsData ?? [])
    setDisciplinas(disciplinasData ?? [])
    setCargando(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchDatos()
  }, [])

  const handleAbrirNuevo = () => {
    setPackEnEdicion(null)
    setModalAbierto(true)
  }

  const handleEditar = (pack) => {
    setPackEnEdicion(pack)
    setModalAbierto(true)
  }

  const handleEliminar = async (pack) => {
    if (!window.confirm(`¿Eliminar el pack "${pack.name}"? Esta acción no se puede deshacer.`)) return

    const { error } = await supabase.from('packs').delete().eq('id', pack.id)
    if (error) {
      // 23503 = foreign key violation -- ya hay socios con créditos/pagos
      // asociados a este pack (user_credits.pack_id lo referencia), borrarlo
      // rompería ese historial. Desactivarlo es la única opción segura.
      const mensaje = error.code === '23503'
        ? `"${pack.name}" ya tiene socios con créditos cargados de este pack y no se puede eliminar sin romper el historial. Desactivalo en su lugar (Editar > Activo).`
        : 'No se pudo eliminar el pack. Intentá nuevamente.'
      console.error('Error al eliminar el pack:', error.message)
      window.alert(mensaje)
      return
    }
    fetchDatos()
  }

  return (
    <div className="rounded-xl border border-white/5 bg-greenfit-card p-5 lg:col-span-2">
      <div className="mb-4 flex items-center justify-between border-b border-white/5 pb-3">
        <h3 className="text-base font-semibold text-white">📦 Planes, Packs y Combos (Mercado Pago)</h3>
        <button
          type="button"
          onClick={handleAbrirNuevo}
          className="flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-greenfit-primary px-3 py-2 text-xs font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" />
          Nuevo Pack
        </button>
      </div>

      <p className="-mt-1 mb-4 text-xs text-gray-500">
        Cada pack de acá es lo que ve el socio en "Elegí tu pack" de la app -- nombre, disciplinas con sus
        créditos (o Aparatos con sus días de vigencia, para combos y pases libres) y precio. El precio que
        cobra Mercado Pago sale siempre de acá, nunca se puede alterar desde la app.
      </p>

      {cargando ? (
        <div className="flex items-center gap-2 py-6 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Cargando...
        </div>
      ) : packs.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-gray-400">
          <Package className="h-6 w-6 text-gray-600" />
          Todavía no hay ningún pack cargado.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {packs.map((pack) => {
            const disciplinasPorId = new Map(disciplinas.map((d) => [d.id, d]))
            const creditosConNombre = creditosConNombrePara(pack, disciplinasPorId)
            return (
            <li
              key={pack.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-greenfit-dark px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-white">{pack.name}</p>
                  {!pack.is_active && (
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-gray-400">
                      Inactivo
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400">{buildPackSubtitle(pack, creditosConNombre)}</p>
              </div>
              <span className="text-sm font-semibold text-greenfit-primary">{formatMonto(pack.price)}</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleEditar(pack)}
                  aria-label={`Editar ${pack.name}`}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleEliminar(pack)}
                  aria-label={`Eliminar ${pack.name}`}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
            )
          })}
        </ul>
      )}

      {modalAbierto && (
        <PackModal
          key={packEnEdicion?.id ?? 'nuevo'}
          pack={packEnEdicion}
          disciplinas={disciplinas}
          onClose={() => {
            setModalAbierto(false)
            setPackEnEdicion(null)
          }}
          onSaved={fetchDatos}
        />
      )}
    </div>
  )
}

export default PlanesPacksCard
