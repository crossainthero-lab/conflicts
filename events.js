function decodeHtmlEntities(text) {
  return text
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripHtml(text) {
  return decodeHtmlEntities(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function severityScore(text) {
  const haystack = text.toLowerCase();
  if (/(killed|dead|fatal|missile|airstrike|bombing|explosion)/.test(haystack)) return 5;
  if (/(drone|shelling|strike|attack|raid|blast|retaliation)/.test(haystack)) return 4;
  if (/(clash|troop|military|intercept|deployment|warning)/.test(haystack)) return 3;
  if (/(aid|ceasefire|evacuation|humanitarian|talks)/.test(haystack)) return 2;
  return 1;
}

function confidenceFromLocation(location, title, description) {
  if (!location) return 1;

  const combined = `${title} ${description}`.toLowerCase();
  const hits = location.keywords.reduce((count, keyword) => {
    return combined.includes(keyword.toLowerCase()) ? count + 1 : count;
  }, 0);

  if (location.exactness === "exact") {
    return hits >= 2 ? 5 : 4;
  }

  return hits >= 2 ? 3 : 2;
}

function parseXmlTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? decodeHtmlEntities(match[1].trim()) : "";
}

function parseRssItems(xmlText) {
  return [...xmlText.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const block = match[1];
    return {
      title: parseXmlTag(block, "title"),
      link: parseXmlTag(block, "link"),
      description: parseXmlTag(block, "description"),
      pubDate: parseXmlTag(block, "pubDate")
    };
  });
}

function parsePublishedAt(pubDate) {
  const timestamp = Date.parse(pubDate || "");
  return Number.isNaN(timestamp) ? null : timestamp;
}

function filterRecentItems(items, maxAgeHours) {
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();

  return items
    .map((item) => ({
      ...item,
      _publishedAt: parsePublishedAt(item.pubDate)
    }))
    .filter((item) => item._publishedAt && now - item._publishedAt <= maxAgeMs)
    .sort((a, b) => b._publishedAt - a._publishedAt);
}

function normalizeGdeltDate(seenDate) {
  const raw = `${seenDate || ""}`.replace(/\D/g, "");
  if (raw.length < 14) {
    return null;
  }

  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`;
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? null : timestamp;
}

async function fetchGdeltDoc(query, timespan) {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "50");
  url.searchParams.set("sort", "datedesc");
  url.searchParams.set("timespan", timespan);

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "WorldConflictUpdate/1.0 (+https://world-conflict-update.pages.dev)"
    }
  });

  if (!response.ok) {
    throw new Error(`GDELT DOC failed: ${response.status}`);
  }

  return response.json();
}

function findLocation(text, locations) {
  const haystack = text.toLowerCase();

  for (const location of locations) {
    for (const keyword of location.keywords) {
      if (haystack.includes(keyword.toLowerCase())) {
        return location;
      }
    }
  }

  return null;
}

function deduplicateEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = `${event.title}|${event.locationName}|${event.sourceType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadStaticJson(origin, path) {
  const response = await fetch(`${origin}${path}`);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }

  return response.json();
}

async function fetchGoogleNewsRss(query) {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "en-AU");
  url.searchParams.set("gl", "AU");
  url.searchParams.set("ceid", "AU:en");

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "WorldConflictUpdate/1.0 (+https://world-conflict-update.pages.dev)"
    }
  });

  if (!response.ok) {
    throw new Error(`Google News RSS failed: ${response.status}`);
  }

  return response.text();
}

function toEvent(item, conflict, locations, index) {
  const title = item.normalizedTitle;
  const sourceLabel = item.normalizedSourceLabel;
  const description = item.normalizedDescription;
  const location =
    findLocation(`${title} ${description}`, locations) ||
    {
      name: `${conflict.title} region`,
      coords: conflict.focus.center,
      exactness: "approximate",
      keywords: []
    };

  const severity = severityScore(`${title} ${description}`);
  const confidence = confidenceFromLocation(location, title, description);

  return {
    id: `${conflict.id}-${item.sourceType}-${index}`,
    title,
    description: description.slice(0, 240),
    locationName: location.name,
    coords: location.coords,
    severity,
    confidence,
    exactness: location.exactness,
    reportedAt: item.reportedAt,
    category: severity >= 4 ? "Attack" : severity === 3 ? "Military" : "Developing",
    sourceLabel,
    sourceUrl: item.link,
    sourceType: item.sourceType
  };
}

