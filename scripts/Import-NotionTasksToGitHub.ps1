param(
  [string]$Repository = 'GoetschiM/rabenblut-studio',
  [string]$DatabaseId = '3b99b1ad-98d6-49c9-8c6d-7c31e1469597',
  [string]$DataSourceId = 'dd4f2c06-a322-4304-897d-6e820caf251c'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:NOTION_TOKEN)) {
  throw 'NOTION_TOKEN fehlt. Vor dem Import nur für diese Sitzung als Umgebungsvariable setzen.'
}

function Join-PlainText($items) {
  return (@($items | ForEach-Object { $_.plain_text }) -join '').Trim()
}

function Label-Name($value) {
  return ($value.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
}

$headers = @{
  Authorization = "Bearer $($env:NOTION_TOKEN)"
  'Notion-Version' = '2025-09-03'
  'Content-Type' = 'application/json'
}

$pages = @()
$cursor = $null
do {
  $query = @{ page_size = 100 }
  if ($cursor) { $query.start_cursor = $cursor }
  $response = Invoke-RestMethod -Method Post -Uri "https://api.notion.com/v1/data_sources/$DataSourceId/query" -Headers $headers -Body ($query | ConvertTo-Json -Compress)
  $pages += @($response.results)
  $cursor = if ($response.has_more) { $response.next_cursor } else { $null }
} while ($cursor)

$tasks = foreach ($page in $pages) {
  $properties = $page.properties
  [PSCustomObject]@{
    Id       = $page.id
    Url      = $page.url
    Title    = Join-PlainText $properties.'Aufgabenbezeichnung'.title
    Status   = $properties.Status.status.name
    Priority = $properties.Priorität.select.name
    Areas    = @($properties.Bereich.multi_select | ForEach-Object { $_.name })
    ParentId = @($properties.'Übergeordnete Aufgabe'.relation | Select-Object -First 1 | ForEach-Object { $_.id })[0]
  }
}

$titleById = @{}
foreach ($task in $tasks) { $titleById[$task.Id] = $task.Title }

$labelDefinitions = @{
  'source:notion'      = @{ Color = '5319e7'; Description = 'Aus dem Goetschi-Labs-Notion-Backlog importiert' }
  'status:todo'        = @{ Color = 'd4c5f9'; Description = 'Noch nicht begonnen' }
  'status:in-progress' = @{ Color = 'fbca04'; Description = 'In Bearbeitung' }
  'status:done'        = @{ Color = '0e8a16'; Description = 'In Notion bereits erledigt' }
  'priority:critical'  = @{ Color = 'b60205'; Description = 'Kritisch' }
  'priority:important' = @{ Color = 'd93f0b'; Description = 'Wichtig' }
  'priority:later'     = @{ Color = 'c2e0c6'; Description = 'Später' }
  'priority:clarified' = @{ Color = 'bfdadc'; Description = 'Geklärt' }
}

foreach ($area in ($tasks.Areas | Sort-Object -Unique)) {
  if ($area) {
    $label = "area:$(Label-Name $area)"
    $labelDefinitions[$label] = @{ Color = '1d76db'; Description = "Bereich: $area" }
  }
}

$existingLabels = @(& gh label list --repo $Repository --limit 1000 --json name | ConvertFrom-Json | ForEach-Object { $_.name })
foreach ($entry in $labelDefinitions.GetEnumerator()) {
  if ($existingLabels -notcontains $entry.Key) {
    & gh label create $entry.Key --repo $Repository --color $entry.Value.Color --description $entry.Value.Description | Out-Null
  }
}

$existingIssues = @(& gh issue list --repo $Repository --state all --limit 1000 --json number,body,state | ConvertFrom-Json)
$issueByNotionId = @{}
foreach ($issue in $existingIssues) {
  if ($issue.body -match '<!-- framecut-notion-task:([0-9a-f-]+) -->') {
    $issueByNotionId[$Matches[1]] = $issue
  }
}

$summary = [System.Collections.Generic.List[object]]::new()
foreach ($task in $tasks) {
  if ([string]::IsNullOrWhiteSpace($task.Title)) { continue }

  $labels = [System.Collections.Generic.List[string]]::new()
  $labels.Add('source:notion')
  switch ($task.Status) {
    'Erledigt'       { $labels.Add('status:done') }
    'In Bearbeitung' { $labels.Add('status:in-progress') }
    default          { $labels.Add('status:todo') }
  }
  switch ($task.Priority) {
    'Kritisch' { $labels.Add('priority:critical') }
    'Wichtig'  { $labels.Add('priority:important') }
    'Später'   { $labels.Add('priority:later') }
    'Geklärt'  { $labels.Add('priority:clarified') }
  }
  foreach ($area in $task.Areas) { if ($area) { $labels.Add("area:$(Label-Name $area)") } }

  $parentLine = if ($task.ParentId -and $titleById[$task.ParentId]) { "`n- Übergeordnete Aufgabe in Notion: $($titleById[$task.ParentId])" } else { '' }
  $body = @"
<!-- framecut-notion-task:$($task.Id) -->
## Import aus Goetschi Labs / Notion

- Quelle: $($task.Url)
- Notion-Status: $($task.Status)
- Priorität: $($task.Priority)
- Bereiche: $($task.Areas -join ', ')$parentLine

Dieser Vorgang wurde aus der zentralen FrameCut-Aufgabenliste importiert. Akzeptanzkriterien,
technische Umsetzung und Tests werden in den folgenden GitHub-Kommentaren dokumentiert.
"@

  if ($issueByNotionId.ContainsKey($task.Id)) {
    $issue = $issueByNotionId[$task.Id]
    $summary.Add([PSCustomObject]@{ Action = 'vorhanden'; Number = $issue.number; Title = $task.Title })
    continue
  }

  $arguments = @('issue', 'create', '--repo', $Repository, '--title', $task.Title, '--body', $body)
  foreach ($label in ($labels | Select-Object -Unique)) { $arguments += @('--label', $label) }
  $issueUrl = (& gh @arguments | Select-Object -Last 1).Trim()
  if ($issueUrl -notmatch '/issues/(\d+)$') { throw "GitHub-Issue konnte nicht gelesen werden: $issueUrl" }
  $number = [int]$Matches[1]
  if ($task.Status -eq 'Erledigt') {
    & gh issue close $number --repo $Repository --comment 'Beim Import war dieser Punkt in Notion bereits als erledigt markiert.' | Out-Null
  }
  $summary.Add([PSCustomObject]@{ Action = 'erstellt'; Number = $number; Title = $task.Title })
}

$summary | Sort-Object Number | Format-Table -AutoSize
Write-Host "Import abgeschlossen: $($summary.Count) Aufgaben verarbeitet."
