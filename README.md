# Калькулятор доставки СДЭК

Внутреннее веб-приложение для менеджеров: расчёт упаковочных мест и стоимости
доставки СДЭК по данным из Google Таблицы (артикулы, габариты, вес, правила
групповой упаковки).

**Управление доступом = управление доступом к таблице.** Пользователь входит
через свой Google-аккаунт; приложение читает таблицу его OAuth-токеном.
Есть доступ к таблице — есть доступ к калькулятору. Владелец таблицы добавляет
и убирает сотрудников обычной кнопкой «Поделиться». Service account не
используется ни как основной способ, ни как fallback.

## Как это работает

1. Менеджер входит через Google (запрашиваются только профиль, email и чтение
   таблиц — без доступа ко всему Drive).
2. Приложение проверяет доступ к таблице чтением её метаданных от имени
   менеджера. Нет доступа → страница «Нет доступа к таблице» с инструкцией.
3. Менеджер ищет товары по артикулу/наименованию, добавляет позиции с
   количеством — сервер рассчитывает упаковочные места по правилам групповой
   упаковки из таблицы.
4. Менеджер указывает города «откуда»/«куда» (подсказки СДЭК) и режим
   (склад/дверь) — сервер вызывает API СДЭК и показывает тарифы: стоимость и
   срок.

### Логика упаковки

- Есть точное правило на введённое количество → одно место по нему.
- Иначе — жадная раскладка от большей упаковки к меньшей
  (пример: правила «мешок 6 шт» и «штука 1 шт», введено 14 → 2 мешка + 2 шт).
- Остаток без правила закрывается поштучно по ДШВ/весу из справочника
  (с предупреждением). Нет и поштучных данных → понятная ошибка, расчёт
  останавливается.
- Места с нулевым/пустым весом или габаритом в СДЭК не отправляются.
- В СДЭК вес уходит в граммах, габариты — в сантиметрах.
- Для режимов со стороной «склад» места проверяются против ограничений ПВЗ
  города (вес, габариты ячеек — данные из API СДЭК): менеджер видит
  предупреждение, сколько пунктов примут такие места, или что не примет
  ни один.

### Безопасность

- Перед расчётом доставки сервер **заново** читает таблицу от имени текущего
  пользователя и пересчитывает места — данным с frontend о весе/габаритах
  не доверяет (клиент шлёт только артикулы и количества).
- Сессия — httpOnly-cookie с шифрованным содержимым (JWE A256GCM): Google
  access/refresh token недоступны браузерному JavaScript.
- `GOOGLE_CLIENT_SECRET`, `CDEK_CLIENT_ID`, `CDEK_CLIENT_SECRET`,
  `NEXTAUTH_SECRET` — только на сервере. Токены Google и СДЭК не логируются.
- Серверные модули защищены `server-only` — импорт из клиентского кода
  ломает сборку.
- Scope Google — `spreadsheets.readonly`: приложение не может менять таблицы.

## Настройка

### 1. Google Cloud (один раз)

