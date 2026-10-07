@echo off
rem Teste controlado: regras, Chromium isolado e previa da agenda real. Nao ativa a automacao.
cd /d "%~dp0..\.."
call pnpm worker:auctions:test
if errorlevel 1 goto failure
call pnpm worker:auctions:smoke
if errorlevel 1 goto failure
call pnpm worker:auctions:setup
if errorlevel 1 goto failure
call pnpm worker:auctions:preview
if errorlevel 1 goto failure
echo.
echo Teste concluido. A previa mostra ABRIRIA apenas para salas elegiveis neste momento.
echo Para ativar: pnpm worker:auctions:enable
echo Depois mantenha start-worker.cmd aberto, ou use pnpm worker:auctions.
pause
exit /b 0
:failure
echo.
echo Teste interrompido. Confira a mensagem acima. Nenhuma ativacao foi realizada.
pause
exit /b 1
