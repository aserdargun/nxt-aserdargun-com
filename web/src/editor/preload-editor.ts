// Fetch editor code while the authorized owner's vault is loading. Failed
// speculative imports are handled here; normal lazy loading can still retry.
export const preloadEditor = (): void => {
  void Promise.all([
    import("./editor-workspace"),
    import("./markdown-editor"),
    import("./markdown-preview")
  ]).catch(() => undefined);
};
