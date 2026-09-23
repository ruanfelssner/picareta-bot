@echo off
rem Inicia o worker do bot-anuncios (buscas do Marketplace e comandos do WhatsApp).
rem Se o processo cair, reinicia sozinho. Feche esta janela para parar o worker.
title bot-anuncios worker
cd /d "%~dp0..\.."

:loop
echo [%date% %time%] Iniciando pnpm worker...
call pnpm worker
echo [%date% %time%] Worker encerrado (codigo %errorlevel%). Reiniciando em 15s...
timeout /t 15 /nobreak >nul
goto loop
