export type Vec3 = [number, number, number];

export interface AssetBounds {
  min: Vec3;
  max: Vec3;
}

/** A complete renderable representation, ordered from coarse to detailed. */
export interface AssetLevel {
  id: string;
  url: string;
  byteLength: number;
  estimatedGpuBytes: number;
  triangles: number;
  /** Normalized projected screen coverage at which this representation is useful. */
  minScreenCoverage: number;
}

export interface AssetManifest {
  format: 'stream3d';
  version: 1;
  /** Immutable content identity, incorporating source and compilation settings. */
  id: string;
  name: string;
  bounds: AssetBounds;
  animations: string[];
  levels: AssetLevel[];
}

export type AssetInput = AssetManifest | string;

export function defineAsset(manifest: AssetManifest): AssetManifest {
  return validateManifest(manifest);
}

export class ManifestValidationError extends TypeError {
  constructor(path: string, message: string) {
    super(`Invalid stream3d manifest at ${path}: ${message}`);
    this.name = 'ManifestValidationError';
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManifestValidationError(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ManifestValidationError(path, 'expected a non-empty string');
  }
  return value;
}

function byteCount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ManifestValidationError(path, 'expected a non-negative safe integer');
  }
  return value;
}

function vector(value: unknown, path: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 ||
      Array.from(value).some((component: unknown) => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new ManifestValidationError(path, 'expected three finite numbers');
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

/** Validate untrusted JSON and return a detached, typed manifest. */
export function validateManifest(input: unknown): AssetManifest {
  const source = record(input, '$');
  if (source.format !== 'stream3d') {
    throw new ManifestValidationError('format', 'expected "stream3d"');
  }
  if (source.version !== 1) {
    throw new ManifestValidationError('version', 'only version 1 is supported');
  }
  const bounds = record(source.bounds, 'bounds');
  const min = vector(bounds.min, 'bounds.min');
  const max = vector(bounds.max, 'bounds.max');
  for (let axis = 0; axis < 3; axis++) {
    if (min[axis]! > max[axis]!) {
      throw new ManifestValidationError('bounds', `min[${axis}] exceeds max[${axis}]`);
    }
  }
  if (!Array.isArray(source.animations)) {
    throw new ManifestValidationError('animations', 'expected an array');
  }
  const animations = Array.from(source.animations, (name: unknown, index: number) => text(name, `animations[${index}]`));
  if (!Array.isArray(source.levels) || source.levels.length === 0) {
    throw new ManifestValidationError('levels', 'expected at least one representation');
  }
  const identifiers = new Set<string>();
  let previousCoverage = -1;
  const levels = Array.from(source.levels, (value: unknown, index: number): AssetLevel => {
    const path = `levels[${index}]`;
    const level = record(value, path);
    const id = text(level.id, `${path}.id`);
    if (identifiers.has(id)) throw new ManifestValidationError(`${path}.id`, 'duplicate level id');
    identifiers.add(id);
    const coverage = level.minScreenCoverage;
    if (typeof coverage !== 'number' || !Number.isFinite(coverage) || coverage < 0 || coverage > 1) {
      throw new ManifestValidationError(`${path}.minScreenCoverage`, 'expected a number between 0 and 1');
    }
    if (coverage < previousCoverage) {
      throw new ManifestValidationError(`${path}.minScreenCoverage`, 'levels must be ordered from coarse to detailed');
    }
    previousCoverage = coverage;
    return {
      id,
      url: text(level.url, `${path}.url`),
      byteLength: byteCount(level.byteLength, `${path}.byteLength`),
      estimatedGpuBytes: byteCount(level.estimatedGpuBytes, `${path}.estimatedGpuBytes`),
      triangles: byteCount(level.triangles, `${path}.triangles`),
      minScreenCoverage: coverage,
    };
  });
  return {
    format: 'stream3d', version: 1,
    id: text(source.id, 'id'), name: text(source.name, 'name'),
    bounds: { min, max }, animations, levels,
  };
}

/** Resolve a level URL relative to the absolute URL of its manifest. */
export function resolveAssetUrl(url: string, manifestUrl: string): string {
  text(url, 'url');
  try {
    return new URL(url, manifestUrl).href;
  } catch {
    throw new TypeError(`Cannot resolve asset URL ${JSON.stringify(url)} against ${JSON.stringify(manifestUrl)}`);
  }
}
