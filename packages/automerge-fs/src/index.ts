export { AutomergeFs, normalizePath, joinPath, type StatInfo, type DirEntry } from "./fs.ts"
export { type BlobStore, InMemoryBlobStore } from "./blob-store.ts"
export {
  FileHandlerRegistry,
  type FileHandler,
  type TypedDoc,
  type FileHandlerLens,
  applyLenses,
  formatDocType,
  parseDocType,
  textFileHandler,
  type TextFileDoc,
  type BlobFileDoc,
} from "./file-handlers/index.ts"
