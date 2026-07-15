@echo off
setlocal
title Continuum
cd /d "%~dp0"
echo(
echo   Continuum
echo   =========
echo(

REM --- Node is required to run at all ---
where node >nul 2>nul
if errorlevel 1 goto :noNode

REM --- First run: build the Windows capture daemon (once) ---
if exist "daemon\stage1\win-capture\target\release\continuum-capture.exe" goto :haveExe
where cargo >nul 2>nul
if errorlevel 1 goto :noCargo
echo   First run: building the capture engine ^(~1-2 min, one time^)...
cargo build --release --manifest-path daemon\stage1\win-capture\Cargo.toml
if errorlevel 1 goto :buildFail
:haveExe

REM --- First run: mic/voice dependencies (optional; skipped if Python isn't installed) ---
where python >nul 2>nul
if errorlevel 1 goto :skipPy
python -c "import faster_whisper" >nul 2>nul
if not errorlevel 1 goto :run
echo   First run: installing voice dependencies ^(one time^)...
pip install numpy sounddevice webrtcvad-wheels faster-whisper
goto :run
:skipPy
echo   [i] Python not found - voice/mic will be off. Install Python and re-run to enable it.

:run
echo(
echo   Opening Continuum in its own window ...
echo   Continuum is running. Keep this window open; close it to stop.
echo(
node bin\continuum.mjs app
goto :end

:noNode
echo   [X] Node.js is not installed.
echo       Install it from https://nodejs.org (LTS), then double-click Continuum again.
echo(
pause
goto :end

:noCargo
echo   [X] Rust is needed once to build the capture engine.
echo       Install it from https://rustup.rs, then double-click Continuum again.
echo(
pause
goto :end

:buildFail
echo   [X] The capture engine failed to build. Make sure Rust is installed (https://rustup.rs).
echo(
pause
goto :end

:end
endlocal
