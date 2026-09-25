param([string]$Tag)
$procs = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    if ($p.CommandLine -and $p.CommandLine -match $Tag) { exit 9 }
}
exit 0
