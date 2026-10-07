@echo off
rem Inicia Marketplace, WhatsApp e agenda de leiloes com favoritos (quando ativada).
rem Se o processo cair, reinicia sozinho. Feche esta janela para parar o worker.
title bot-anuncios worker
cd /d "%~dp0..\.."

:loop
echo [%date% %time%] Iniciando pnpm worker...
call pnpm worker
echo [%date% %time%] Worker encerrado (codigo %errorlevel%). Reiniciando em 15s...
timeout /t 15 /nobreak >nul
goto loop
