import { z } from 'zod';

export const resultSchema = z.enum(['PASS', 'FAIL', 'WARNING', 'UNKNOWN']);
export type QualityCheck = { rule: string; name: string; objectId: string; documentName: string | null; result: z.infer<typeof resultSchema>; reason: string; suggestion: string; checkedAt: number };
export type Asset = { id: string; state: string; currentVersionId: string | null; revision: number; createdAt: number; updatedAt: number };
export type Version = { id: string; logicalId: string; version: number; name: string; extension: string; size: number; hash: string; actualHash: string; status: string; chunkCount: number; vectorCount: number; declaredChunks: number; model: string | null; dimension: number | null; createdAt: number; isCurrent: boolean };
export type Member = { id: string; documentId: string; sequence: number; page: number | null; textHash: string; vectorHash: string; model: string; dimension: number; contentEmpty?:boolean };
export type Manifest = { format: 1; libraryId: string; schema: number; embedding: { model: string; dimension: number }; assets: Asset[]; versions: Version[]; members: Member[]; qualityMetrics?:{orphanChunks:number} };
export type Scan = { manifest: Manifest; checks: QualityCheck[]; capturedAt: number; fingerprint: string };
const boundedId=z.string().min(1).max(128), digest=z.union([z.string().regex(/^[a-f0-9]{64}$/),z.literal('UNKNOWN')]), integer=z.number().int().safe();
const assetSchema=z.object({id:boundedId,state:z.string().max(32),currentVersionId:boundedId.nullable(),revision:integer,createdAt:integer,updatedAt:integer}).strict();
const versionSchema=z.object({id:boundedId,logicalId:boundedId,version:integer,name:z.string().max(512),extension:z.string().max(32),size:integer,hash:z.string().max(128),actualHash:digest,status:z.string().max(32),chunkCount:integer,vectorCount:integer,declaredChunks:integer,model:z.string().max(512).nullable(),dimension:integer.nullable(),createdAt:integer,isCurrent:z.boolean()}).strict();
const memberSchema=z.object({id:boundedId,documentId:boundedId,sequence:integer,page:integer.nullable(),textHash:digest,vectorHash:digest,model:z.string().max(512),dimension:integer,contentEmpty:z.boolean().optional()}).strict();
export const manifestSchema=z.object({format:z.literal(1),libraryId:z.uuid(),schema:z.literal(1),embedding:z.object({model:z.string().max(512),dimension:integer}).strict(),assets:z.array(assetSchema).max(1000),versions:z.array(versionSchema).max(5000),members:z.array(memberSchema).max(20000),qualityMetrics:z.object({orphanChunks:integer.nonnegative()}).strict().optional()}).strict();
export const qualitySchema=z.object({rule:z.string().max(64),name:z.string().max(128),objectId:boundedId,documentName:z.string().max(512).nullable(),result:resultSchema,reason:z.string().max(1024),suggestion:z.string().max(1024),checkedAt:integer}).strict();
export type Snapshot = { id: string; sourceId: string; createdAt: number; hash: string; changed: boolean; counts: { assets: number; versions: number; chunks: number; vectors: number; active: number }; manifest: Manifest };
export class PlatformError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), search: z.string().max(120).default(''), state: z.enum(['all','active','inactive','archived','missing']).default('all'), sort: z.enum(['name','createdAt','updatedAt']).default('updatedAt'), order: z.enum(['asc','desc']).default('desc'), result: z.enum(['all','PASS','FAIL','WARNING','UNKNOWN']).default('all') }).strict();
export const scanInput = z.object({ snapshot: z.literal(true).default(true) }).strict();
export type PageQuery = z.infer<typeof pageSchema>;
