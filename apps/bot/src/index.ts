import "dotenv/config";

import { startBot } from "./discord-bot";

void startBot().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

