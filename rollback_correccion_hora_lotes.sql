-- =====================================================================================
-- ROLLBACK de supabase_migration_correccion_hora_lotes.sql. NO SE CORRIÓ.
--
-- Cada lote de respaldo.correccion_hora_lotes vuelve EXACTAMENTE a su expires_at de antes
-- (la hora exacta de la compra o las 00:00). Se borra solo respaldo.correccion_hora_lotes.
-- Solo toca user_credits.expires_at de esos lotes.
--
-- Guardas (si alguna falla, no se aplica nada):
--   1) ANTES: existe el respaldo y TODOS sus lotes siguen con el expires_at que les puso la
--      corrección. Si alguno cambió después (un cobro lo venció, Seba le editó la fecha), se
--      frena y lo nombra: volverlo "a antes" desharía ese cambio posterior. En ese caso hay
--      que decidir a mano qué hacer con esos lotes.
--   2) DESPUÉS: todos con su expires_at de antes; el candado T7 corre YA (SET CONSTRAINTS ...
--      IMMEDIATE) sin errores. El día AR de cada lote no cambia, así que el candado ve las
--      mismas fechas.
-- =====================================================================================

begin;

set local lock_timeout = '5s';

lock table public.user_credits in share row exclusive mode;

do $guarda$
declare
  v_txt text;
begin
  if to_regclass('respaldo.correccion_hora_lotes') is null then
    raise exception 'Rollback corrección de hora: no existe respaldo.correccion_hora_lotes (¿no se aplicó?). No se aplicó nada.';
  end if;
  select string_agg(b.lote_id::text || ' (' || coalesce(uc.expires_at::text, 'borrado') || ')', ', ') into v_txt
  from respaldo.correccion_hora_lotes b
  left join public.user_credits uc on uc.id = b.lote_id
  where uc.id is null or uc.expires_at is distinct from b.expires_at_nuevo;
  if v_txt is not null then
    raise exception 'Rollback corrección de hora: estos lotes cambiaron después de la corrección: %. No se aplicó nada.', v_txt;
  end if;
end;
$guarda$;

do $restaurar$
declare
  v_n int;
begin
  update public.user_credits uc
  set expires_at = b.expires_at_antes
  from respaldo.correccion_hora_lotes b
  where uc.id = b.lote_id
    and uc.expires_at = b.expires_at_nuevo;
  get diagnostics v_n = row_count;
  if v_n <> (select count(*) from respaldo.correccion_hora_lotes) then
    raise exception 'Rollback corrección de hora: se restauraron % de % lotes. No se aplicó nada.', v_n, (select count(*) from respaldo.correccion_hora_lotes);
  end if;
end;
$restaurar$;

set constraints public.candado_una_fecha_vigente_ins, public.candado_una_fecha_vigente_upd immediate;

do $verifica$
declare
  v_n int;
begin
  select count(*) into v_n
  from respaldo.correccion_hora_lotes b
  join public.user_credits uc on uc.id = b.lote_id
  where uc.expires_at = b.expires_at_antes;
  if v_n <> (select count(*) from respaldo.correccion_hora_lotes) then
    raise exception 'Rollback corrección de hora: % de % lotes volvieron a su fecha de antes. No se aplicó nada.', v_n, (select count(*) from respaldo.correccion_hora_lotes);
  end if;
  raise notice 'Rollback corrección de hora aplicado: % lotes volvieron a su expires_at de antes.', v_n;
end;
$verifica$;

drop table respaldo.correccion_hora_lotes;

commit;
