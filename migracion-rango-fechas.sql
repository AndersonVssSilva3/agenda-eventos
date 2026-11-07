-- Ejecutar en Supabase → SQL Editor, después de migracion-dias-y-avisos.sql
-- y antes de publicar la web. No borra datos. Se puede repetir sin problema.

-- Último día de un evento que se repite o abarca un rango de fechas
alter table public.events add column if not exists end_date date;
