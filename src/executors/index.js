import { LocalExecutor } from "./local.js";
import { DockerExecutor } from "./docker.js";

export function createExecutor(kind = process.env.HUB_EXECUTOR || "local") {
  if (kind === "docker") return new DockerExecutor();
  return new LocalExecutor();
}
