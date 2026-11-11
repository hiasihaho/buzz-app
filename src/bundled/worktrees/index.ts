import type { PluginModule } from "../../plugins/api";
import { createWorktrees } from "./service";

export const inject = ["host"];

export const apply: PluginModule["apply"] = (ctx) => {
  ctx.provide(
    "worktrees",
    createWorktrees(
      ctx.host.spawn && ctx.host.resolveDirectory
        ? {
            spawn: ctx.host.spawn.bind(ctx.host),
            resolveDirectory: ctx.host.resolveDirectory.bind(ctx.host),
          }
        : {},
      localStorage,
    ),
  );
};
