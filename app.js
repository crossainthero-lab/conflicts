const tabsRoot = document.getElementById("conflictTabs");
const eventList = document.getElementById("eventList");
const eventCount = document.getElementById("eventCount");
const searchInput = document.getElementById("searchInput");
const severityInput = document.getElementById("severityInput");
const severityValue = document.getElementById("severityValue");
const confidenceInput = document.getElementById("confidenceInput");
const confidenceValue = document.getElementById("confidenceValue");
const refreshButton = document.getElementById("refreshButton");
const activeConflictTitle = document.getElementById("activeConflictTitle");
const activeConflictSummary = document.getElementById("activeConflictSummary");
const eventCardTemplate = document.getElementById("eventCardTemplate");
const feedBadge = document.getElementById("feedBadge");
const feedMessage = document.getElementById("feedMessage");
const feedDetail = document.getElementById("feedDetail");
const sourceMeta = document.getElementById("sourceMeta");
const refreshMeta = document.getElementById("refreshMeta");

let conflicts = [];
let activeConflictId = "";
let activeFeed = null;
let markers = [];
let markerLookup = new Map();
let map;
let tileLayer;
let autoRefreshTimer;

function setFeedState(state, message, detail = "") {
  feedBadge.className = `debug-badge debug-badge-${state}`;
  feedBadge.textContent =
    state === "ok" ? "Live" : state === "error" ? "Fallback" : "Loading";
  feedMessage.textContent = message;
  feedDetail.textContent = detail;
}

function severityColor(level) {
  if (level >= 5) return "#ff857d";
  if (level === 4) return "#ffb36d";
  if (level === 3) return "#ffd86d";
  if (level === 2) return "#87e4c2";
  return "#7db7ff";
}

function confidenceColor(level) {
  if (level >= 5) return "#7df9c7";
  if (level === 4) return "#90f0df";
  if (level === 3) return "#80caff";
  if (level === 2) return "#ffc46b";
  return "#ff857d";
}

function formatTime(isoString) {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(isoString));
}

function getActiveConflict() {
  return conflicts.find((conflict) => conflict.id === activeConflictId);
}

function getFilteredEvents() {
  const query = searchInput.value.trim().toLowerCase();
  const minimumSeverity = Number(severityInput.value);
  const minimumConfidence = Number(confidenceInput.value);
  const events = activeFeed?.events || [];

  return events.filter((event) => {
    const haystack = `${event.title} ${event.description} ${event.locationName} ${event.category}`
      .toLowerCase();

    return (
      (!query || haystack.includes(query)) &&
      event.severity >= minimumSeverity &&
      event.confidence >= minimumConfidence
    );
  });
}

function buildPopup(event) {
  return `
    <div>
      <h3 class="popup-title">${event.title}</h3>
      <p class="popup-copy">${event.description}</p>
      <p class="popup-copy"><strong>${event.locationName}</strong> | Severity ${event.severity}/5 | Confidence ${event.confidence}/5</p>
      <p class="popup-copy">${event.exactness === "exact" ? "Exact marker" : "Approximate marker"} | ${event.category}</p>
      <p class="popup-copy">${formatTime(event.reportedAt)}</p>
      <a class="popup-source" href="${event.sourceUrl}" target="_blank" rel="noreferrer">
        ${event.sourceLabel}
      </a>
    </div>
  `;
}

function getEventSymbol(event) {
  const text = `${event.title} ${event.description} ${event.category}`.toLowerCase();

  if (/drone|uav/.test(text)) {
    return { type: "drone", label: "UAV" };
  }

  if (/bomb|missile|airstrike|strike|explosion|blast|rocket/.test(text)) {
    return { type: "bombing", label: "BMB" };
  }

  if (/gun|shooting|combat|clash|fighting|firefight|troop|raid/.test(text)) {
    return { type: "combat", label: "GUN" };
  }

  return { type: "news", label: "DOC" };
}

function buildClusterPopup(group) {
  const items = group.events
    .map((event) => {
      return `
        <article class="cluster-item">
          <strong>${event.title}</strong>
          <span>${formatTime(event.reportedAt)} | Confidence ${event.confidence}/5</span>
          <a href="${event.sourceUrl}" target="_blank" rel="noreferrer">${event.sourceLabel}</a>
        </article>
      `;
    })
    .join("");

  return `
    <div>
      <h3 class="popup-title">${group.events.length} ${group.symbol.label} Events</h3>
      <p class="popup-copy"><strong>${group.locationName}</strong></p>
      <div class="cluster-list">${items}</div>
    </div>
  `;
}

