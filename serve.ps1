param(
  [int]$Port = 8080
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataRoot = Join-Path $root "data"
$cacheRoot = Join-Path $dataRoot "cache"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")

if (-not (Test-Path -LiteralPath $cacheRoot)) {
  New-Item -ItemType Directory -Path $cacheRoot | Out-Null
}

$contentTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
}

function Read-JsonFile {
  param([string]$Path)
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Write-JsonResponse {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [object]$Object,
    [int]$StatusCode = 200
  )

  $payload = $Object | ConvertTo-Json -Depth 12
  $buffer = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $Response.StatusCode = $StatusCode
  $Response.ContentType = "application/json; charset=utf-8"
  $Response.ContentLength64 = $buffer.Length
  $Response.OutputStream.Write($buffer, 0, $buffer.Length)
}

function Write-TextResponse {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [string]$Text,
    [int]$StatusCode = 200
  )

  $buffer = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $Response.StatusCode = $StatusCode
  $Response.ContentType = "text/plain; charset=utf-8"
  $Response.ContentLength64 = $buffer.Length
  $Response.OutputStream.Write($buffer, 0, $buffer.Length)
}

function Get-TargetPath {
  param([string]$RequestedPath)

  $cleanPath = $RequestedPath.Split("?")[0].TrimStart("/")
  if ([string]::IsNullOrWhiteSpace($cleanPath)) {
    $cleanPath = "index.html"
  }

  $relativePath = $cleanPath -replace "/", "\"
  $candidate = Join-Path $root $relativePath

  if (-not (Test-Path -LiteralPath $candidate) -and -not [System.IO.Path]::GetExtension($candidate)) {
    $candidate = Join-Path $candidate "index.html"
  }

  return $candidate
}

