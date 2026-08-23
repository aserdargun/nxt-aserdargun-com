import { z } from "zod";

const fold = (value: string): string => value.normalize("NFKC").toLocaleLowerCase("en-US");

const assertUniqueFoldedLists = (value: { tags: string[]; aliases: string[] }, context: z.RefinementCtx): void => {
  for (const key of ["tags", "aliases"] as const) {
    const seen = new Set<string>();
    value[key].forEach((item, index) => {
      const folded = fold(item);
      if (seen.has(folded)) {
        context.addIssue({ code: "custom", path: [key, index], message: `${key} must be unique` });
      }
      seen.add(folded);
    });
  }
};

export const NoteIdSchema = z.uuid();
export const TimestampSchema = z.iso.datetime({ offset: true });
export const NoteTitleSchema = z.string().trim().min(1).max(160);

export const NoteFrontmatterSchema = z
  .object({
    id: NoteIdSchema,
    title: NoteTitleSchema,
    created: TimestampSchema,
    updated: TimestampSchema,
    tags: z.array(z.string().trim().min(1).max(64)).max(64),
    aliases: z.array(z.string().trim().min(1).max(160)).max(64)
  })
  .strict()
  .superRefine(assertUniqueFoldedLists);

export type NoteFrontmatter = z.infer<typeof NoteFrontmatterSchema>;

export const NoteDocumentSchema = z
  .object({
    frontmatter: NoteFrontmatterSchema,
    body: z.string()
  })
  .strict();

export type NoteDocument = z.infer<typeof NoteDocumentSchema>;
