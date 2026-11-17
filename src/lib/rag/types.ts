export type DocumentStatus = 'queued' | 'parsing' | 'chunking' | 'embedding' | 'indexing' | 'ready' | 'failed';
export type DocumentState = 'active' | 'inactive' | 'archived';
export type KnowledgeDocument = { id: string; name: string; extension: string; size: number; hash: string; status: DocumentStatus; chunkCount: number; createdAt: number; error: string | null; model: string | null; dimension: number | null; logicalId?: string; version?: number; state?: DocumentState; revision?: number; updatedAt?: number; isCurrent?: boolean; replacement?: { id: string; version: number; status: DocumentStatus; error: string | null } };
export type TextSection = { text: string; page?: number; title?: string };
export type TextChunk = TextSection & { id: string; documentId: string; sequence: number };
export type Source = { number: number; documentId: string; chunkId: string; fileName: string; text: string; page?: number; title?: string; score: number; kind?: 'document'; version?: number; state?: DocumentState; isCurrent?: boolean };
