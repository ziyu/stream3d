declare module '*.glb?asset' {
  const manifest: import('@stream3d/core').AssetManifest;
  /** URL of the deployable JSON manifest, for runtime loading or sharing. */
  export const manifestUrl: string;
  export default manifest;
}

declare module '*.gltf?asset' {
  const manifest: import('@stream3d/core').AssetManifest;
  export const manifestUrl: string;
  export default manifest;
}
