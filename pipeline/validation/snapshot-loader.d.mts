export type ApprovedSnapshotManifest = { version: 1; files: string[]; [key: string]: unknown }
export type LoadedApprovedSnapshot<T = unknown> = { file: string; path: string; snapshot: T }
export const APPROVED_SNAPSHOT_MANIFEST: string
export function validateApprovedSnapshotManifest(value: unknown, label?: string): asserts value is ApprovedSnapshotManifest
export function validateApprovedSnapshotIdentity(value: unknown, file: string, label?: string): void
export function loadApprovedSnapshots<T = unknown>(repoRoot: string): Array<LoadedApprovedSnapshot<T>>
