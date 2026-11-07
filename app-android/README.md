# Mi Agenda para Android

Carga la web publicada y programa alarmas en el celular, que dicen cada recordatorio
en voz alta aunque esté bloqueado. La lógica nativa está en
`android/app/src/main/java/com/miagenda/app/`.

Para compilar hacen falta JDK 21 y Android SDK 35. Conviene hacerlo fuera de OneDrive:

    npm install
    npx cap sync android
    cd android
    gradlew assembleDebug

El APK queda en `android/app/build/outputs/apk/debug/app-debug.apk`.
Para instalar actualizaciones sobre la app, compila con la misma firma
(`~/.android/debug.keystore`); con otra hay que desinstalar la anterior.