1. [Google Cloud Console](https://console.cloud.google.com/) → создайте проект.
2. **APIs & Services → Library** → включите **Google Sheets API**.
3. **OAuth consent screen**: тип *Internal* (Google Workspace) или *External*;
   при External добавьте всех менеджеров в **Test users** (scope чтения таблиц —
   «чувствительный», без публикации приложения входят только тестовые
   пользователи).
4. **Credentials → Create Credentials → OAuth client ID**:
   - тип *Web application*;
   - Authorized redirect URIs: `http://localhost:3000/api/auth/callback`
     (для продакшена — `https://ваш-домен/api/auth/callback`).
5. Скопируйте Client ID и Client secret в `.env.local`.

### 2. СДЭК

1. Получите учётную запись интеграции (client ID / client secret) в личном
   кабинете СДЭК (раздел «Интеграция» / API).
2. Впишите в `.env.local` как `CDEK_CLIENT_ID` и `CDEK_CLIENT_SECRET`.
3. Для экспериментов есть тестовый контур: задайте
   `CDEK_API_URL=https://api.edu.cdek.ru/v2` и тестовые креды из документации
   СДЭК. По умолчанию используется боевой `https://api.cdek.ru/v2`.

### 3. Переменные окружения (`.env.local`)

Образец — [.env.local.example](.env.local.example):

| Переменная | Что это |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth-клиент из Google Cloud |
| `GOOGLE_SHEET_ID` | ID таблицы (часть URL между `/d/` и `/edit`): `1-2AAZS4JuPzb28ydu7YtlF0kTJPZ0Sw7Z4oLZf_-oVM` |
| `NEXTAUTH_SECRET` | Случайная строка — ключ шифрования сессии |
| `NEXTAUTH_URL` | Базовый URL приложения (`http://localhost:3000` локально) |
| `CDEK_CLIENT_ID` / `CDEK_CLIENT_SECRET` | Учётка интеграции СДЭК |
| `CDEK_API_URL` | Необязательно; по умолчанию боевой контур |
| `DELLIN_APP_KEY` / `DELLIN_PAT` | Учётка API Деловых Линий (только сервер) |
| `DELLIN_API_URL` | Необязательно; по умолчанию `https://api.dellin.ru` |

Не используются (удалите, если остались): `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
`GOOGLE_PRIVATE_KEY`.

### 4. Доступ менеджера

1. Владелец таблицы: «Поделиться» → добавить Google-аккаунт менеджера
   (роль «Читатель» достаточна).
2. При External consent screen — добавить его же в Test users.
3. Менеджер входит через Google — и работает.

## Запуск

```bash
npm install
npm run dev      # http://localhost:3000
```

Продакшен: `npm run build && npm start`. После изменения `.env.local`
перезапустите сервер.

## Страницы

| Адрес | Что показывает |
|---|---|
| `/` | Вход → калькулятор (поиск товара, позиции, упаковочные места, итоги, доставка, тарифы СДЭК) либо «Нет доступа к таблице» |
| `/admin/google-sheets-check` | Диагностика: кто вошёл, есть ли доступ, метаданные, листы, первые строки, шапки, предупреждения |
| `/admin/data-quality` | Качество данных: количество товаров, полнота ДШВ/веса, правила упаковки, дубли артикулов, проблемные строки, подозрительные значения |

## Структура таблицы (не меняется приложением)

Парсер сам находит блоки по шапкам на всех листах:

- **Справочник**: Артикул, Наименование, Длина/Ширина/Высота (см), Вес брутто
  (кг) — блок без колонки количества.
- **Групповая упаковка**: те же колонки + «Количество в упаковке, шт».
- **Расчётные/тестовые блоки** (Место, Откуда, Куда, Тариф, Стоимость, ИТОГО)
  распознаются и пропускаются — источником справочника не являются.

Несколько блоков на одном листе поддерживаются. Все проблемы данных (дубли,
пустые значения, нечисловые ячейки, подозрительные величины) не ломают работу,
а отображаются на странице `/admin/data-quality`.

## Деплой на VPS (Ubuntu)

Ниже — минимальный сценарий: Node.js + systemd + nginx с HTTPS.

### 1. Подготовка сервера (один раз)

```bash
# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git

# пользователь для приложения
sudo adduser --system --group --home /opt/calc_sdek deploy
```

### 2. Код и переменные окружения

```bash
sudo -u deploy git clone https://github.com/ropuwz-dot/calc_sdek.git /opt/calc_sdek
cd /opt/calc_sdek
sudo -u deploy npm ci
sudo -u deploy cp .env.local.example .env.local
sudo -u deploy nano .env.local     # заполнить реальными значениями
sudo chmod 600 .env.local          # секреты читает только владелец
```

Отличия production-значений в `.env.local`:

- `NEXTAUTH_URL=https://ваш-домен` — реальный адрес приложения;
- новый `NEXTAUTH_SECRET` (не переносите с локальной машины): `openssl rand -base64 32`;
- остальное — как локально.

Также в Google Cloud Console → ваш OAuth-клиент → **Authorized redirect URIs**
добавьте `https://ваш-домен/api/auth/callback` — без этого вход на сервере
не заработает (`redirect_uri_mismatch`).

### 3. Сборка и systemd

```bash
sudo -u deploy npm run build
sudo cp deploy/cdek-calculator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cdek-calculator
systemctl status cdek-calculator   # должен быть active (running)
```

### 4. nginx + HTTPS

```bash
sudo cp deploy/nginx-example.conf /etc/nginx/sites-available/cdek-calculator
sudo nano /etc/nginx/sites-available/cdek-calculator   # вписать домен
sudo ln -s /etc/nginx/sites-available/cdek-calculator /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# сертификат Let's Encrypt
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ваш-домен
```

⚠️ **HTTPS обязателен**: в production сессионная cookie ставится с флагом
`Secure`, по «голому» http вход работать не будет.

### 5. Обновление версии

```bash
cd /opt/calc_sdek
sudo -u deploy git pull
sudo -u deploy npm ci
sudo -u deploy npm run build
sudo systemctl restart cdek-calculator
```

### Чек-лист после деплоя

1. `https://домен` открывается, есть кнопка «Войти через Google».
2. Вход работает, `/admin/google-sheets-check` показывает доступ к таблице.
3. `/admin/data-quality` читает справочник.
4. Расчёт доставки возвращает тарифы СДЭК.

## Структура проекта

```
app/
  page.tsx                       — вход / нет доступа / калькулятор
  admin/google-sheets-check/     — диагностика доступа текущего пользователя
  admin/data-quality/            — отчёт качества данных справочника
  api/auth/{signin,callback,signout} — Google OAuth
  api/products/search            — поиск товара (гвард: сессия + доступ к таблице)
  api/pack                       — расчёт упаковочных мест
  api/locations                  — подсказки городов СДЭК
  api/quote                      — полный расчёт: таблица → упаковка → СДЭК
components/
  Calculator.tsx                 — UI калькулятора (client component)
  UserBar.tsx                    — email пользователя + выход
lib/
  session.ts                     — шифрованная сессия (httpOnly cookie)
  googleAuth.ts                  — OAuth: вход, обмен кода, продление токена
  googleSheets.ts                — чтение таблицы токеном пользователя
  catalog.ts                     — адаптивный парсер справочника + качество данных
  packing.ts                     — модуль упаковки (чистая логика)
  cdek.ts                        — СДЭК: токен с кэшем, города, тарифы
  apiAuth.ts                     — гвард API: сессия → токен → доступ к таблице
  types.ts                       — общие типы API (без секретов)
```
