Option Explicit

Dim shell
Dim scriptDir
Dim runnerScript
Dim command

Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
runnerScript = scriptDir & "\run-gamecult-orchestrator.ps1"

command = QuoteArg(shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"))
command = command & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & QuoteArg(runnerScript)

shell.Run command, 0, False

Function QuoteArg(value)
  QuoteArg = """" & Replace(value, """", """""") & """"
End Function
