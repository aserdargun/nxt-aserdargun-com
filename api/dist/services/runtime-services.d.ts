import type { Task7Services } from "../functions/private-api.js";
import { PublicationService, PublicPublicationReader } from "./publication-service.js";
export interface Task9Services {
    publications: PublicationService;
    reader: PublicPublicationReader;
}
export declare const resolveTask7Services: () => Promise<Task7Services>;
export declare const resolveTask9Services: () => Promise<Task9Services>;
//# sourceMappingURL=runtime-services.d.ts.map