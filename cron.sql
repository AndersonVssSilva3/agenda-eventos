create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Borra el job viejo si existe
select cron.unschedule('send-reminders') where exists (select 1 from cron.job where jobname='send-reminders');

select cron.schedule(
  'send-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://zmdhrtdquazjzkiojxcn.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'Vanessa98z3.213'
    ),
    body := '{}'::jsonb
  );
  $$
);