package com.miagenda.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/** Recibe la alarma, y también el reinicio del celular, que borra las alarmas programadas. */
public class AlarmaReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (AlarmasStore.ACCION_ALARMA.equals(intent.getAction())) {
            for (JSONObject a : AlarmasStore.tomarVencidas(ctx)) {
                VozService.anunciar(ctx, a.optString("id"), a.optString("title"), a.optString("text"), true);
            }
        }
        AlarmasStore.programarSiguiente(ctx);
    }
}
