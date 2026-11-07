-- =====================================================
-- Ejecuta TODO esto en Supabase → SQL Editor → New query
-- =====================================================

-- Eventos, clases y citas
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'evento' check (kind in ('evento','clase','cita')),
  title text not null,
  event_date date not null,                 -- fecha (o fecha de inicio si se repite)
  start_time time not null,
  end_time time,
  location text,
  notes text,
  links jsonb not null default '[]',        -- ["https://..."]
  files jsonb not null default '[]',        -- [{name, path, type}]
  remind_minutes int not null default 30,   -- -1 = sin recordatorio
  recurring_weekday int check (recurring_weekday between 0 and 6),  -- primer día de repetición; 0=domingo ... 6=sábado
  recurring_days int[],                     -- todos los días en que se repite
  end_date date,                            -- último día de la repetición (vacío = sin fin)
  created_at timestamptz not null default now()
);
create index if not exists events_user_date_idx on public.events (user_id, event_date);

-- Dispositivos suscritos a notificaciones
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- Evita enviar dos veces el mismo recordatorio
create table if not exists public.reminders_sent (
  event_id uuid not null references public.events(id) on delete cascade,
  occurrence_date date not null,
  stage text not null default 'aviso',      -- 'aviso' (antes) o 'inicio' (a la hora)
  sent_at timestamptz not null default now(),
  primary key (event_id, occurrence_date, stage)
);

-- Seguridad: cada usuario solo ve lo suyo
alter table public.events enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reminders_sent enable row level security;

create policy "events: dueño" on public.events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "push: dueño" on public.push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- reminders_sent: sin políticas → solo la función de servidor puede usarla

-- Supabase ya no da acceso automático a tablas nuevas (desde el 30-oct-2026)
grant select, insert, update, delete on public.events to authenticated, service_role;
grant select, insert, update, delete on public.push_subscriptions to authenticated, service_role;
grant select, insert, update, delete on public.reminders_sent to service_role;

-- Almacenamiento privado para fotos y archivos
insert into storage.buckets (id, name, public)
values ('event-files', 'event-files', false)
on conflict (id) do nothing;

create policy "files: ver los míos" on storage.objects
  for select using (bucket_id = 'event-files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "files: subir a mi carpeta" on storage.objects
  for insert with check (bucket_id = 'event-files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "files: borrar los míos" on storage.objects
  for delete using (bucket_id = 'event-files' and (storage.foldername(name))[1] = auth.uid()::text);
