-- Ejecutar UNA vez en Supabase → SQL Editor, ANTES de desplegar la función y publicar la web.
-- No borra datos. Se puede repetir sin problema.

-- Clases que se repiten varios días por semana
alter table public.events add column if not exists recurring_days int[];
update public.events
   set recurring_days = array[recurring_weekday]
 where recurring_weekday is not null and recurring_days is null;

-- Dos avisos por ocurrencia: 'aviso' (antes) e 'inicio' (a la hora)
alter table public.reminders_sent add column if not exists stage text not null default 'aviso';
alter table public.reminders_sent drop constraint if exists reminders_sent_pkey;
alter table public.reminders_sent add primary key (event_id, occurrence_date, stage);
