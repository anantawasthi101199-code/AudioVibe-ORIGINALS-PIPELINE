' Launch the release check with no console window.
'
' WHY A SHIM AT ALL. Task Scheduler running cmd.exe under an interactive logon
' flashes a black window on screen every time it fires. Ninety-six times a day
' that is not a cosmetic complaint, it is the reason somebody turns the task
' off - and a release job that has been turned off is exactly the failure this
' whole thing exists to prevent.
'
' The alternative is running the task as "whether user is logged on or not",
' which runs in session 0 with no window at all. That needs a stored Windows
' password, which is not a thing to hand to a scheduled task for this.
'
' 0 = hidden window, False = do not wait for it to finish.
CreateObject("WScript.Shell").Run _
  """" & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\release.cmd""", 0, False
