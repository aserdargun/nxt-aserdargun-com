import { z } from "zod";
export declare const NoteIdSchema: z.ZodUUID;
export declare const TimestampSchema: z.ZodISODateTime;
export declare const NoteTitleSchema: z.ZodString;
export declare const NoteFrontmatterSchema: z.ZodObject<{
    id: z.ZodUUID;
    title: z.ZodString;
    created: z.ZodISODateTime;
    updated: z.ZodISODateTime;
    tags: z.ZodArray<z.ZodString>;
    aliases: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type NoteFrontmatter = z.infer<typeof NoteFrontmatterSchema>;
export declare const NoteDocumentSchema: z.ZodObject<{
    frontmatter: z.ZodObject<{
        id: z.ZodUUID;
        title: z.ZodString;
        created: z.ZodISODateTime;
        updated: z.ZodISODateTime;
        tags: z.ZodArray<z.ZodString>;
        aliases: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    body: z.ZodString;
}, z.core.$strict>;
export type NoteDocument = z.infer<typeof NoteDocumentSchema>;
//# sourceMappingURL=note.d.ts.map