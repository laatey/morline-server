// Docker image references come from users and end up on a `docker pull` / `docker run`
// command line, so they are validated strictly: no leading dash, no whitespace, no shell
// metacharacters, and a shape that matches registry/repository[:tag][@digest].

const REF = /^[a-z0-9][a-z0-9._-]*(?::[0-9]{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
// A registry host with a port ("localhost:5000/app") also has a colon; REF handles it by allowing
// the port on the first path segment, so the tag group only matches after the last slash.

export function isValidImageRef(ref) {
  return typeof ref === 'string' && ref.length <= 255 && !ref.startsWith('-') && REF.test(ref);
}

/** "ghcr.io/acme/billing-api:1.2" -> "billing-api"; "redis" -> "redis". */
export function defaultNameFromImage(ref) {
  const last = String(ref || '').split('@')[0].split('/').pop() || 'service';
  const name = last.split(':')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return name || 'service';
}
