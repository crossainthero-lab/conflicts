async function loadStaticJson(origin, path) {
  const response = await fetch(`${origin}${path}`);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }

  return response.json();
}

export async function onRequestGet(context) {
  const origin = new URL(context.request.url).origin;
  const conflicts = await loadStaticJson(origin, "/data/conflicts.json");

  return Response.json(conflicts, {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
