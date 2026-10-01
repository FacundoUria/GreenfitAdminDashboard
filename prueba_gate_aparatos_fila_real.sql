-- =====================================================================================
-- PRUEBA de esta_habilitado_para_disciplina() después de
-- supabase_migration_gate_aparatos_fila_real.sql (Etapa 4, Parte A).
-- Cuenta de prueba: Facundo Uria, DNI 44537978.
--
-- CÓMO CORRERLO
--   * Pegar TODO el archivo en el SQL Editor y ejecutar UNA vez. El resultado es la ÚLTIMA
--     grilla (una línea OK/FALLA por chequeo y un resumen al final).
--
-- NO DEJA NADA EN LA BASE
--   * Cada caso arma su escenario (filas de user_credits y la ficha de socios de la cuenta de
--     prueba) dentro de una subtransacción que se DESHACE SIEMPRE, y recién ahí llama al gate.
--   * El chequeo FINAL confirma que user_credits y la ficha de la cuenta de prueba quedaron
--     exactamente igual que antes.
--
-- CASOS (Aparatos)
--   1  Aparatos real vigente + socios.fecha_vencimiento VACÍA            -> habilitado  (antes: no)
--   2  Aparatos real vigente + socios.fecha_vencimiento YA PASADA        -> habilitado  (antes: no)
--   3  SIN Aparatos real + socios.fecha_vencimiento FUTURA (los 14)      -> NO habilitado (antes: sí)
--   4  Aparatos real VENCIDO + socios.fecha_vencimiento FUTURA           -> NO habilitado (antes: sí)
--   5  Aparatos real vigente + socio DADO DE BAJA                        -> NO habilitado
--   6  (datos reales, solo lectura) cuenta de la app SIN ficha en socios -> NO habilitado
--   7  Aparatos real vigente + todo en orden                             -> habilitado
--   8  Solo créditos vigentes de otra disciplina (sin Aparatos)          -> NO habilitado para Aparatos
-- CASOS (créditos -- no cambiaron, se confirma que siguen igual)
--   9  Lote vigente con saldo                                            -> habilitado
--   10 Lote vigente con saldo 0                                          -> NO habilitado
--   11 Lote con saldo pero vencido                                       -> NO habilitado
--   12 Lote vigente con saldo + socio dado de baja                       -> habilitado (créditos nunca miró la baja)
-- OTROS
--   13 Disciplina inexistente / usuario sin perfil                       -> NO habilitado
--   14 (datos reales, solo lectura) ningún socio de solo créditos queda con Aparatos abierto
-- =====================================================================================
begin;

drop table if exists pg_temp._log;
drop table if exists pg_temp._ctx;
drop table if exists pg_temp._antes;
create temp table _log (n bigserial primary key, caso text, linea text);

create temp table _ctx as
select
  (select id from profiles where dni = '44537978') as u,
  '44537978'::text as dni,
  (select id from disciplines where kind = 'membership' order by name limit 1) as aparatos,
  (select id from disciplines where kind = 'credits' order by name limit 1) as creditos;

do $$
declare c record;
begin
  select * into c from pg_temp._ctx;
  if c.u is null then raise exception 'No existe el perfil con DNI 44537978'; end if;
  if not exists (select 1 from socios where dni = c.dni) then raise exception 'No existe la ficha de socios con DNI 44537978'; end if;
  if c.aparatos is null or c.creditos is null then raise exception 'Falta una disciplina de membresía o de créditos en disciplines'; end if;
  if exists (
    select 1 from pg_proc
    where oid = 'public.esta_habilitado_para_disciplina(uuid, uuid)'::regprocedure
      and prosrc like '%v_fecha_vencimiento%'
  ) then
    raise exception 'Falta correr supabase_migration_gate_aparatos_fila_real.sql (el gate todavía lee socios.fecha_vencimiento)';
  end if;
end $$;

create temp table _antes as
select
  (select coalesce(md5(string_agg(md5(uc::text), '' order by uc.id::text)), '') from user_credits uc where uc.user_id = (select u from _ctx)) as huella_creditos,
  (select md5(s::text) from socios s where s.dni = (select dni from _ctx)) as huella_socio;

-- Arma el escenario (p_escenario) dentro de una subtransacción que SIEMPRE se deshace, llama al
-- gate para la disciplina indicada y compara con lo esperado.
create function pg_temp.caso(p_caso text, p_descripcion text, p_escenario text, p_disciplina uuid, p_esperado boolean)
returns void language plpgsql as $$
declare
  v_resultado boolean; v_error text;
