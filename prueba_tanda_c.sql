-- =====================================================================================
-- PRUEBA de Tanda C (supabase_migration_tanda_c_cerrar_anon.sql). Correr DESPUÉS.
--
-- NO DEJA NADA EN LA BASE: todo son lecturas o llamadas a RPC de solo lectura, cada una en
-- una subtransacción que se deshace SIEMPRE (también el "set local role"). Lo único que
-- sobrevive es el log (tabla temporal de la sesión).
--
-- CASOS
--   A  Permisos: cada función cerrada (respaldo.permisos_funciones, tanda C) -> anon NO
--      puede ejecutarla; authenticated y service_role SÍ. is_admin() e is_active_socio()
--      -> anon SÍ (se quedaron abiertas).
--   B  Como anon (sin login), llamar RPCs de la PWA y del Admin -> FALLA con 42501
--      (permission denied for function).
--   C  Como authenticated, con la cuenta de test (DNI 44537978) -> las mismas RPCs ANDAN.
--   D  La landing como anon: las 4 lecturas de greenfit-site/index.html (banner, redes,
--      catálogo de disciplinas, horarios) -> ANDAN, y disciplines devuelve filas.
-- =====================================================================================
begin;

drop table if exists pg_temp._log;
create temp table _log (n bigserial primary key, caso text, linea text);

do $$
begin
  if not exists (select 1 from respaldo.permisos_funciones where tanda = 'C') then
    raise exception 'Falta correr supabase_migration_tanda_c_cerrar_anon.sql';
  end if;
  if not exists (select 1 from profiles where dni = '44537978') then
    raise exception 'No existe la cuenta de test (profiles.dni = 44537978)';
  end if;
end $$;

-- Corre p_sql como p_rol (con el JWT de p_user si viene) dentro de una subtransacción que
-- se deshace siempre. p_esperado: 'anda' | '42501'.
create function pg_temp.probar(p_caso text, p_descripcion text, p_rol text, p_user uuid, p_sql text, p_esperado text)
returns void language plpgsql as $$
declare
  v_resultado text; v_estado text; v_mensaje text; v_ok boolean;
begin
  begin
    execute format('set local role %I', p_rol);
    perform set_config('request.jwt.claims',
      case when p_user is null then json_build_object('role', p_rol)::text
           else json_build_object('sub', p_user, 'role', p_rol)::text end, true);
    execute p_sql;
    raise exception 'DESHACER' using errcode = 'P0999';
  exception
    when sqlstate 'P0999' then
      v_resultado := 'anda';
    when others then
      get stacked diagnostics v_estado = returned_sqlstate, v_mensaje = message_text;
      v_resultado := v_estado;
  end;

  v_ok := v_resultado = p_esperado;
  insert into _log(caso, linea) values (p_caso,
    case when v_ok then 'OK        ' else 'FALLA     ' end || p_descripcion || ' -> '
      || case when v_resultado = 'anda' then 'anduvo' else format('error %s: %s', v_resultado, v_mensaje) end
      || case when v_ok then '' else format(' (se esperaba: %s)', p_esperado) end);
end $$;

-- ── A: permisos ─────────────────────────────────────────────────────────────────────
insert into _log(caso, linea)
select 'A',
  case when not has_function_privilege('anon', r.firma, 'EXECUTE')
             and has_function_privilege('authenticated', r.firma, 'EXECUTE')
             and has_function_privilege('service_role', r.firma, 'EXECUTE')
       then 'OK        ' else 'FALLA     ' end
  || r.firma || ' -> anon ' || case when has_function_privilege('anon', r.firma, 'EXECUTE') then 'PUEDE' else 'no puede' end
  || ', authenticated ' || case when has_function_privilege('authenticated', r.firma, 'EXECUTE') then 'puede' else 'NO PUEDE' end
  || ', service_role ' || case when has_function_privilege('service_role', r.firma, 'EXECUTE') then 'puede' else 'NO PUEDE' end
