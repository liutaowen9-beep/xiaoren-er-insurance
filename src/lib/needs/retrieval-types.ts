import { z } from 'zod';
export const retrievalDiagnosticSchema=z.object({
  query:z.string().min(1).max(2000),library:z.string().regex(/^local-[a-f0-9]{12}$/),
  eligibleDocuments:z.number().int().nonnegative(),documents:z.number().int().min(0).max(5),chunks:z.number().int().min(0).max(5),
  hits:z.array(z.object({name:z.string().max(255),version:z.number().int().positive(),chunks:z.number().int().positive()}).strict()).max(5),
  methods:z.array(z.enum(['vector','keyword','document-name','custom'])).max(4),reason:z.string().max(300),
}).strict();
export type RetrievalDiagnostic=z.infer<typeof retrievalDiagnosticSchema>;
