import type { Task7Services } from "../functions/private-api.js";
import { PublicationService, PublicPublicationReader } from "./publication-service.js";
export interface Task9Services {
    publications: PublicationService;
    reader: PublicPublicationReader;
}
export declare const resolveTask7Services: () => Task7Services;
export declare const resolveTask9Services: () => Task9Services;
//# sourceMappingURL=runtime-services.d.ts.map