from (select distinct firma from respaldo.permisos_funciones where tanda = 'C') r
order by r.firma;

insert into _log(caso, linea)
select 'A',
  case when has_function_privilege('anon', f, 'EXECUTE') then 'OK        ' else 'FALLA     ' end
  || f || ' -> anon ' || case when has_function_privilege('anon', f, 'EXECUTE') then 'puede (se quedó abierta)' else 'NO PUEDE (la landing se rompe)' end
from unnest(array['public.is_admin()', 'public.is_active_socio()']) f;

-- ── B y C: las mismas RPCs como anon (falla) y como la cuenta de test (anda) ─────────
do $casos$
declare
  v_test uuid := (select id from profiles where dni = '44537978');
  r record;
begin
  for r in
    select * from (values
      ('get_bookings_count_por_clase (Agenda de la PWA)', $q$ select * from public.get_bookings_count_por_clase(array[]::uuid[], current_date) $q$, 'public.get_bookings_count_por_clase(uuid[],date)'),
      ('mi_dia_corte (Home de la PWA)',                 $q$ select * from public.mi_dia_corte() $q$,                                         'public.mi_dia_corte()'),
      ('community_ranking_xp (Comunidad)',              $q$ select * from public.community_ranking_xp(null) $q$,                             'public.community_ranking_xp(uuid)'),
      ('community_author_names (Comunidad y Admin)',    $q$ select * from public.community_author_names(array[]::uuid[]) $q$,                'public.community_author_names(uuid[])')
    ) as t(descripcion, sql, firma)
  loop
    -- Solo si esa función es de las que cerró Tanda C (si no estaba en la lista, no aplica).
    -- (se compara por regprocedure: el texto de la firma puede venir con o sin "public.")
    if exists (select 1 from respaldo.permisos_funciones
               where tanda = 'C' and to_regprocedure(firma) = to_regprocedure(r.firma)) then
      perform pg_temp.probar('B', 'anon llama ' || r.descripcion, 'anon', null, r.sql, '42501');
      perform pg_temp.probar('C', 'cuenta de test llama ' || r.descripcion, 'authenticated', v_test, r.sql, 'anda');
    else
      insert into _log(caso, linea) values ('B/C', 'SALTEADO  ' || r.firma || ' no estaba en la lista de Tanda C');
    end if;
  end loop;
end;
$casos$;

-- ── D: la landing como anon (las 4 lecturas de greenfit-site/index.html) ─────────────
select pg_temp.probar('D', 'landing: banner (configuracion id=1)', 'anon', null,
  $q$ select banner_activo, banner_mensaje, banner_link_text, banner_link_url from public.configuracion where id = 1 $q$, 'anda');
select pg_temp.probar('D', 'landing: redes (configuracion id=1)', 'anon', null,
  $q$ select whatsapp_numero, instagram_usuario from public.configuracion where id = 1 $q$, 'anda');
select pg_temp.probar('D', 'landing: catálogo (disciplines) y devuelve filas', 'anon', null,
  $q$ do $x$ begin
        if (select count(*) from public.disciplines) = 0 then
          raise exception 'anon no ve ninguna disciplina' using errcode = 'P0001';
        end if;
      end $x$ $q$, 'anda');
select pg_temp.probar('D', 'landing: horarios (classes recurrentes)', 'anon', null,
  $q$ select discipline_id, days_of_week, start_time, end_time from public.classes
      where discipline_id in (select id from public.disciplines) and fecha_unica is null $q$, 'anda');

insert into _log(caso, linea)
select 'RESUMEN', format('%s OK, %s FALLA, %s SALTEADO',
  count(*) filter (where linea like 'OK%'), count(*) filter (where linea like 'FALLA%'), count(*) filter (where linea like 'SALTEADO%'))
from _log;

commit;

select caso, linea from pg_temp._log order by n;
