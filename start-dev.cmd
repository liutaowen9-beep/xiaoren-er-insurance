@echo off
setlocal
set "MOYU_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%MOYU_NODE%" goto node_ready
set "MOYU_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined MOYU_NODE set "MOYU_NODE=%%N"
if defined MOYU_NODE goto node_ready
echo Node.js was not found. Please install Node.js 20.9 or newer.
exit /b 1

:node_ready
for %%N in ("%MOYU_NODE%") do set "PATH=%%~dpN;%PATH%"
if not exist "%~dp0node_modules\next\dist\bin\next" (
  echo Project dependencies are missing. Please run pnpm install first.
  exit /b 1
)
pushd "%~dp0"
"%MOYU_NODE%" "%~dp0scripts\run-v7.mjs" dev %*
set "MOYU_EXIT=%ERRORLEVEL%"
popd
exit /b %MOYU_EXIT%
