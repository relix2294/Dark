import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import { SERVER_URL, TASK, TOKEN_KEY } from './src/config.ts';
import { flush } from './src/location-task.ts';

/**
 * Приложение курьера (ADR-006): экраны — веб-приложение /courier в WebView (один код со всеми клиентами),
 * нативное — только то, чего браузер не умеет: геопозиция в фоне во время смены.
 * Токен курьер получает, входя в веб-приложении; WebView передаёт его сюда, он хранится в SecureStore.
 */
const BRIDGE = `
  window.DARK_NATIVE = true;
  (function () {
    var last = null;
    function send() {
      var t = null;
      try { t = localStorage.getItem('${TOKEN_KEY}'); } catch (e) {}
      if (t !== last) { last = t; window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'token', token: t })); }
    }
    send();
    setInterval(send, 2000);
  })();
  true;
`;

type Perm = 'unknown' | 'granted' | 'foreground_only' | 'denied';

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [onShift, setOnShift] = useState(false);
  const [perm, setPerm] = useState<Perm>('unknown');

  const onMessage = useCallback(async (e: WebViewMessageEvent) => {
    const msg = JSON.parse(e.nativeEvent.data) as { type: string; token?: string | null };
    if (msg.type !== 'token') return;
    if (msg.token) await SecureStore.setItemAsync(TOKEN_KEY, msg.token);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(msg.token ?? null);
  }, []);

  // статус смены — с сервера; фон включён только на смене (offline — выключен)
  useEffect(() => {
    if (!token) {
      setOnShift(false);
      return;
    }
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/v1/courier/me`, { headers: { authorization: `Bearer ${token}` } });
        if (r.ok && !stop) setOnShift(((await r.json()) as { status: string }).status !== 'offline');
      } catch {
        /* без связи — оставляем как было */
      }
    };
    void check();
    const t = setInterval(check, 30_000);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void check());
    return () => {
      stop = true;
      clearInterval(t);
      sub.remove();
    };
  }, [token]);

  useEffect(() => {
    void (async () => {
      const running = await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false);
      if (!onShift) {
        if (running) await Location.stopLocationUpdatesAsync(TASK);
        return;
      }
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') return setPerm('denied');
      const bg = await Location.requestBackgroundPermissionsAsync();
      setPerm(bg.status === 'granted' ? 'granted' : 'foreground_only');
      if (running) return;
      await Location.startLocationUpdatesAsync(TASK, {
        accuracy: Location.Accuracy.High,
        timeInterval: 5_000,
        distanceInterval: 10,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: { notificationTitle: 'Dark: вы на смене', notificationBody: 'Геопозиция передаётся диспетчеру', notificationColor: '#4f8cff' },
      });
    })();
  }, [onShift]);

  // при возврате в приложение — досылаем накопленное без связи
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void flush());
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {onShift && perm !== 'granted' && perm !== 'unknown' && (
        <Pressable style={styles.banner} onPress={() => void Linking.openSettings()}>
          <Text style={styles.bannerText}>
            {perm === 'denied' ? 'Нет доступа к геопозиции — заказы не назначаются. Нажмите, чтобы разрешить.' : 'Разрешите геопозицию «Всегда», иначе при свёрнутом приложении диспетчер вас не видит.'}
          </Text>
        </Pressable>
      )}
      <View style={styles.web}>
        {/* <object>: в типах react-native-webview 14 параметр по умолчанию undefined превращает props в never */}
        <WebView<object>
          source={{ uri: `${SERVER_URL}/courier/` }}
          injectedJavaScriptBeforeContentLoaded={BRIDGE}
          onMessage={(e) => void onMessage(e)}
          geolocationEnabled
          mediaPlaybackRequiresUserAction
          pullToRefreshEnabled
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(r) => {
            // карты и звонки — во внешних приложениях; внутри WebView — только свой сервер
            if (r.url.startsWith(SERVER_URL)) return true;
            void Linking.openURL(r.url);
            return false;
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111318' },
  web: { flex: 1 },
  banner: { backgroundColor: '#3a1818', padding: 12 },
  bannerText: { color: '#ffb3b3', fontSize: 15 },
});
