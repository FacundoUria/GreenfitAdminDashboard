-- Ejecutar en el SQL Editor de Supabase (Project > SQL Editor)
--
-- ============================================================
-- CONTEXTO REAL DEL BUG (auditado antes de escribir este parche)
-- ============================================================
-- La causa real no es "una migración que falló" en el sentido de una
-- sentencia SQL rota -- es que scripts/importar_socios.js (el import
-- masivo original de Crossfy, upsert por DNI o por email cuando no había
-- DNI) solo escribe en la tabla `socios`. NUNCA tocó `user_credits` (la
-- tabla real que lee la PWA). Para socios CON DNI esto se fue tapando solo
-- con el tiempo (cualquier ajuste de créditos desde el panel dispara
-- sincronizarCreditosPwa, que resuelve la cuenta PWA por DNI) -- pero
-- resolverUserId() dependía EXCLUSIVAMENTE del DNI, así que los ~750
-- socios importados sin ese dato (identificables solo por email en el CSV
-- de Crossfy) nunca tuvieron ninguna vía real para sincronizarse, sin
-- importar cuántas veces se les tocara el botón de crédito. Ya se corrigió
-- hacia adelante (ver src/utils/creditosPwa.js: resolverUserId() ahora
-- también intenta por email como respaldo) -- este parche es el barrido
-- ÚNICO para los socios que ya quedaron atrás antes de ese fix.
--
-- ============================================================
-- QUÉ HACE
-- ============================================================
-- Para cada socio ACTIVO sin DNI cargado, busca su cuenta PWA por email
-- (profiles.email = socios.email, case-insensitive) y le inicializa una
-- fila de user_credits por cada disciplina de CRÉDITOS que tenga en su
-- `plan` (CrossFit/Boxeo/Kickboxing -- las de vencimiento, Aparatos/Pase
-- Libre, quedan fuera de este parche, que es específico del bug de los
-- botones +/-/+4 de crédito), con remaining_credits = socios.creditos
-- (mismo pozo global que ya usa el panel, mismo criterio "se pierde el
-- desglose por disciplina, costo aceptado" que sincronizacion_crossfy_v2.sql).
--
-- NO inserta filas nuevas en `socios` ni en `profiles` -- si no hay una
-- cuenta PWA con ese email, ese socio simplemente no matchea (0 filas), no
-- es un error. Tampoco duplica: si ya existe una fila de user_credits para
-- esa (usuario, disciplina), la salta.
-- ============================================================

DO $$
DECLARE
  v_socio RECORD;
  v_user_id uuid;
  v_disciplina RECORD;
  v_socios_matcheados int := 0;
  v_filas_creadas int := 0;
BEGIN
  FOR v_socio IN
    SELECT s.id, s.dni, s.email, s.creditos, s.plan
    FROM socios s
    WHERE (s.dni IS NULL OR trim(s.dni) = '')
      AND s.activo IS DISTINCT FROM false
      AND s.email IS NOT NULL AND trim(s.email) <> ''
  LOOP
    SELECT p.id INTO v_user_id
    FROM profiles p
    WHERE lower(trim(p.email)) = lower(trim(v_socio.email))
    LIMIT 1;

    IF v_user_id IS NOT NULL THEN
      v_socios_matcheados := v_socios_matcheados + 1;

      FOR v_disciplina IN
        SELECT d.id, d.name
        FROM disciplines d
        WHERE d.kind = 'credits'
          AND lower(d.name) = ANY (SELECT lower(unnest(v_socio.plan)))
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM user_credits uc
          WHERE uc.user_id = v_user_id AND uc.discipline_id = v_disciplina.id
        ) THEN
          INSERT INTO user_credits (user_id, discipline_id, remaining_credits, expires_at)
          VALUES (v_user_id, v_disciplina.id, COALESCE(v_socio.creditos, 0), now() + interval '30 days');
          v_filas_creadas := v_filas_creadas + 1;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  RAISE NOTICE 'Socios sin DNI matcheados por email: %', v_socios_matcheados;
  RAISE NOTICE 'Filas de user_credits inicializadas: %', v_filas_creadas;
END $$;

-- ============================================================
-- Verificación rápida después de correr esto:
--   select s.nombre, s.apellido, s.email, s.creditos, uc.remaining_credits, d.name
--   from socios s
--   join profiles p on lower(trim(p.email)) = lower(trim(s.email))
--   join user_credits uc on uc.user_id = p.id
--   join disciplines d on d.id = uc.discipline_id
--   where s.dni is null or trim(s.dni) = ''
--   order by s.nombre
--   limit 30;
-- ============================================================
