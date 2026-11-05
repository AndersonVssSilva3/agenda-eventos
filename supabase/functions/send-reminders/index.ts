import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const OFFSET_H = Number(Deno.env.get("TZ_OFFSET_HOURS") ?? "-5");
const p = (n: number) => String(n).padStart(2, "0");
const offsetStr = `${OFFSET_H < 0 ? "-" : "+"}${p(Math.abs(OFFSET_H))}:00`;

function localDay(dayOffset: number) {
  const d = new Date(Date.now() + OFFSET_H * 3600e3 + dayOffset * 86400e3);
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    weekday: d.getUTCDay(),
  };
}

// Misma lógica que en app.js
function occursOn(ev: any, date: string, weekday: number) {
  if (date < ev.event_date) return false;
  if (ev.end_date && date > ev.end_date) return false;
  const wds: number[] | null = Array.isArray(ev.weekdays) && ev.weekdays.length
    ? ev.weekdays
    : ev.recurring_weekday != null ? [ev.recurring_weekday] : null;
  if (wds) return wds.includes(weekday);
  if (ev.end_date) return true;
  return date === ev.event_date;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }

  const days = [localDay(0), localDay(1)];
  const dates = days.map((d) => d.date);

  // Candidatos: eventos que pueden ocurrir hoy o mañana
  const { data: events, error } = await sb
    .from("events")
    .select("*")
    .gte("remind_minutes", 0)
    .lte("event_date", dates[1])
    .or(`event_date.gte.${dates[0]},end_date.gte.${dates[0]},and(end_date.is.null,weekdays.not.is.null),recurring_weekday.not.is.null`);

  if (error) return new Response(error.message, { status: 500 });

  const now = Date.now();
  let sent = 0, attempted = 0;

  for (const ev of events ?? []) {
    for (const day of days) {
      const applies = occursOn(ev, day.date, day.weekday);
      if (!applies) continue;

      const start = new Date(`${day.date}T${String(ev.start_time).slice(0, 8)}${offsetStr}`).getTime();
      const diff = start - now;

      // Ventana: dentro del aviso y hasta 5 min después de la hora
      if (!(diff <= ev.remind_minutes * 60000 && diff > -5 * 60000)) continue;

      const { data: already } = await sb.from("reminders_sent")
        .select("event_id").eq("event_id", ev.id).eq("occurrence_date", day.date).maybeSingle();
      if (already) continue;

      const { data: subs } = await sb.from("push_subscriptions").select("*").eq("user_id", ev.user_id);
      if (!subs?.length) continue;

      const mins = Math.max(0, Math.round(diff / 60000));
      const body = `${String(ev.start_time).slice(0, 5)}${ev.location ? " · " + ev.location : ""}` +
        (mins > 0 ? ` (en ${mins >= 120 ? Math.round(mins / 60) + " h" : mins + " min"})` : " (ahora)");
      const payload = JSON.stringify({ title: ev.title, body, url: "./", tag: `${ev.id}-${day.date}` });

      let ok = 0;
      for (const s of subs) {
        attempted++;
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            // urgency "high": el teléfono despierta y la muestra al instante (sin esperar por ahorro de batería)
            { urgency: "high", TTL: 60 * 60 },
          );
          ok++; sent++;
        } catch (err: any) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await sb.from("push_subscriptions").delete().eq("id", s.id);
          } else {
            console.error("push error", s.id, err.statusCode, err.body);
          }
        }
      }
      // Solo marcamos como enviado si al menos uno llegó
      if (ok > 0) {
        await sb.from("reminders_sent").insert({ event_id: ev.id, occurrence_date: day.date });
      }
    }
  }

  return new Response(JSON.stringify({ checked: events?.length ?? 0, attempted, sent }), {
    headers: { "Content-Type": "application/json" },
  });
});