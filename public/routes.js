export function threadPath(id) {
  return `/threads/${encodeURIComponent(String(id))}`;
}

export function threadIdFromPath(pathname) {
  const encoded = String(pathname).match(/^\/threads\/([^/]+)$/)?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    // A malformed percent escape is not a node ID. Let startup choose its normal
    // fallback rather than crashing the whole browser application.
    return null;
  }
}
