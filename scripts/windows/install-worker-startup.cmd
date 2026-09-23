@echo off
rem Cria um atalho na pasta Inicializar do Windows para abrir o worker (minimizado) ao fazer login.
set "TARGET=%~dp0start-worker.cmd"
set "WORKDIR=%~dp0..\.."

powershell -NoProfile -ExecutionPolicy Bypass -Command "$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup') + '\bot-anuncios worker.lnk'); $shortcut.TargetPath = $env:TARGET; $shortcut.WorkingDirectory = $env:WORKDIR; $shortcut.WindowStyle = 7; $shortcut.Save()"

if errorlevel 1 (
  echo Falha ao criar o atalho.
) else (
  echo Atalho "bot-anuncios worker" criado na pasta Inicializar.
  echo O worker vai abrir minimizado sempre que voce entrar no Windows.
  echo Para remover: Win+R, digite shell:startup e apague o atalho.
)
pause