begin
  begin
    execute p_escenario;
    v_resultado := public.esta_habilitado_para_disciplina((select u from pg_temp._ctx), p_disciplina);
    raise exception 'DESHACER:%', v_resultado using errcode = 'P0999';
  exception
    when sqlstate 'P0999' then
      v_resultado := split_part(sqlerrm, ':', 2)::boolean;
    when others then
      v_error := sqlerrm;
  end;

  insert into _log(caso, linea) values (
    p_caso,
    case
      when v_error is not null then 'FALLA     ' || p_descripcion || ' -> ERROR INESPERADO: ' || v_error
      when v_resultado is not distinct from p_esperado then
        'OK        ' || p_descripcion || ' -> ' || case when v_resultado then 'habilitado' else 'NO habilitado' end
      else
        'FALLA     ' || p_descripcion || ' -> ' || case when v_resultado then 'habilitado' else 'NO habilitado' end
          || ' (se esperaba: ' || case when p_esperado then 'habilitado' else 'NO habilitado' end || ')'
    end
  );
end $$;

-- Piezas de escenario (texto SQL). Todas operan SOLO sobre la cuenta de prueba.
--   aparatos(dias): apaga cualquier fila de Aparatos y, si dias no es null, crea una que vence en `dias` días.
--   creditos(saldo, dias): pone en 0 los lotes de la disciplina de créditos y crea uno con ese saldo/vencimiento.
--   socio(activo, dias): fija socios.activo y socios.fecha_vencimiento (hoy + dias; null = vacía).
create function pg_temp.aparatos(p_dias int) returns text language sql as $$
  select format(
    'update user_credits set expires_at = least(expires_at, now() - interval ''2 days'') where user_id = %L and discipline_id = %L;',
    c.u, c.aparatos)
    || case when p_dias is null then '' else format(
    ' insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values (%L, %L, null, now() + make_interval(days => %s));',
    c.u, c.aparatos, p_dias) end
  from pg_temp._ctx c
$$;
create function pg_temp.creditos(p_saldo int, p_dias int) returns text language sql as $$
  select format(
    'update user_credits set remaining_credits = 0 where user_id = %L and discipline_id = %L;'
    || ' insert into user_credits (user_id, discipline_id, remaining_credits, expires_at) values (%L, %L, %s, now() + make_interval(days => %s));',
    c.u, c.creditos, c.u, c.creditos, p_saldo, p_dias)
  from pg_temp._ctx c
$$;
create function pg_temp.socio(p_activo boolean, p_dias int) returns text language sql as $$
  select format('update socios set activo = %L, fecha_vencimiento = %s where dni = %L;',
    p_activo, case when p_dias is null then 'null' else format('current_date + %s', p_dias) end, c.dni)
  from pg_temp._ctx c
$$;

-- ── Aparatos ──
select pg_temp.caso('1', 'Aparatos real vigente + fecha_vencimiento vacía',
  pg_temp.aparatos(10) || pg_temp.socio(true, null), (select aparatos from _ctx), true);
select pg_temp.caso('2', 'Aparatos real vigente + fecha_vencimiento ya pasada',
  pg_temp.aparatos(10) || pg_temp.socio(true, -40), (select aparatos from _ctx), true);
select pg_temp.caso('3', 'SIN Aparatos real + fecha_vencimiento futura (caso de los 14)',
  pg_temp.aparatos(null) || pg_temp.creditos(4, 20) || pg_temp.socio(true, 20), (select aparatos from _ctx), false);
select pg_temp.caso('4', 'Aparatos real VENCIDO + fecha_vencimiento futura',
  pg_temp.aparatos(-3) || pg_temp.socio(true, 20), (select aparatos from _ctx), false);
select pg_temp.caso('5', 'Aparatos real vigente + socio dado de baja',
  pg_temp.aparatos(10) || pg_temp.socio(false, 10), (select aparatos from _ctx), false);
