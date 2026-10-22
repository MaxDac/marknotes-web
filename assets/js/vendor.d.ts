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
  import type { MarkdownIt } from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}
