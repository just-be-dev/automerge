// workerd doesn't expose FinalizationRegistry (Cloudflare disables APIs that
// would make GC observable). The @automerge/automerge wasm bindings reference
// it at module-init time, so stub it out before anything else loads. DOs are
// GC'd at the isolate level, so dropping the finalizer callbacks is safe.
if (typeof (globalThis as { FinalizationRegistry?: unknown }).FinalizationRegistry === "undefined") {
  ;(globalThis as { FinalizationRegistry: unknown }).FinalizationRegistry = class {
    register(): void {}
    unregister(): void {}
  }
}