function clearMarkers() {
  markers.forEach((marker) => marker.remove());
  markers = [];
  markerLookup = new Map();
}

function buildMarkerGroups(events) {
  const eventGroups = new Map();
  const groups = [];

  events.forEach((event) => {
    const symbol = getEventSymbol(event);
    const coordKey = `${event.coords[0].toFixed(4)},${event.coords[1].toFixed(4)}`;
    const groupKey = `${coordKey}-${symbol.type}`;
    const group = eventGroups.get(groupKey) || {
      id: `${symbol.type}-${coordKey}`,
      type: "cluster",
      coords: event.coords,
      locationName: event.locationName,
      symbol,
      events: []
    };

    group.events.push(event);
    eventGroups.set(groupKey, group);
  });

  eventGroups.forEach((group) => {
    if (group.events.length === 1) {
      const event = group.events[0];
      groups.push({
        id: event.id,
        type: "single",
        coords: event.coords,
        event,
        events: [event],
        symbol: getEventSymbol(event)
      });
      return;
    }

    groups.push(group);
  });

  return groups;
}

function getSpreadCoords(groups) {
  const grouped = new Map();
  const spread = new Map();

  groups.forEach((group) => {
    const key = `${group.coords[0].toFixed(4)},${group.coords[1].toFixed(4)}`;
    const bucket = grouped.get(key) || [];
    bucket.push(group);
    grouped.set(key, bucket);
  });

  grouped.forEach((bucket) => {
    if (bucket.length === 1) {
      spread.set(bucket[0].id, bucket[0].coords);
      return;
    }

    bucket.forEach((group, index) => {
      const angle = (Math.PI * 2 * index) / bucket.length;
      const radius = group.type === "cluster" ? 0.18 : 0.12;
      const adjusted = [
        group.coords[0] + Math.sin(angle) * radius,
        group.coords[1] + Math.cos(angle) * radius
      ];
      spread.set(group.id, adjusted);
    });
  });

  return spread;
}

function renderMarkers(events) {
  clearMarkers();
  const groups = buildMarkerGroups(events);
  const spreadCoords = getSpreadCoords(groups);

  groups.forEach((group) => {
    const markerPosition = spreadCoords.get(group.id) || group.coords;
    const symbol =
      group.type === "cluster"
        ? { type: `${group.symbol.type} cluster`, label: `${group.events.length} ${group.symbol.label}` }
        : group.symbol;

    const marker = L.marker(markerPosition, {
      icon: L.divIcon({
        className: "",
        html: `<div class="tactical-marker ${symbol.type} ${group.events[0].exactness === "approximate" ? "approximate" : ""}"><span>${symbol.label}</span></div>`,
        iconSize: group.type === "cluster" ? [52, 52] : [34, 34],
        iconAnchor: group.type === "cluster" ? [26, 26] : [17, 17]
      })
    })
      .addTo(map)
      .bindPopup(group.type === "cluster" ? buildClusterPopup(group) : buildPopup(group.event));

    markers.push(marker);
    group.events.forEach((event) => markerLookup.set(event.id, marker));
  });
}

function renderEventList(events) {
  eventList.innerHTML = "";
  eventCount.textContent = String(events.length);

  if (!events.length) {
    eventList.innerHTML =
      '<p class="event-description">No live events match the current search, severity, and confidence filters.</p>';
    return;
  }

  events
    .slice()
    .sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt))
    .forEach((event) => {
      const fragment = eventCardTemplate.content.cloneNode(true);
      const severityPill = fragment.querySelector(".severity-pill");
      const confidencePill = fragment.querySelector(".confidence-pill");
      const title = fragment.querySelector("h3");
      const description = fragment.querySelector(".event-description");
      const location = fragment.querySelector(".event-location");
      const tags = fragment.querySelector(".event-tags");
      const jumpButton = fragment.querySelector(".jump-button");
      const eventLink = fragment.querySelector(".event-link");

      severityPill.textContent = `Severity ${event.severity}/5`;
      severityPill.style.background = `${severityColor(event.severity)}22`;
      severityPill.style.color = severityColor(event.severity);

      confidencePill.textContent = `Confidence ${event.confidence}/5`;
      confidencePill.style.background = `${confidenceColor(event.confidence)}22`;
      confidencePill.style.color = confidenceColor(event.confidence);

      title.textContent = event.title;
      description.textContent = event.description;
      location.textContent = `${event.locationName} | ${formatTime(event.reportedAt)}`;

      [
        getEventSymbol(event).label,
        event.category,
        event.exactness === "exact" ? "Exact" : "Approximate",
        event.sourceType || "live-source"
      ].forEach((tagText) => {
        const tag = document.createElement("span");
        tag.className = "tag-pill";
        tag.textContent = tagText;
        tags.appendChild(tag);
      });

      jumpButton.addEventListener("click", () => {
        map.flyTo(event.coords, event.exactness === "exact" ? 9 : 7, { duration: 0.8 });
        const selectedMarker = markerLookup.get(event.id);

        if (selectedMarker) {
          selectedMarker.openPopup();
        }
      });

      eventLink.href = event.sourceUrl;
      eventLink.textContent = `Source: ${event.sourceLabel}`;
      eventList.appendChild(fragment);
    });
}

