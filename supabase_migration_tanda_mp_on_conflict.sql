-- =====================================================================================
-- TANDA MP -- mp_process_payment deja de fallar siempre.
-- Corrida en producción el 05/11/2026.
--
-- El bug (previo, lo destapó el caso (8) de prueba_tanda_b.sql):
--   mp_process_payment hace `on conflict (mercado_pago_payment_id) do nothing`, pero el
--   índice único idx_pagos_socio_mp_payment_id es PARCIAL (where mercado_pago_payment_id is
--   not null). Sin ese where, Postgres no puede usar el índice y TODA llamada falla con
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification":
--   Mercado Pago cobra, no se graba el pago ni se acreditan créditos, y el socio ve
--   "¡Pago acreditado!" (el texto sale de la URL de vuelta de MP, no de la base).
--   Hoy no afecta datos: producción tiene 0 pagos con mercado_pago_payment_id y MP está
--   desconectado de la PWA (HomeScreen, "Fase 4").
--
-- El cambio (UNA línea, el resto de la función queda idéntico, día de Argentina incluido):
--   on conflict (mercado_pago_payment_id) do nothing
--   ->
--   on conflict (mercado_pago_payment_id) where mercado_pago_payment_id is not null do nothing
-- Se toma la definición ACTUAL de producción (pg_get_functiondef) y se cambia SOLO ese
-- texto, como en Tanda B. Solo reemplaza una función: ningún UPDATE/DELETE/INSERT sobre
-- datos existentes. Respaldo en respaldo.tanda_mp_funciones (mismo esquema que Tanda B, no
-- expuesto por la API).
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) HUELLA EXACTA: la huella sin espacios de mp_process_payment es la de Tanda B
--      (respaldo.tanda_b_funciones.huella_nueva_sin_espacios). Si se hizo el rollback de
--      Tanda B, no hay respaldo y frena.
--   2) El índice idx_pagos_socio_mp_payment_id es EXACTAMENTE
--      CREATE UNIQUE INDEX ... ON public.pagos_socio USING btree (mercado_pago_payment_id)
--      WHERE (mercado_pago_payment_id IS NOT NULL)
--   3) El on conflict viejo aparece EXACTAMENTE 1 vez y el nuevo 0 veces.
--   4) Tanda MP no aplicada todavía (no existe respaldo.tanda_mp_funciones).
--   5) DESPUÉS: huella = la esperada; on conflict viejo 0 y nuevo 1; permisos (anon
--      incluido), security definer, volatilidad y config EXACTAMENTE iguales; 0 current_date.
--
-- Sin guarda de horario: no cambia ninguna fecha.
-- Prueba: prueba_tanda_mp.sql (DESPUÉS de esta migración). Con esto, prueba_tanda_b.sql
-- también tiene que dar 13 de 13.
-- Rollback: rollback_tanda_mp.sql.
--
-- PENDIENTE (R5), para cuando Seba reactive Mercado Pago -- NO está en esta tanda:
--   a) "¡Pago acreditado!" (PaymentResultCard) tiene que salir de la fila de pagos_socio,
--      no de la URL de vuelta de MP.
--   b) Aviso al Admin cuando mp-webhook devuelve 500 (hoy queda solo en los logs).
--   c) mp_process_payment frena si p_mp_payment_id llega null (hoy insertaría sin control
--      de duplicados, porque el índice parcial no cubre los null).
-- =====================================================================================

begin;

set local lock_timeout = '5s';

-- ── Guardas 1 a 4 ─────────────────────────────────────────────────────────────────────
do $guarda$
declare
  c_funcion constant text := 'public.mp_process_payment(uuid, uuid, jsonb, boolean, integer, uuid, numeric, text, text, text)';
  c_viejo constant text := 'on\s+conflict\s*\(\s*mercado_pago_payment_id\s*\)\s*do\s+nothing';
  c_nuevo constant text := 'on\s+conflict\s*\(\s*mercado_pago_payment_id\s*\)\s*where\s+mercado_pago_payment_id\s+is\s+not\s+null\s+do\s+nothing';
  v_def text;
  v_esperada text;
  v_n int;
begin
  if to_regprocedure(c_funcion) is null then
    raise exception 'Tanda MP: no existe %. No se aplicó nada.', c_funcion;
  end if;
  v_def := pg_get_functiondef(to_regprocedure(c_funcion));

  -- 1) Huella exacta de Tanda B.
  if to_regclass('respaldo.tanda_b_funciones') is null then
    raise exception 'Tanda MP: no existe respaldo.tanda_b_funciones (¿se hizo el rollback de Tanda B?). No se aplicó nada.';
  end if;
  select huella_nueva_sin_espacios into v_esperada
  from respaldo.tanda_b_funciones where to_regprocedure(funcion) = to_regprocedure(c_funcion);
  if v_esperada is null then
    raise exception 'Tanda MP: respaldo.tanda_b_funciones no tiene a mp_process_payment. No se aplicó nada.';
  end if;
  if md5(regexp_replace(v_def, '\s+', '', 'g')) <> v_esperada then
    raise exception 'Tanda MP: mp_process_payment no es la versión de Tanda B (huella %, esperada %). No se aplicó nada.',
      md5(regexp_replace(v_def, '\s+', '', 'g')), v_esperada;
  end if;

  -- 2) Índice parcial exacto.
  if coalesce((select pg_get_indexdef(i.indexrelid)
               from pg_index i
               where i.indexrelid = to_regclass('public.idx_pagos_socio_mp_payment_id')
                 and i.indrelid = 'public.pagos_socio'::regclass
                 and i.indisunique and i.indisvalid), '(no existe)')
     <> 'CREATE UNIQUE INDEX idx_pagos_socio_mp_payment_id ON public.pagos_socio USING btree (mercado_pago_payment_id) WHERE (mercado_pago_payment_id IS NOT NULL)' then
    raise exception 'Tanda MP: idx_pagos_socio_mp_payment_id no es el índice único parcial esperado: %. No se aplicó nada.',
      coalesce((select pg_get_indexdef(to_regclass('public.idx_pagos_socio_mp_payment_id'))), '(no existe)');
  end if;

  -- 3) Texto a cambiar: 1 vez el viejo, 0 el nuevo.
  select count(*) into v_n from regexp_matches(v_def, c_viejo, 'gi');
  if v_n <> 1 then
    raise exception 'Tanda MP: el on conflict viejo aparece % veces (esperado 1). No se aplicó nada.', v_n;
  end if;
  select count(*) into v_n from regexp_matches(v_def, c_nuevo, 'gi');
  if v_n <> 0 then
    raise exception 'Tanda MP: el on conflict nuevo ya aparece % veces. No se aplicó nada.', v_n;
  end if;

  -- 4) No aplicada.
  if to_regclass('respaldo.tanda_mp_funciones') is not null then
    raise exception 'Tanda MP: ya existe respaldo.tanda_mp_funciones (¿Tanda MP ya aplicada?). No se aplicó nada.';
  end if;
