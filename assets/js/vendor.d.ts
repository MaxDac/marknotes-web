declare module "phoenix_live_view" {
  export class LiveSocket {
    constructor(
      path: string,
      socket: unknown,
      options: Record<string, unknown>,
    );
    connect(): void;
  }
}
declare module "markdown-it-task-lists" {
  import type { PluginSimple } from "markdown-it";
  const plugin: PluginSimple;
  export default plugin;
}
