import { BrowserManager, type BrowserManagerOptions } from './manager.js'
import { BROWSER_DRIVER_SERVICE, type ZSevenBrowserDriver } from './driver-contract.js'
import { browserToolList, createBrowserTools, type StructuralToolDefinition } from './tools.js'

export * from './browser-discovery.js'
export * from './driver-contract.js'
export * from './manager.js'
export * from './risk.js'
export * from './semantic.js'
export * from './tools.js'

export const name = 'dsh-browser'
export const inject = ['tools']

export interface StructuralToolsService {
  register(tool: StructuralToolDefinition): () => void
}

export interface StructuralCordisContext {
  tools: StructuralToolsService
  effect(factory: () => void | (() => void), label?: string): () => void | Promise<void>
  on?(
    event: 'agent/disposed',
    listener: (payload: { agent?: { id?: unknown } }) => void | Promise<void>,
  ): () => void | Promise<void>
  provide(name: string, value: unknown): () => void | Promise<void>
  logger?: {
    info?(message: string): void
    warn?(message: string): void
  }
}

export interface MountBrowserOptions {
  manager?: ZSevenBrowserDriver
  managerOptions?: BrowserManagerOptions
}

export interface DshBrowserConfig {
  /** Exact navigation origins owned by the operator. Undefined is unrestricted; [] denies all web navigation. */
  allowedOrigins?: string[]
  /** Defaults to 15 minutes. Zero disables idle cleanup. */
  idleTimeoutMs?: number
}

/** Mount with dependency injection so the real Cordis lifecycle is unit-testable. */
export function mountBrowser(ctx: StructuralCordisContext, options: MountBrowserOptions = {}): () => Promise<void> {
  const manager = options.manager ?? new BrowserManager(options.managerOptions)
  const unprovide = ctx.provide(BROWSER_DRIVER_SERVICE, manager)
  const tools = browserToolList(createBrowserTools(manager))
  const disposers = tools.map((definition) => ctx.effect(
    () => ctx.tools.register(definition),
    `dsh-browser:${definition.name}`,
  ))
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('agent/disposed', async ({ agent }) => {
      const raw = agent?.id
      if (typeof raw !== 'string' || raw.trim() === '') return
      try {
        await manager.disposeScope(raw)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-browser could not dispose Agent scope ${raw}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
  }
  ctx.logger?.info?.(`dsh-browser mounted (${tools.map((tool) => tool.name).join(' + ')}; service: ${BROWSER_DRIVER_SERVICE})`)

  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    for (const dispose of [...disposers].reverse()) await dispose()
    await unprovide()
    await manager.dispose()
  }
}

export function apply(ctx: StructuralCordisContext, config: DshBrowserConfig = {}): () => Promise<void> {
  return mountBrowser(ctx, {
    managerOptions: {
      ...(config.allowedOrigins === undefined ? {} : { allowedOrigins: config.allowedOrigins }),
      ...(config.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: config.idleTimeoutMs }),
    },
  })
}
