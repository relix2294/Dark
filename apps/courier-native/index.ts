import { registerRootComponent } from 'expo';
// фоновая задача объявляется на верхнем уровне модуля — до регистрации приложения (требование expo-task-manager)
import './src/location-task.ts';
import App from './App.tsx';

registerRootComponent(App);
