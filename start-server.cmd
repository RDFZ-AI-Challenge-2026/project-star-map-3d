@echo off
rem ---------------------------------------------------------------------------
rem  Start a local web server for the star map and open it in the browser.
rem  The page loads its data with fetch(), so it cannot be opened as a file://
rem  URL -- it needs to be served over http.
rem
rem  Double-click this file. Close the window (or press Ctrl+C) to stop.
rem ---------------------------------------------------------------------------
setlocal
set "PORT=8811"
set "ROOT=%~dp0"
set "SITE=%ROOT%web"

if not exist "%SITE%\index.html" (
  echo [ERROR] Cannot find "%SITE%\index.html"
  echo         Put this file in the project root, next to the "web" folder.
  pause
  exit /b 1
)

echo.
echo   Star map server
echo   ---------------------------------------------
echo   URL : http://127.0.0.1:%PORT%/
echo   Dir : %SITE%
echo.
echo   Close this window to stop the server.
echo.

start "" "http://127.0.0.1:%PORT%/"

rem tools\serve.py instead of "python -m http.server": it disables browser
rem caching, so a reload always picks up the newest style.css / main.js.
set "SERVE=%ROOT%tools\serve.py"

where python >nul 2>nul
if %errorlevel%==0 (
  python "%SERVE%" %PORT% "%SITE%"
  goto :done
)

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%SERVE%" %PORT% "%SITE%"
  goto :done
)

rem Fall back to the Python that DeepSeek Harness bundles on this machine.
set "DSHPY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if exist "%DSHPY%" (
  echo Using the Python bundled with DeepSeek Harness.
  "%DSHPY%" "%SERVE%" %PORT% "%SITE%"
  goto :done
)

echo [ERROR] No Python found. Install Python, or serve the "web" folder with
echo         any other static web server on port %PORT%.
pause

:done
endlocal
