import Constants from 'expo-constants';

/** Адрес сервера Dark: app.json → expo.extra.serverUrl (для сборки под сервер — поменять там). */
export const SERVER_URL = String((Constants.expoConfig?.extra as { serverUrl?: string } | undefined)?.serverUrl ?? 'http://localhost:8090').replace(/\/$/, '');
export const TOKEN_KEY = 'dark.courier.token';
export const QUEUE_KEY = 'dark.courier.posq';
export const TASK = 'dark-background-location';
