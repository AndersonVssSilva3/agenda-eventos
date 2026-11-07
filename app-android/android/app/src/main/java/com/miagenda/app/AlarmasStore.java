package com.miagenda.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Guarda los recordatorios en el celular y deja programada solo la alarma más próxima:
 * Android limita las alarmas por app, y al sonar una se programa la siguiente.
 */
final class AlarmasStore {
    private static final String PREFS = "alarmas";
    private static final String CLAVE = "lista";
    private static final long MARGEN_ATRASO_MS = 5 * 60_000; // igual que la web y el servidor

    static final String ACCION_ALARMA = "com.miagenda.app.ALARMA";

    private AlarmasStore() {}

    static void guardar(Context ctx, JSONArray alarmas) throws JSONException {
        List<JSONObject> lista = new ArrayList<>();
        for (int i = 0; i < alarmas.length(); i++) lista.add(alarmas.getJSONObject(i));
        escribir(ctx, lista);
    }

    /** Quita y devuelve las alarmas que ya tocan. */
    static synchronized List<JSONObject> tomarVencidas(Context ctx) {
        long ahora = System.currentTimeMillis();
        List<JSONObject> vencidas = new ArrayList<>();
        List<JSONObject> futuras = new ArrayList<>();
        for (JSONObject a : leer(ctx)) {
            long at = a.optLong("at");
            if (at > ahora + 1000) futuras.add(a);
            else if (at >= ahora - MARGEN_ATRASO_MS) vencidas.add(a);
        }
        escribir(ctx, futuras);
        return vencidas;
    }

    static synchronized void programarSiguiente(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent disparo = PendingIntent.getBroadcast(ctx, 1,
                new Intent(ctx, AlarmaReceiver.class).setAction(ACCION_ALARMA),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.cancel(disparo);

        long minimo = System.currentTimeMillis() - MARGEN_ATRASO_MS;
        for (JSONObject a : leer(ctx)) {
            long at = a.optLong("at");
            if (at < minimo) continue;
            boolean exacta = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms();
            if (exacta) {
                // setAlarmClock es lo único que Android no retrasa con el celular en reposo.
                PendingIntent abrir = PendingIntent.getActivity(ctx, 2,
                        new Intent(ctx, MainActivity.class),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, abrir), disparo);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, disparo);
            }
            return;
        }
    }

    private static List<JSONObject> leer(Context ctx) {
        List<JSONObject> lista = new ArrayList<>();
        String json = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(CLAVE, "[]");
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) lista.add(arr.getJSONObject(i));
        } catch (JSONException e) {
            android.util.Log.e("MiAgenda", "Alarmas guardadas ilegibles", e);
        }
        return lista;
    }

    private static void escribir(Context ctx, List<JSONObject> lista) {
        Collections.sort(lista, (a, b) -> Long.compare(a.optLong("at"), b.optLong("at")));
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(CLAVE, new JSONArray(lista).toString()).apply();
    }
}
