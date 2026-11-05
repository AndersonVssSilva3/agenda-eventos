-- =====================================================
-- MIGRACIÓN: rangos de fechas y varios días por semana
-- Ejecuta esto UNA vez en Supabase → SQL Editor → New query
-- =====================================================

alter table public.events add column if not exists end_date date;
alter table public.events add column if not exists weekdays smallint[];

-- Pasa los eventos semanales antiguos al formato nuevo
update public.events
set weekdays = array[recurring_weekday]::smallint[], recurring_weekday = null
where recurring_weekday is not null and weekdays is null;
