$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host 'Подготавливаю бесплатный хостинг Zevgram…' -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить компоненты публикации.' }

Write-Host 'Откроется Cloudflare для безопасного входа в аккаунт.' -ForegroundColor Cyan
npx wrangler login
if ($LASTEXITCODE -ne 0) { throw 'Вход в Cloudflare не завершён.' }

Write-Host 'Создаю сайт и общую базу данных…' -ForegroundColor Cyan
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw 'Не удалось опубликовать сайт.' }

Write-Host 'Настраиваю таблицы для профилей, публикаций и сообщений…' -ForegroundColor Cyan
npx wrangler d1 execute zevgram-db --remote --file=./schema.sql
if ($LASTEXITCODE -ne 0) { throw 'Не удалось подготовить базу данных.' }

Write-Host 'Завершаю публикацию…' -ForegroundColor Cyan
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw 'Не удалось завершить публикацию.' }
Write-Host 'Готово. Ссылка на сайт показана выше; её можно вставить в кнопку бота.' -ForegroundColor Green