function renderTabs() {
  tabsRoot.innerHTML = "";

  conflicts.forEach((conflict) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conflict-tab";
    button.textContent = conflict.title;

    if (conflict.id === activeConflictId) {
      button.classList.add("active");
    }

    button.addEventListener("click", async () => {
      activeConflictId = conflict.id;
      renderTabs();
      await loadFeed(true);
    });

    tabsRoot.appendChild(button);
  });
}

function updateView(focusMap = false) {
  const activeConflict = getActiveConflict();
  const events = getFilteredEvents();

  activeConflictTitle.textContent = activeConflict?.title || "WorldConflictUpdate";
  activeConflictSummary.textContent = activeConflict?.summary || "";
  severityValue.textContent = `${severityInput.value}+`;
  confidenceValue.textContent = `${confidenceInput.value}+`;

  if (activeFeed) {
    sourceMeta.textContent = `Source: ${activeFeed.sourceLabel}`;
    refreshMeta.textContent = `Auto refresh: every ${Math.round(
      (activeFeed.refreshIntervalSeconds || 600) / 60
    )} min`;
  }

  renderMarkers(events);
  renderEventList(events);

  if (focusMap && activeConflict) {
    map.flyTo(activeConflict.focus.center, activeConflict.focus.zoom, {
      duration: 1.1
    });
  }
}

async function loadConflicts() {
  const response = await fetch("./api/conflicts");
  if (!response.ok) {
    throw new Error(`Failed to load conflicts: ${response.status}`);
  }

  conflicts = await response.json();
  activeConflictId = conflicts[0]?.id || "";
  renderTabs();
}

async function loadFeed(focusMap = false) {
  if (!activeConflictId) {
    return;
  }

  setFeedState("pending", "Refreshing live incident feed from localhost backend.");

  try {
    const response = await fetch(`./api/events?conflict=${encodeURIComponent(activeConflictId)}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Feed request failed: ${response.status}`);
    }

    activeFeed = await response.json();

    setFeedState(
      activeFeed.status === "live" ? "ok" : "error",
      activeFeed.status === "live"
        ? "Live conflict feed loaded."
        : "Showing fallback data because live ingestion failed.",
      activeFeed.message || ""
    );

    updateView(focusMap);
    scheduleAutoRefresh();
  } catch (error) {
    setFeedState(
      "error",
      "Unable to reach the localhost feed endpoint.",
      error.message
    );
  }
}

function scheduleAutoRefresh() {
  window.clearTimeout(autoRefreshTimer);
  const intervalMs = (activeFeed?.refreshIntervalSeconds || 600) * 1000;
  autoRefreshTimer = window.setTimeout(() => {
    loadFeed(false);
  }, intervalMs);
}

function initializeMap() {
  if (!window.L) {
    setFeedState(
      "error",
      "Leaflet did not load.",
      "Start the app through localhost so the browser can load remote dependencies cleanly."
    );
    return false;
  }

  map = L.map("map", {
    zoomControl: false,
    worldCopyJump: true
  }).setView([20, 10], 2);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  tileLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(map);

  tileLayer.on("tileerror", () => {
    setFeedState(
      "error",
      "Map tiles failed to load.",
      "Make sure you are opening the app through http://localhost:8080 instead of file://."
    );
  });

  return true;
}

searchInput.addEventListener("input", () => updateView());
severityInput.addEventListener("input", () => updateView());
confidenceInput.addEventListener("input", () => updateView());
refreshButton.addEventListener("click", () => loadFeed(false));

setFeedState("pending", "Booting localhost app.");

if (initializeMap()) {
  loadConflicts()
    .then(() => loadFeed(true))
    .catch((error) => {
      setFeedState("error", "Failed to load app configuration.", error.message);
    });
}
