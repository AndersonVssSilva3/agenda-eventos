package com.miagenda.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AlarmasPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
