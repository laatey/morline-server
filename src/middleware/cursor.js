export function encodeCursor(payload) {
  if (payload === null || payload === undefined) return null;
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursorStr) {
  if (!cursorStr) return null;
  try {
    const json = Buffer.from(cursorStr, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}