function normalizeGoogleNewsItems(items, maxAgeHours) {
  return filterRecentItems(items, maxAgeHours).map((item) => {
    const sourceMatch = item.title.match(/^(.*) - ([^-]+)$/);
    return {
      ...item,
      normalizedTitle: sourceMatch ? sourceMatch[1].trim() : item.title,
      normalizedSourceLabel: sourceMatch ? sourceMatch[2].trim() : "Google News",
      normalizedDescription: stripHtml(item.description) || "Live article mapped from Google News RSS.",
      reportedAt: item.pubDate,
      sourceType: "google-news-rss"
    };
  });
}

function normalizeGdeltItems(payload, maxAgeHours) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();

  return articles
    .map((article) => {
      const publishedAt = normalizeGdeltDate(article.seendate || article.socialimage_timestamp || article.date);
      return {
        title: article.title || "",
        link: article.url || article.url_mobile || "",
        normalizedTitle: article.title || "",
        normalizedSourceLabel: article.domain || article.sourcecountry || "GDELT",
        normalizedDescription:
          article.snippet ||
          article.title ||
          "Live article mapped from GDELT DOC 2.0.",
        reportedAt: publishedAt ? new Date(publishedAt).toISOString() : "",
        _publishedAt: publishedAt,
        sourceType: "gdelt-doc"
      };
    })
    .filter((item) => item.normalizedTitle && item.link && item._publishedAt && now - item._publishedAt <= maxAgeMs)
    .sort((a, b) => b._publishedAt - a._publishedAt);
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const conflictId = url.searchParams.get("conflict");

  if (!conflictId) {
    return Response.json({ error: "Missing conflict parameter." }, { status: 400 });
  }

  const origin = url.origin;
  const [conflicts, locationsMap, fallbackMap] = await Promise.all([
    loadStaticJson(origin, "/data/conflicts.json"),
    loadStaticJson(origin, "/data/locations.json"),
    loadStaticJson(origin, "/data/fallback-events.json")
  ]);

  const conflict = conflicts.find((item) => item.id === conflictId);
  if (!conflict) {
    return Response.json({ error: "Unknown conflict id." }, { status: 404 });
  }

  let payload;

  try {
    const [rssText, gdeltPayload] = await Promise.all([
      fetchGoogleNewsRss(conflict.rssQuery),
      fetchGdeltDoc(conflict.gdeltQuery, conflict.gdeltTimespan || "6h")
    ]);

    const items = [
      ...normalizeGoogleNewsItems(
        parseRssItems(rssText),
        conflict.maxAgeHours || 24
      ),
      ...normalizeGdeltItems(
        gdeltPayload,
        conflict.maxAgeHours || 24
      )
    ].sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt)).slice(0, 50);

    const locations = locationsMap[conflict.id] || [];
    const events = deduplicateEvents(
      items.map((item, index) => toEvent(item, conflict, locations, index + 1))
    );

    if (!events.length) {
      throw new Error("No sufficiently recent live events were returned from the RSS feed.");
    }

    payload = {
      conflictId: conflict.id,
      sourceLabel: "Google News RSS + GDELT DOC 2.0",
      status: "live",
      refreshIntervalSeconds: conflict.refreshIntervalSeconds,
      lastFetchedAt: new Date().toISOString(),
      message: "Live events were refreshed from multiple sources and mapped onto conflict-specific locations with recency filtering.",
      events
    };
  } catch (error) {
    payload = {
      conflictId: conflict.id,
      sourceLabel: "Fallback cache",
      status: "fallback",
      refreshIntervalSeconds: conflict.refreshIntervalSeconds,
      lastFetchedAt: new Date().toISOString(),
      message: `Live refresh failed, so the app returned fallback data. ${error.message}`,
      events: fallbackMap[conflict.id] || []
    };
  }

  const response = Response.json(payload, {
    headers: {
      "Cache-Control": "no-store"
    }
  });
  return response;
}
