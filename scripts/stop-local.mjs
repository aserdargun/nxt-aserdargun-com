import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stopControlledStack } from "./stop-local-core.mjs";

const checkoutPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await stopControlledStack({ checkoutPath });
process.stdout.write(result.status === "idle" ? "NXT local stack is already stopped.\n" : "Stopped the checkout-owned NXT local stack.\n");
