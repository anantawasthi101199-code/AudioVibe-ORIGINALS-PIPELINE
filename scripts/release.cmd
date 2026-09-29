@echo off
REM ===========================================================================
REM  Publish whatever is due, whether or not the studio is open.
REM
REM  WHY THIS EXISTS. The studio releases on a timer, but only while its
REM  process is running - so a 14:00 slot on a laptop with no terminal open is
REM  a slot that is silently missed. That happened: "Shiva's Hair and the
REM  Descent of the Ganges" sat approved for 21 Sep and went out on the 23rd,
REM  by hand, because nothing was awake to notice.
REM
REM  ONE ITEM PER RUN. The CLI publishes the single oldest due thing and says
REM  how many are left, which is deliberate: a backlog drains one every hour
REM  rather than arriving as one batch that looks nothing like a person
REM  uploading.
REM
REM  IT IGNORES FOUNDRY_RELEASE. That flag gates the studio's own timer, so the
REM  two cannot both fire on the same item. If the studio is open AND this task
REM  is on, whichever reaches a run first publishes it and the other finds
REM  nothing due.
REM
REM  EVERYTHING IT DOES GOES IN THE LOG, including the quiet runs. "Nothing
REM  due" repeated ninety-six times a day is what tells you the job is alive,
REM  and its absence is what would have answered the question above in seconds.
REM ===========================================================================

setlocal

set "REPO=C:\Users\anant\Python-Projects\AudioVibe-Foundry"
set "LOG=%REPO%\release.log"

cd /d "%REPO%" || exit /b 1

REM Keep the log from growing without end. One generation back is enough to
REM cover "what happened overnight" without ever needing to be tidied by hand.
for %%F in ("%LOG%") do if %%~zF GTR 5000000 move /y "%LOG%" "%LOG%.old" >nul 2>&1

echo.>> "%LOG%"
echo ==== %DATE% %TIME% ====>> "%LOG%"

call npm run --silent foundry -- release >> "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" echo [exit %CODE%]>> "%LOG%"
exit /b %CODE%
