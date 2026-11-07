package com.miagenda.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;

/** Puente con la web: recibe los recordatorios calculados en app.js. */
@CapacitorPlugin(
        name = "AlarmasNativas",
        permissions = @Permission(alias = "notificaciones", strings = {Manifest.permission.POST_NOTIFICATIONS})
)
public class AlarmasPlugin extends Plugin {
    @PluginMethod
    public void programar(PluginCall call) {
        JSArray alarmas = call.getArray("alarmas");
        if (alarmas == null) {
            call.reject("Faltan las alarmas");
            return;
        }
        try {
            AlarmasStore.guardar(getContext(), alarmas);
        } catch (JSONException e) {
            call.reject("Alarmas inválidas", e);
            return;
        }
        AlarmasStore.programarSiguiente(getContext());
        call.resolve();
    }

    @PluginMethod
    public void decir(PluginCall call) {
        String texto = call.getString("texto");
        if (texto == null) {
            call.reject("Falta el texto");
            return;
        }
        VozService.anunciar(getContext(), "prueba", "Mi Agenda", texto, false);
        call.resolve();
    }

    /** Abre la app indicada si está instalada; si no, lo que Android tenga para ese enlace. */
    @PluginMethod
    public void abrirEnlace(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("Enlace no válido");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE);
        String paquete = call.getString("paquete");
        try {
            if (paquete != null) {
                try {
                    getActivity().startActivity(new Intent(intent).setPackage(paquete));
                    call.resolve();
                    return;
                } catch (ActivityNotFoundException e) {
                    Log.i("MiAgenda", "App no instalada: " + paquete);
                }
            }
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No hay ninguna app para abrir este enlace", e);
        }
    }

    @PluginMethod
    public void pedirPermisos(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notificaciones") != PermissionState.GRANTED) {
            requestPermissionForAlias("notificaciones", call, "alResponderPermiso");
            return;
        }
        pedirSinRestriccionDeBateria();
        call.resolve();
    }

    @PermissionCallback
    private void alResponderPermiso(PluginCall call) {
        pedirSinRestriccionDeBateria();
        call.resolve();
    }

    @SuppressLint("BatteryLife") // La app no se publica en Play Store y sin esto la alarma puede fallar.
    private void pedirSinRestriccionDeBateria() {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm.isIgnoringBatteryOptimizations(ctx.getPackageName())) return;
        getActivity().startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:" + ctx.getPackageName())));
    }
}
