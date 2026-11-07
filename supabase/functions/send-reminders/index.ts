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
const VENTANA_TRAS_INICIO_MS = 5 * 60000;
const p = (n: number) => String(n).padStart(2, "0");
const offsetStr = `${OFFSET_H < 0 ? "-" : "+"}${p(Math.abs(OFFSET_H))}:00`;

function localDay(dayOffset: number) {
  const d = new Date(Date.now() + OFFSET_H * 3600e3 + dayOffset * 86400e3);
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    weekday: d.getUTCDay(),
  };
}

// Los eventos anteriores a recurring_days solo tienen recurring_weekday.
function diasDe(ev: any): number[] {
  if (ev.recurring_days?.length) return ev.recurring_days;
  return ev.recurring_weekday == null ? [] : [ev.recurring_weekday];
}

// Mismos textos que en app.js
function nombreEvento(ev: any) {
  const titulo = String(ev.title).trim();
  if (titulo.toLowerCase().startsWith(ev.kind)) return `tu ${titulo}`;
  return ev.kind === "clase" ? `tu clase de ${titulo}` : `tu ${ev.kind}: ${titulo}`;
}

function duracion(mins: number) {
  const plural = (n: number, palabra: string) => `${n} ${palabra}${n === 1 ? "" : "s"}`;
  if (mins >= 1440 && mins % 1440 === 0) return plural(mins / 1440, "día");
  const horas = Math.floor(mins / 60);
  const resto = mins % 60;
  if (!horas) return plural(resto, "minuto");
  return resto ? `${plural(horas, "hora")} y ${plural(resto, "minuto")}` : plural(horas, "hora");
}

function textoAviso(ev: any, msFaltantes: number) {
  const lugar = ev.location ? ` en ${ev.location}` : "";
  const hora = String(ev.start_time).slice(0, 5);
  return `Hola, te recuerdo con cariño que ${nombreEvento(ev)} empieza en ${duracion(Math.ceil(msFaltantes / 60000))}, a las ${hora}${lugar}. Ve preparándote con calma.`;
}

function textoInicio(ev: any) {
  const lugar = ev.location ? ` en ${ev.location}` : "";
  const nombre = nombreEvento(ev);
  return `¡Ya es la hora! ${nombre[0].toUpperCase()}${nombre.slice(1)} empieza ahora${lugar}. Que te vaya muy bien.`;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }

  const days = [localDay(0), localDay(1)];
  const dates = days.map((d) => d.date);

  // Todo evento semanal tiene recurring_weekday (su primer día); los días se filtran abajo.
  const { data: events, error } = await sb
    .from("events")
    .select("*")
    .gte("remind_minutes", 0)
    .or(`event_date.in.(${dates.join(",")}),recurring_weekday.not.is.null`);

  if (error) return new Response(error.message, { status: 500 });

  const now = Date.now();
  let sent = 0, attempted = 0;

  for (const ev of events ?? []) {
    for (const day of days) {
      const dias = diasDe(ev);
      const applies = dias.length === 0
        ? ev.event_date === day.date
        : dias.includes(day.weekday) && day.date >= ev.event_date;
      if (!applies) continue;

      const start = new Date(`${day.date}T${String(ev.start_time).slice(0, 8)}${offsetStr}`).getTime();
      const diff = start - now;

      // Dos avisos: el previo, dentro del tiempo elegido, y otro al llegar la hora.
      if (!(diff <= ev.remind_minutes * 60000 && diff > -VENTANA_TRAS_INICIO_MS)) continue;
      const stage = diff > 0 ? "aviso" : "inicio";

      const { data: already, error: alreadyError } = await sb.from("reminders_sent")
        .select("event_id").eq("event_id", ev.id).eq("occurrence_date", day.date).eq("stage", stage).maybeSingle();
      if (alreadyError) {
        // Sin saber si ya se envió, no se envía: evita repetir el aviso cada minuto.
        console.error("reminders_sent", alreadyError.message);
        continue;
      }
      if (already) continue;

      const { data: subs } = await sb.from("push_subscriptions").select("*").eq("user_id", ev.user_id);
      if (!subs?.length) continue;

      const body = stage === "aviso" ? textoAviso(ev, diff) : textoInicio(ev);
      const payload = JSON.stringify({ title: ev.title, body, event_id: ev.id, date: day.date, stage });
      // urgency high: Android entrega al momento aunque el celular esté en reposo.
      // TTL: si el dispositivo sigue sin conexión pasada 1 hora, el aviso ya no sirve.
      const pushOptions = { urgency: "high", TTL: 3600 };

      let ok = 0;
      for (const s of subs) {
        attempted++;
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, pushOptions);
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
        await sb.from("reminders_sent").insert({ event_id: ev.id, occurrence_date: day.date, stage });
      }
    }
  }

  return new Response(JSON.stringify({ checked: events?.length ?? 0, attempted, sent }), {
    headers: { "Content-Type": "application/json" },
  });
});
