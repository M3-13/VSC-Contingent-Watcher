/**
 * Maps a GitHub host to its REST API base URL.
 * - github.com            → https://api.github.com
 * - <tenant>.ghe.com      → https://api.<tenant>.ghe.com   (data residency)
 * - other (GHE Server)    → https://<host>/api/v3
 */
export function apiBaseForHost(host: string): string {
  const h = host.toLowerCase().replace(/^api\./, '');
  if (h === 'github.com') {
    return 'https://api.github.com';
  }
  if (h.endsWith('.ghe.com')) {
    return `https://api.${h}`;
  }
  return `https://${h}/api/v3`;
}
