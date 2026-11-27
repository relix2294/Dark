# Деплой Dark на VPS

Стек поднимается рядом с Kassa и Marzban и их не трогает: свой compose-проект `dark`, свои порты, свои данные в `/opt/dark/deploy/data`.

## Первый запуск

1. В репозитории: Settings → Secrets and variables → Actions → добавить `VPS_HOST`, `VPS_USER` и `VPS_SSH_KEY` (или `VPS_PASSWORD`).
2. Actions → **Deploy Dark to VPS** → Run workflow.
   - Без домена: `site_address` = `:80`, `http_port` = `8090` → сайт откроется по `http://IP:8090/store/`.
   - С доменом (DNS уже смотрит на сервер, порты 80 и 443 свободны): `site_address` = `dark.example.tj`, `http_port` = `80` → HTTPS выпустится сам.
3. Workflow сам создаст `/opt/dark/deploy/.env` со случайными паролями. Дальше он его не меняет.

Адреса: витрина `/store/`, пульт и админка `/office/`, кухня `/kds/`, сборщик `/picker/`, курьер `/courier/`, API `/api/v1`, документация `/docs`.

## Перед первым входом

Демо-данных в продакшене нет. Первого админа заводит команда на сервере:

```bash
cd /opt/dark/deploy && docker compose -p dark exec api node dist/modules/customers/create-admin.js +992XXXXXXXXX 'Имя' 123456
```

## Дальше

- Повторный деплой — тот же workflow; `.env`, база и фото сохраняются.
- Фото по умолчанию лежат в `data/uploads` на сервере. Для S3-совместимого хранилища заполните `S3_*` и `STORAGE_DRIVER=s3` в `.env`.
- Если порт занят, workflow остановится до запуска и напишет, чем занят. Поменяйте `HTTP_PORT` или `HTTPS_PORT` в `.env`.