end;
$guarda$;

-- ── Respaldo ──────────────────────────────────────────────────────────────────────────
create table respaldo.tanda_mp_funciones (
  funcion                    text primary key,
  definicion_antes           text not null,
  huella_antes               text not null,
  huella_antes_sin_espacios  text not null,
  definicion_nueva           text not null,
  huella_nueva_sin_espacios  text not null,
  permisos                   text not null,
  security_definer           boolean not null,
  volatilidad                "char" not null,
  config                     text not null,
  guardado_en                timestamptz not null default now()
);
revoke all on respaldo.tanda_mp_funciones from public, anon, authenticated;

-- ── El cambio ─────────────────────────────────────────────────────────────────────────
do $aplicar$
declare
  r record;
  v_def text;
  v_nueva text;
begin
  select p.oid, p.oid::regprocedure::text as funcion, p.proacl, p.prosecdef, p.provolatile, p.proconfig into r
  from pg_proc p
  where p.oid = 'public.mp_process_payment(uuid, uuid, jsonb, boolean, integer, uuid, numeric, text, text, text)'::regprocedure;

  v_def := pg_get_functiondef(r.oid);
  v_nueva := regexp_replace(v_def,
                            'on\s+conflict\s*\(\s*mercado_pago_payment_id\s*\)\s*do\s+nothing',
                            'on conflict (mercado_pago_payment_id) where mercado_pago_payment_id is not null do nothing',
                            'i');

  insert into respaldo.tanda_mp_funciones
    (funcion, definicion_antes, huella_antes, huella_antes_sin_espacios, definicion_nueva, huella_nueva_sin_espacios,
     permisos, security_definer, volatilidad, config)
  values
    (r.funcion, v_def, md5(v_def), md5(regexp_replace(v_def, '\s+', '', 'g')), v_nueva, md5(regexp_replace(v_nueva, '\s+', '', 'g')),
     coalesce(r.proacl::text, '(por defecto)'), r.prosecdef, r.provolatile, coalesce(array_to_string(r.proconfig, ','), ''));

  execute v_nueva;
end;
$aplicar$;

-- ── Guarda 5: verificación DESPUÉS ────────────────────────────────────────────────────
do $verifica$
declare
  b record;
  p record;
  v_def text;
  v_n int;
begin
  select * into b from respaldo.tanda_mp_funciones;
  select * into p from pg_proc where oid = b.funcion::regprocedure;
  v_def := pg_get_functiondef(p.oid);

  if md5(regexp_replace(v_def, '\s+', '', 'g')) <> b.huella_nueva_sin_espacios then
    raise exception 'Tanda MP: mp_process_payment no quedó con la definición esperada. No se aplicó nada.';
  end if;
  select count(*) into v_n from regexp_matches(v_def, 'on\s+conflict\s*\(\s*mercado_pago_payment_id\s*\)\s*do\s+nothing', 'gi');
  if v_n <> 0 then
    raise exception 'Tanda MP: quedó el on conflict viejo (% veces). No se aplicó nada.', v_n;
  end if;
  select count(*) into v_n from regexp_matches(v_def, 'on\s+conflict\s*\(\s*mercado_pago_payment_id\s*\)\s*where\s+mercado_pago_payment_id\s+is\s+not\s+null\s+do\s+nothing', 'gi');
  if v_n <> 1 then
    raise exception 'Tanda MP: el on conflict nuevo aparece % veces (esperado 1). No se aplicó nada.', v_n;
  end if;
  if v_def ~* '\mcurrent_date\M' or v_def !~ 'America/Argentina/Mendoza' then
    raise exception 'Tanda MP: mp_process_payment perdió el día de Argentina de Tanda B. No se aplicó nada.';
  end if;
  if coalesce(p.proacl::text, '(por defecto)') <> b.permisos
     or p.prosecdef <> b.security_definer
     or p.provolatile <> b.volatilidad
     or coalesce(array_to_string(p.proconfig, ','), '') <> b.config then
    raise exception 'Tanda MP: cambiaron permisos o atributos: antes %, ahora %. No se aplicó nada.',
      b.permisos, coalesce(p.proacl::text, '(por defecto)');
  end if;

  raise notice 'Tanda MP aplicada. Huella exacta: antes % / después %. Sin espacios: antes % / después %.',
    b.huella_antes, md5(v_def), b.huella_antes_sin_espacios, b.huella_nueva_sin_espacios;
end;
$verifica$;

commit;
