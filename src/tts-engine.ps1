# Silnik mowy dla Czytnika — sterowany poleceniami JSON po stdin, zdarzenia jako JSON po stdout.
# Uruchamiany jako długożyjący proces potomny z Node (src/tts.js).
#
# UWAGA: nie używamy Register-ObjectEvent (kolejka zdarzeń PowerShell jest przetwarzana
# dopiero gdy główny wątek "oddycha", więc zdarzenia z wątków w tle czekałyby, gdy główny
# wątek blokuje się w ReadLine) ani Console.In.Peek() (niewiarygodne dla przekierowanego
# potoku). Zamiast tego osobny runspace czyta stdin linia po linii do bezpiecznej kolejki,
# a główna pętla nieblokująco odpytuje tę kolejkę oraz stan syntezatora.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName System.Speech

function Write-Event($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

try {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try { $synth.SetOutputToDefaultAudioDevice() } catch {
    # brak urządzenia audio (np. serwer CI) — mowa i tak zgłosi błąd przy próbie odtworzenia
  }
} catch {
  Write-Event @{ event = 'fatal'; message = $_.Exception.Message }
  exit 1
}

# Osobny runspace: wyłącznie blokujące czytanie stdin, linie trafiają do wspólnej kolejki.
$queue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$readerRunspace = [runspacefactory]::CreateRunspace()
$readerRunspace.Open()
$reader = [powershell]::Create()
$reader.Runspace = $readerRunspace
[void]$reader.AddScript({
  param($q)
  while ($true) {
    $l = [Console]::In.ReadLine()
    if ($null -eq $l) { $q.Enqueue('__EOF__'); break }
    $q.Enqueue($l)
  }
}).AddArgument($queue)
$readerHandle = $reader.BeginInvoke()

Write-Event @{ event = 'ready' }

$awaitingDone = $false
$cancelledFlag = $false
$eof = $false

while ($true) {
  $line = $null
  if ($queue.TryDequeue([ref]$line)) {
    if ($line -eq '__EOF__') { $eof = $true }
    elseif ($line.Trim() -ne '') {
      try {
        $cmd = $line | ConvertFrom-Json
      } catch {
        Write-Event @{ event = 'error'; message = "nieprawidłowe polecenie JSON: $($_.Exception.Message)" }
        $cmd = $null
      }
      if ($cmd) {
        switch ($cmd.cmd) {
          'listVoices' {
            $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
              $vi = $_.VoiceInfo
              [PSCustomObject]@{ name = $vi.Name; culture = $vi.Culture.Name; gender = $vi.Gender.ToString() }
            })
            Write-Event @{ event = 'voices'; voices = $voices }
          }
          'setVoice' {
            if ($cmd.voice) {
              try { $synth.SelectVoice($cmd.voice) }
              catch { Write-Event @{ event = 'error'; message = "Nie można ustawić głosu: $($_.Exception.Message)" } }
            }
          }
          'setRate' { if ($null -ne $cmd.rate) { $synth.Rate = [int]$cmd.rate } }
          'setVolume' { if ($null -ne $cmd.volume) { $synth.Volume = [int]$cmd.volume } }
          'speak' {
            $cancelledFlag = $false
            try {
              $synth.SpeakAsyncCancelAll()
              $synth.SpeakAsync([string]$cmd.text) | Out-Null
              $awaitingDone = $true
            } catch {
              Write-Event @{ event = 'done'; cancelled = $false; error = $_.Exception.Message }
            }
          }
          'pause' { $synth.Pause() }
          'resume' { $synth.Resume() }
          'stop' {
            if ($awaitingDone) { $cancelledFlag = $true }
            $synth.SpeakAsyncCancelAll()
          }
          'quit' { $synth.SpeakAsyncCancelAll(); $eof = $true }
          default { Write-Event @{ event = 'error'; message = "nieznane polecenie: $($cmd.cmd)" } }
        }
      }
    }
    continue # sprawdź kolejkę ponownie od razu, bez usypiania
  }

  if ($awaitingDone -and $synth.State -eq [System.Speech.Synthesis.SynthesizerState]::Ready) {
    Write-Event @{ event = 'done'; cancelled = $cancelledFlag; error = $null }
    $awaitingDone = $false
    $cancelledFlag = $false
  }

  if ($eof -and -not $awaitingDone) { break }

  Start-Sleep -Milliseconds 20
}

try { $reader.Stop() } catch { }
try { $reader.Dispose() } catch { }
try { $readerRunspace.Close() } catch { }
