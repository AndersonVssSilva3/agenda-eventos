package com.miagenda.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;

import java.util.ArrayDeque;
import java.util.Locale;
import java.util.Set;

/** Muestra el recordatorio, vibra y lo dice en voz alta, aunque el celular esté bloqueado. */
public class VozService extends Service {
    private static final String TAG = "MiAgenda";
    private static final String CANAL_AVISOS = "recordatorios";
    private static final String CANAL_VOZ = "voz";
    private static final int ID_VOZ = 1000;
    private static final long TIEMPO_MAXIMO_MS = 90_000;
    private static final long[] VIBRACION = {0, 500, 200, 500, 200, 500, 200, 500};

    // Android no indica el género de la voz: son los nombres de las voces femeninas de Google.
    private static final String[] VOCES_MUJER = {"es-us-x-sfb", "es-es-x-eea", "es-es-x-eec", "es-es-x-eef"};
    private static final String[] VOCES_HOMBRE = {"es-us-x-esc", "es-us-x-esd", "es-es-x-eed"};

    private final ArrayDeque<String> pendientes = new ArrayDeque<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private boolean ttsListo;
    private int hablando;

    static void anunciar(Context ctx, String id, String titulo, String texto, boolean notificar) {
        Intent i = new Intent(ctx, VozService.class)
                .putExtra("id", id).putExtra("titulo", titulo)
                .putExtra("texto", texto).putExtra("notificar", notificar);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (RuntimeException e) {
            // Android puede negar el servicio (por ejemplo, con una alarma inexacta): al menos, el aviso escrito.
            Log.e(TAG, "No se pudo iniciar la voz", e);
            crearCanales(ctx);
            if (notificar) mostrarAviso(ctx, id, titulo, texto);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        crearCanales(this);
        tts = new TextToSpeech(getApplicationContext(), this::alIniciarVoz);
        handler.postDelayed(this::terminar, TIEMPO_MAXIMO_MS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        iniciarPrimerPlano();
        if (intent == null) {
            terminarSiNoQuedaNada();
            return START_NOT_STICKY;
        }
        String texto = intent.getStringExtra("texto");
        if (intent.getBooleanExtra("notificar", false)) {
            mostrarAviso(this, intent.getStringExtra("id"), intent.getStringExtra("titulo"), texto);
        }
        vibrar();
        if (texto != null) {
            pendientes.add(texto);
            hablarPendientes();
        }
        return START_NOT_STICKY;
    }

    private void iniciarPrimerPlano() {
        Notification n = base(this, CANAL_VOZ)
                .setContentTitle("Mi Agenda")
                .setContentText("Leyendo tu recordatorio")
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ID_VOZ, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(ID_VOZ, n);
        }
    }

    private void alIniciarVoz(int estado) {
        if (estado != TextToSpeech.SUCCESS) {
            Log.e(TAG, "Texto a voz no disponible: " + estado);
            terminar();
            return;
        }
        // USAGE_ALARM: se oye aunque el celular esté en modo vibración, con el volumen de alarma.
        tts.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
        tts.setLanguage(new Locale("es", "US"));
        Voice voz = elegirVozMujer();
        if (voz != null) tts.setVoice(voz);
        tts.setSpeechRate(0.95f);
        tts.setPitch(1.1f);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}
            @Override public void onDone(String id) { alTerminarFrase(); }
            @Override public void onError(String id) { alTerminarFrase(); }
        });
        ttsListo = true;
        hablarPendientes();
    }

    private Voice elegirVozMujer() {
        Set<Voice> voces = null;
        try {
            voces = tts.getVoices();
        } catch (RuntimeException e) {
            Log.w(TAG, "No se pudo leer la lista de voces", e);
        }
        if (voces == null) return null;
        Voice alternativa = null;
        for (String nombre : VOCES_MUJER) {
            for (Voice v : voces) {
                if (usable(v) && v.getName().toLowerCase(Locale.ROOT).startsWith(nombre)) return v;
            }
        }
        for (Voice v : voces) {
            if (!usable(v)) continue;
            String nombre = v.getName().toLowerCase(Locale.ROOT);
            if (nombre.contains("female") || nombre.contains("mujer")) return v;
            boolean hombre = nombre.contains("male") || nombre.contains("hombre");
            for (String h : VOCES_HOMBRE) hombre |= nombre.startsWith(h);
            if (!hombre && alternativa == null) alternativa = v;
        }
        return alternativa;
    }

    private static boolean usable(Voice v) {
        return "es".equals(v.getLocale().getLanguage())
                && !v.isNetworkConnectionRequired()
                && !v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED);
    }

    private void hablarPendientes() {
        if (!ttsListo) return;
        while (!pendientes.isEmpty()) {
            hablando++;
            int r = tts.speak(pendientes.poll(), TextToSpeech.QUEUE_ADD, new Bundle(), "aviso-" + hablando);
            if (r != TextToSpeech.SUCCESS) {
                Log.e(TAG, "No se pudo leer el aviso");
                hablando--;
            }
        }
        terminarSiNoQuedaNada();
    }

    private void alTerminarFrase() {
        handler.post(() -> {
            hablando--;
            terminarSiNoQuedaNada();
        });
    }

    private void terminarSiNoQuedaNada() {
        if (ttsListo && hablando <= 0 && pendientes.isEmpty()) terminar();
    }

    private void terminar() {
        stopForeground(true);
        stopSelf();
    }

    private void vibrar() {
        Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (v == null || !v.hasVibrator()) return;
        AudioAttributes alarma = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            v.vibrate(VibrationEffect.createWaveform(VIBRACION, -1), alarma);
        } else {
            v.vibrate(VIBRACION, -1, alarma);
        }
    }

    private static void mostrarAviso(Context ctx, String id, String titulo, String texto) {
        PendingIntent abrir = PendingIntent.getActivity(ctx, 3, new Intent(ctx, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = base(ctx, CANAL_AVISOS)
                .setContentTitle(titulo)
                .setContentText(texto)
                .setStyle(new Notification.BigTextStyle().bigText(texto))
                .setContentIntent(abrir)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .build();
        ((NotificationManager) ctx.getSystemService(NOTIFICATION_SERVICE)).notify(String.valueOf(id), 1, n);
    }

    @SuppressWarnings("deprecation")
    private static Notification.Builder base(Context ctx, String canal) {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, canal)
                : new Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH);
        return b.setSmallIcon(android.R.drawable.ic_popup_reminder);
    }

    private static void crearCanales(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        // Sin sonido ni vibración de canal: los pone este servicio, para no tapar la voz.
        NotificationChannel avisos = new NotificationChannel(CANAL_AVISOS, "Recordatorios", NotificationManager.IMPORTANCE_HIGH);
        avisos.setSound(null, null);
        avisos.enableVibration(false);
        nm.createNotificationChannel(avisos);
        NotificationChannel voz = new NotificationChannel(CANAL_VOZ, "Voz en curso", NotificationManager.IMPORTANCE_LOW);
        voz.setSound(null, null);
        nm.createNotificationChannel(voz);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
