# Приложение курьера (Expo)

Экраны — веб-приложение `/courier` в WebView: один код с остальными клиентами, обновления без выпуска новой версии.
Нативное здесь только то, чего не умеет браузер (ADR-006):

- **Геопозиция в фоне** во время смены: `expo-location` и `expo-task-manager`, точки раз в 5 с или на 10 м, Android показывает
  постоянное уведомление «вы на смене». Фон включается по статусу смены с сервера и выключается после «Закончить смену».
- **Без связи** точки копятся на устройстве (до 2000, по времени события) и уходят пакетами при восстановлении (ТЗ §11).

Вход курьер делает в веб-приложении. WebView передаёт токен в приложение, оно хранит его в SecureStore.

## Сборка APK

1. Адрес сервера — в `app.json` → `expo.extra.serverUrl`, например `http://185.18.53.234:8090` или `https://dark.example.tj`.
2. `npm install`.
3. Облачная сборка в EAS (нужен бесплатный аккаунт Expo): `npx eas-cli login`, затем `npm run build:apk`. Ссылка на APK придёт в конце.
4. Или локально, с установленным Android SDK: `npx expo run:android --variant release`.

Без домена и HTTPS Android по умолчанию не пускает приложение на `http://`. Для теста по IP:
`EXPO_OFFLINE=1 npx expo install expo-build-properties` и в `app.json` → `plugins` добавить
`["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]`. В продакшене — домен с HTTPS.

## Проверки

`npm run typecheck`, `npm test` (очередь точек), бандл: `EXPO_OFFLINE=1 npx expo export --platform android`. Всё это гоняет CI.
