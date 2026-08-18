// Minimal type surface for the ops plugin (plain-JS package).
export declare const name = 'dsh-harness-ops'
export declare const inject: string[]
export declare const Config: any
export declare function apply(ctx: any, config: any): Promise<void>
export default { name: typeof name, inject: typeof inject, Config: typeof Config, apply: typeof apply }
