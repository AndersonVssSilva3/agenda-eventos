-- Ejecutar en Supabase → SQL Editor, ANTES de desplegar la función.
-- Conserva tus eventos. Se puede repetir sin problema.

-- Clases que se repiten varios días por semana
alter table public.events add column if not exists recurring_days int[];
update public.events
   set recurring_days = array[recurring_weekday]
 where recurring_weekday is not null and recurring_days is null;

-- Fechas sueltas elegidas en el calendario
alter table public.events add column if not exists specific_dates date[];

-- Dos avisos por ocurrencia: 'aviso' (antes) e 'inicio' (a la hora)
alter table public.reminders_sent add column if not exists stage text not null default 'aviso';
alter table public.reminders_sent drop constraint if exists reminders_sent_pkey;
alter table public.reminders_sent add primary key (event_id, occurrence_date, stage);

-- El campo "Hasta" se reemplazó por el calendario y nunca llegó a usarse
alter table public.events drop column if exists end_date;