-- 6: socios.activo es NOT NULL en producción, así que "activo vacío" no puede pasar. El caso real
-- que cubre el coalesce(v_activo, false) del gate es una cuenta de la app SIN ficha en socios
-- (el DNI no cruza): no entra, tenga lo que tenga en user_credits. Solo lectura, datos reales.
insert into _log(caso, linea)
select '6',
  case
    when count(*) = 0 then 'NOTA      datos reales: no hay cuentas de la app sin ficha en socios (nada que probar)'
    when count(*) filter (where public.esta_habilitado_para_disciplina(p.id, (select aparatos from _ctx))) = 0
      then format('OK        datos reales: %s cuentas de la app sin ficha en socios (%s con una fila de Aparatos vigente) -> ninguna habilitada',
        count(*), count(*) filter (where exists (
          select 1 from user_credits uc
          where uc.user_id = p.id and uc.discipline_id = (select aparatos from _ctx) and uc.expires_at > now())))
    else format('FALLA     datos reales: %s cuentas sin ficha en socios tienen Aparatos habilitado',
      count(*) filter (where public.esta_habilitado_para_disciplina(p.id, (select aparatos from _ctx))))
  end
from profiles p
where not exists (select 1 from socios s where s.dni = p.dni);
select pg_temp.caso('7', 'Aparatos real vigente + todo en orden',
  pg_temp.aparatos(10) || pg_temp.socio(true, 10), (select aparatos from _ctx), true);
select pg_temp.caso('8', 'solo créditos vigentes de otra disciplina, sin Aparatos',
  pg_temp.aparatos(null) || pg_temp.creditos(4, 20) || pg_temp.socio(true, null), (select aparatos from _ctx), false);

-- ── Créditos (sin cambios) ──
select pg_temp.caso('9', 'créditos: lote vigente con saldo',
  pg_temp.creditos(3, 10) || pg_temp.socio(true, null), (select creditos from _ctx), true);
select pg_temp.caso('10', 'créditos: lote vigente con saldo 0',
  pg_temp.creditos(0, 10) || pg_temp.socio(true, 10), (select creditos from _ctx), false);
select pg_temp.caso('11', 'créditos: lote con saldo pero vencido',
  pg_temp.creditos(3, -2) || pg_temp.socio(true, 10), (select creditos from _ctx), false);
select pg_temp.caso('12', 'créditos: lote vigente con saldo + socio dado de baja (créditos no mira la baja)',
  pg_temp.creditos(3, 10) || pg_temp.socio(false, null), (select creditos from _ctx), true);

-- ── Otros ──
insert into _log(caso, linea)
select '13', case when not public.esta_habilitado_para_disciplina((select u from _ctx), gen_random_uuid())
                   and not public.esta_habilitado_para_disciplina(gen_random_uuid(), (select aparatos from _ctx))
  then 'OK        disciplina inexistente / usuario sin perfil -> NO habilitado'
  else 'FALLA     disciplina inexistente / usuario sin perfil -> habilitado (se esperaba: NO habilitado)' end;

-- ── 14: datos reales (solo lectura) ──
-- Con el gate viejo esto daba 14. Con el nuevo tiene que dar 0: nadie tiene Aparatos abierto
-- sin una fila real de Aparatos vigente.
insert into _log(caso, linea)
select '14',
  case when count(*) = 0
    then 'OK        datos reales: ningún socio tiene Aparatos habilitado sin una fila real de Aparatos vigente'
    else format('FALLA     datos reales: %s socios tienen Aparatos habilitado sin fila real vigente', count(*))
  end
from profiles p
where public.esta_habilitado_para_disciplina(p.id, (select aparatos from _ctx))
  and not exists (
    select 1 from user_credits uc
    where uc.user_id = p.id and uc.discipline_id = (select aparatos from _ctx) and uc.expires_at > now()
  );

insert into _log(caso, linea)
select '14', format('NOTA      datos reales: hoy %s socios tienen Aparatos habilitado', count(*))
from profiles p
where public.esta_habilitado_para_disciplina(p.id, (select aparatos from _ctx));

-- ── FINAL ──
insert into _log(caso, linea)
select 'FINAL',
  case when a.huella_creditos = d.huella_creditos and a.huella_socio is not distinct from d.huella_socio
    then 'OK        user_credits y la ficha de socios de la cuenta de prueba quedaron idénticas'
    else 'FALLA     la cuenta de prueba CAMBIÓ (avisar antes de seguir)'
  end
from _antes a, (
  select
    (select coalesce(md5(string_agg(md5(uc::text), '' order by uc.id::text)), '') from user_credits uc where uc.user_id = (select u from _ctx)) as huella_creditos,
    (select md5(s::text) from socios s where s.dni = (select dni from _ctx)) as huella_socio
) d;

insert into _log(caso, linea)
select 'RESUMEN', format('%s OK, %s FALLA',
  count(*) filter (where linea like 'OK%'), count(*) filter (where linea like 'FALLA%'))
from _log;

commit;

select caso, linea from pg_temp._log order by n;