function Strip-Html {
  param([string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return ""
  }

  $decoded = [System.Net.WebUtility]::HtmlDecode($Text)
  return ([regex]::Replace($decoded, "<[^>]+>", " ")).Trim()
}

function Get-RegexMatchValue {
  param(
    [string]$Text,
    [string]$Pattern
  )

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $null
  }

  $match = [regex]::Match($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($match.Success) {
    return $match.Groups[1].Value
  }

  return $null
}

function Get-PropertyValue {
  param(
    [object]$Object,
    [string[]]$Names
  )

  if ($null -eq $Object) {
    return $null
  }

  foreach ($name in $Names) {
    $property = $Object.PSObject.Properties[$name]
    if ($property -and $null -ne $property.Value -and "$($property.Value)".Trim() -ne "") {
      return $property.Value
    }
  }

  return $null
}

function Get-SeverityScore {
  param([string]$Text)

  $haystack = $Text.ToLowerInvariant()
  if ($haystack -match "killed|dead|fatal|missile|airstrike|bombing|explosion") { return 5 }
  if ($haystack -match "drone|shelling|strike|attack|raid|blast|retaliation") { return 4 }
  if ($haystack -match "clash|troop|military|intercept|deployment|warning") { return 3 }
  if ($haystack -match "aid|ceasefire|evacuation|humanitarian|talks") { return 2 }
  return 1
}

function Get-ConflictDefinition {
  param([string]$ConflictId)

  $conflicts = Read-JsonFile -Path (Join-Path $dataRoot "conflicts.json")
  return $conflicts | Where-Object { $_.id -eq $ConflictId } | Select-Object -First 1
}

function Get-FallbackFeed {
  param([object]$Conflict)

  $fallbacks = Read-JsonFile -Path (Join-Path $dataRoot "fallback-events.json")
  return [PSCustomObject]@{
    conflictId = $Conflict.id
    sourceLabel = "Fallback cache"
    status = "fallback"
    refreshIntervalSeconds = $Conflict.refreshIntervalSeconds
    lastFetchedAt = (Get-Date).ToString("o")
    message = "Live RSS ingestion was unavailable, so the app returned the local fallback cache."
    events = $fallbacks.$($Conflict.id)
  }
}

function Get-ConflictLocations {
  param([string]$ConflictId)

  $locations = Read-JsonFile -Path (Join-Path $dataRoot "locations.json")
  return $locations.$ConflictId
}

function Get-GoogleNewsRssItems {
  param([string]$Query)

  $encodedQuery = [System.Uri]::EscapeDataString($Query)
  $url = "https://news.google.com/rss/search?q=$encodedQuery&hl=en-AU&gl=AU&ceid=AU:en"
  $response = Invoke-WebRequest -Uri $url -Headers @{ "User-Agent" = "ConflictAtlasLocalhost/0.1 (+localhost)" }
  [xml]$rss = $response.Content
  return @($rss.rss.channel.item)
}

function Get-PublishedTimestamp {
  param([string]$PubDate)

  try {
    return [datetimeoffset]::Parse($PubDate).UtcDateTime
  } catch {
    return $null
  }
}

function Filter-RecentRssItems {
  param(
    [object[]]$Items,
    [int]$MaxAgeHours
  )

  $cutoff = (Get-Date).ToUniversalTime().AddHours(-1 * $MaxAgeHours)

  return $Items |
    ForEach-Object {
      $publishedAt = Get-PublishedTimestamp -PubDate ([string]$_.pubDate)
      [PSCustomObject]@{
        Item = $_
        PublishedAt = $publishedAt
      }
    } |
    Where-Object { $null -ne $_.PublishedAt -and $_.PublishedAt -ge $cutoff } |
    Sort-Object PublishedAt -Descending |
    ForEach-Object { $_.Item }
}

function Get-MatchedLocation {
  param(
    [string]$Text,
    [object[]]$Locations
  )

  $haystack = $Text.ToLowerInvariant()

  foreach ($location in $Locations) {
    foreach ($keyword in $location.keywords) {
      if ($haystack.Contains($keyword.ToLowerInvariant())) {
        return $location
      }
    }
  }

  return $null
}

function Get-ConfidenceFromLocation {
  param(
    [object]$Location,
    [string]$Title,
    [string]$Description
  )

  if ($null -eq $Location) {
    return 1
  }

  $combined = "$Title $Description".ToLowerInvariant()
  $keywordHits = 0
  foreach ($keyword in $Location.keywords) {
    if ($combined.Contains($keyword.ToLowerInvariant())) {
      $keywordHits += 1
    }
  }

  if ($Location.exactness -eq "exact") {
    if ($keywordHits -ge 2) { return 5 }
    return 4
  }

  if ($keywordHits -ge 2) { return 3 }
  return 2
}

function Convert-RssItemToEvent {
  param(
    [object]$Item,
    [object]$Conflict,
    [object[]]$Locations,
    [int]$Index
  )

  $rawTitle = [string]$Item.title
  $description = Strip-Html -Text ([string]$Item.description)
  $combinedText = "$rawTitle $description"
  $location = Get-MatchedLocation -Text $combinedText -Locations $Locations

  if ($null -eq $location) {
    $location = [PSCustomObject]@{
      name = "$($Conflict.title) region"
      coords = $Conflict.focus.center
      exactness = "approximate"
      keywords = @()
    }
  }

  $sourceLabel = "Google News"
  $title = $rawTitle
  if ($rawTitle -match "^(.*) - ([^-]+)$") {
    $title = $matches[1].Trim()
    $sourceLabel = $matches[2].Trim()
  }

  $severity = Get-SeverityScore -Text "$title $description"
  $confidence = Get-ConfidenceFromLocation -Location $location -Title $title -Description $description

  return [PSCustomObject]@{
    id = "$($Conflict.id)-rss-$Index"
    title = $title
    description = if ([string]::IsNullOrWhiteSpace($description)) { "Live article mapped from Google News RSS." } else { $description.Substring(0, [Math]::Min(240, $description.Length)) }
    locationName = $location.name
    coords = @([double]$location.coords[0], [double]$location.coords[1])
    severity = $severity
    confidence = $confidence
    exactness = $location.exactness
    reportedAt = [string]$Item.pubDate
    category = if ($severity -ge 4) { "Attack" } elseif ($severity -eq 3) { "Military" } else { "Developing" }
    sourceLabel = $sourceLabel
    sourceUrl = [string]$Item.link
    sourceType = "google-news-rss"
  }
}

function Deduplicate-Events {
  param([object[]]$Events)

  $seen = New-Object "System.Collections.Generic.HashSet[string]"
  $results = New-Object System.Collections.ArrayList

  foreach ($event in $Events) {
    $key = "$($event.title)|$($event.locationName)"
    if (-not $seen.Contains($key)) {
      [void]$seen.Add($key)
      [void]$results.Add($event)
    }
  }

  return $results
}

function Get-LiveFeed {
  param([object]$Conflict)

  $cachePath = Join-Path $cacheRoot "$($Conflict.id).json"
  if (Test-Path -LiteralPath $cachePath) {
    $cached = Read-JsonFile -Path $cachePath
    $cacheAge = (Get-Date) - [datetime]$cached.lastFetchedAt
    if ($cacheAge.TotalSeconds -lt $Conflict.refreshIntervalSeconds) {
      return $cached
    }
  }

  try {
    $locations = Get-ConflictLocations -ConflictId $Conflict.id
    $items = Filter-RecentRssItems -Items (Get-GoogleNewsRssItems -Query $Conflict.rssQuery) -MaxAgeHours $Conflict.maxAgeHours
    $events = @()
    $index = 0

    foreach ($item in $items | Select-Object -First 30) {
      $index += 1
      $events += Convert-RssItemToEvent -Item $item -Conflict $Conflict -Locations $locations -Index $index
    }

    $events = Deduplicate-Events -Events $events
    if ($events.Count -eq 0) {
      throw "No sufficiently recent live events were returned from the RSS feed."
    }

    $feed = [PSCustomObject]@{
      conflictId = $Conflict.id
      sourceLabel = "Google News RSS via localhost mapper"
      status = "live"
      refreshIntervalSeconds = $Conflict.refreshIntervalSeconds
      lastFetchedAt = (Get-Date).ToString("o")
      message = "Live events were refreshed from Google News RSS and mapped onto conflict-specific locations."
      events = $events
    }

    $feed | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $cachePath -Encoding UTF8
    return $feed
  } catch {
    if (Test-Path -LiteralPath $cachePath) {
      $cached = Read-JsonFile -Path $cachePath
      $cached.status = "fallback"
      $cached.message = "Live refresh failed, so the app is serving the most recent cached RSS dataset."
      return $cached
    }

    return Get-FallbackFeed -Conflict $Conflict
  }
}

function Handle-ApiRequest {
  param(
    [System.Net.HttpListenerContext]$Context
  )

  $path = $Context.Request.Url.AbsolutePath
  switch ($path) {
    "/api/conflicts" {
      Write-JsonResponse -Response $Context.Response -Object (Read-JsonFile -Path (Join-Path $dataRoot "conflicts.json"))
      return $true
    }
    "/api/events" {
      $conflictId = $Context.Request.QueryString["conflict"]
      if ([string]::IsNullOrWhiteSpace($conflictId)) {
        Write-JsonResponse -Response $Context.Response -Object @{ error = "Missing conflict parameter." } -StatusCode 400
        return $true
      }

      $conflict = Get-ConflictDefinition -ConflictId $conflictId
      if ($null -eq $conflict) {
        Write-JsonResponse -Response $Context.Response -Object @{ error = "Unknown conflict id." } -StatusCode 404
        return $true
      }

      Write-JsonResponse -Response $Context.Response -Object (Get-LiveFeed -Conflict $conflict)
      return $true
    }
    default {
      return $false
    }
  }
}

try {
  $listener.Start()
  Write-Host "Serving $root at http://localhost:$Port"
  Write-Host "Open http://localhost:$Port in your browser."
  Write-Host "Press Ctrl+C to stop."

  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $response = $context.Response

    try {
      if (Handle-ApiRequest -Context $context) {
        continue
      }

      $requestedPath = $context.Request.Url.AbsolutePath
      $targetPath = Get-TargetPath -RequestedPath $requestedPath
      $resolvedPath = [System.IO.Path]::GetFullPath($targetPath)

      if (-not $resolvedPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Blocked path traversal."
      }

      if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        Write-TextResponse -Response $response -Text "Not Found" -StatusCode 404
        continue
      }

      $extension = [System.IO.Path]::GetExtension($resolvedPath).ToLowerInvariant()
      $response.ContentType = $contentTypes[$extension]
      if (-not $response.ContentType) {
        $response.ContentType = "application/octet-stream"
      }

      $bytes = [System.IO.File]::ReadAllBytes($resolvedPath)
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      Write-TextResponse -Response $response -Text "Server Error: $($_.Exception.Message)" -StatusCode 500
    } finally {
      $response.OutputStream.Close()
    }
  }
} finally {
  if ($listener.IsListening) {
    $listener.Stop()
  }
  $listener.Close()
}
