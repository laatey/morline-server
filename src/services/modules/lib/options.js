import { EngineError } from './util.js';

const SAFE_STRING = /^[A-Za-z0-9 _.:/@-]{0,100}$/;
const DURATION = /^\d{1,4}(s|m|h|d)$/;

function coerce(moduleId, key, spec, value) {
  const bad = (why) => new EngineError(`${moduleId}: option "${key}" ${why}`, 'bad_option');
  switch (spec.type) {
    case 'int': {
      const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
      if (!Number.isInteger(n)) throw bad('must be a whole number');
      if (spec.min !== undefined && n < spec.min) throw bad(`must be at least ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) throw bad(`must be at most ${spec.max}`);
      return n;
    }
    case 'bool': {
      if (value === 'true') return true;
      if (value === 'false') return false;
      if (typeof value !== 'boolean') throw bad('must be true or false');
      return value;
    }
    case 'enum':
      if (!spec.values.includes(value)) throw bad(`must be one of: ${spec.values.join(', ')}`);
      return value;
    case 'duration':
      if (typeof value !== 'string' || !DURATION.test(value)) throw bad('must look like 15m, 1h or 7d');
      return value;
    case 'string':
      if (typeof value !== 'string' || !SAFE_STRING.test(value)) throw bad('contains characters that are not allowed');
      return value;
    default:
      throw new EngineError(`${moduleId}: option "${key}" has unknown type ${spec.type}`, 'catalog_invalid');
  }
}

/**
 * Validate model-supplied options against the module's declared schema. Values end up inside
 * generated source code, so only declared keys and strictly typed values get through.
 */
export function resolveOptions(moduleId, specs = {}, given = {}) {
  if (given === null || typeof given !== 'object' || Array.isArray(given)) throw new EngineError(`${moduleId}: options must be an object`, 'bad_option');
  for (const key of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(specs, key)) throw new EngineError(`${moduleId}: unknown option "${key}"${Object.keys(specs).length ? ` (valid: ${Object.keys(specs).join(', ')})` : ' (this module has no options)'}`, 'bad_option');
  }
  const out = {};
  for (const [key, spec] of Object.entries(specs)) {
    out[key] = coerce(moduleId, key, spec, Object.prototype.hasOwnProperty.call(given, key) ? given[key] : spec.default);
  }
  return out;
}

export const optionsMatch = (when, options) => Object.entries(when || {}).every(([k, v]) => options[k] === v);
