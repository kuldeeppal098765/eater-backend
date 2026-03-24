@echo off
echo Stopping Node processes (ignore errors if none running)...
taskkill /F /IM node.exe >nul 2>&1
cd /d "%~dp0.."
echo Prisma db push...
call npx prisma db push
if errorlevel 1 exit /b 1
echo Prisma generate...
call npx prisma generate
exit /b %ERRORLEVEL%
