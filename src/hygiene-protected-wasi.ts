import { WASI } from "node:wasi";
import { compareCodeUnits } from "./code-unit-order.ts";

const WASI_REACTOR = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 4, 1, 96, 0, 0,
  3, 2, 1, 0,
  5, 3, 1, 0, 3,
  7, 24, 2, 6, 109, 101, 109, 111, 114, 121, 2, 0, 11, 95, 105, 110, 105, 116, 105, 97, 108, 105, 122, 101, 0, 0,
  10, 4, 1, 2, 0, 11,
]);
const PREOPEN_FD = 3;
const STAT_PTR = 0;
const OPENED_FD_PTR = 64;
const BUFFER_USED_PTR = 68;
const PATH_PTR = 128;
const PATH_MAX_BYTES = 8_192;
const DIRECTORY_BUFFER_PTR = 16_384;
const DIRECTORY_BUFFER_BYTES = 65_536;
const DIRECTORY_OFLAG = 2;
const DIRECTORY_RIGHTS = (1n << 13n) | (1n << 14n) | (1n << 18n) | (1n << 21n);

export const WASI_DIRECTORY_FILE_TYPE = 3;

export type WasiFileStat = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly fileType: number;
  readonly size: number;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
};

export type WasiDirectoryEntry = {
  readonly name: string;
  readonly inode: bigint;
};

type DirectoryListing = {
  readonly entries: readonly WasiDirectoryEntry[];
  readonly truncated: boolean;
};

type WasiCallName = "fd_close" | "fd_filestat_get" | "fd_readdir" | "path_filestat_get" | "path_open";
type WasiImportTable = { readonly [name in WasiCallName]?: unknown };

function invokeWasi(imports: WasiImportTable, name: WasiCallName, args: readonly (number | bigint)[]): number {
  const candidate: unknown = Reflect.get(imports, name);
  if (typeof candidate !== "function") throw new Error(`WASI syscall is unavailable: ${name}`);
  const result: unknown = Reflect.apply(candidate, undefined, args);
  if (typeof result !== "number") throw new Error(`WASI syscall returned an invalid result: ${name}`);
  return result;
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Protected inventory ${label} exceeds the safe numeric range`);
  return Number(value);
}

function sameEntry(left: WasiDirectoryEntry, right: WasiDirectoryEntry): boolean {
  return left.name === right.name && left.inode === right.inode;
}

export class WasiDirectoryReader {
  readonly #imports: WasiImportTable;
  readonly #memory: WebAssembly.Memory;
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(repoRoot: string) {
    const wasi = new WASI({ version: "preview1", preopens: { "/repo": repoRoot } });
    const module = new WebAssembly.Module(WASI_REACTOR);
    const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport });
    wasi.initialize(instance);
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("Protected inventory WASI memory is unavailable");
    this.#imports = wasi.wasiImport;
    this.#memory = memory;
    this.#view = new DataView(memory.buffer);
    this.#bytes = new Uint8Array(memory.buffer);
  }

  rootFd(): number {
    return PREOPEN_FD;
  }

  stat(fd: number): WasiFileStat {
    this.#call("fd_filestat_get", [fd, STAT_PTR]);
    return this.#readStat();
  }

  statAt(fd: number, name: string): WasiFileStat {
    const length = this.#writePath(name);
    this.#call("path_filestat_get", [fd, 0, PATH_PTR, length, STAT_PTR]);
    return this.#readStat();
  }

  openDirectoryAt(fd: number, name: string): number {
    const length = this.#writePath(name);
    this.#call("path_open", [fd, 0, PATH_PTR, length, DIRECTORY_OFLAG, DIRECTORY_RIGHTS, DIRECTORY_RIGHTS, 0, OPENED_FD_PTR]);
    return this.#view.getUint32(OPENED_FD_PTR, true);
  }

  close(fd: number): void {
    if (fd !== PREOPEN_FD) this.#call("fd_close", [fd]);
  }

  readDirectory(fd: number, limit: number): DirectoryListing {
    const selected: WasiDirectoryEntry[] = [];
    let cookie = 0n;
    let complete = false;
    while (selected.length <= limit && !complete) {
      this.#call("fd_readdir", [fd, DIRECTORY_BUFFER_PTR, DIRECTORY_BUFFER_BYTES, cookie, BUFFER_USED_PTR]);
      const used = this.#view.getUint32(BUFFER_USED_PTR, true);
      if (used === 0) {
        complete = true;
        break;
      }
      const end = DIRECTORY_BUFFER_PTR + used;
      let offset = DIRECTORY_BUFFER_PTR;
      let advanced = false;
      while (offset + 24 <= end) {
        const next = this.#view.getBigUint64(offset, true);
        const inode = this.#view.getBigUint64(offset + 8, true);
        const nameLength = this.#view.getUint32(offset + 16, true);
        const nameStart = offset + 24;
        const nameEnd = nameStart + nameLength;
        if (nameEnd > end) break;
        const name = this.#decoder.decode(this.#bytes.subarray(nameStart, nameEnd));
        cookie = next;
        advanced = true;
        offset = nameEnd;
        if (name !== "." && name !== "..") selected.push({ name, inode });
        if (selected.length > limit) break;
      }
      if (!advanced) throw new Error("Protected inventory directory enumeration did not advance");
    }
    const entries = selected.slice(0, limit).sort((left, right) => compareCodeUnits(left.name, right.name));
    return { entries, truncated: !complete || selected.length > limit };
  }

  sameListing(left: DirectoryListing, right: DirectoryListing): boolean {
    return left.truncated === right.truncated && left.entries.length === right.entries.length && left.entries.every((entry, index) => sameEntry(entry, right.entries[index] ?? entry));
  }

  #call(name: WasiCallName, args: readonly (number | bigint)[]): void {
    const errno = invokeWasi(this.#imports, name, args);
    if (errno !== 0) throw new Error(`Protected inventory WASI ${name} failed with errno ${errno}`);
  }

  #writePath(value: string): number {
    const encoded = this.#encoder.encode(value);
    if (encoded.length === 0 || encoded.length > PATH_MAX_BYTES) throw new Error("Protected inventory path component has an invalid encoded length");
    this.#bytes.set(encoded, PATH_PTR);
    return encoded.length;
  }

  #readStat(): WasiFileStat {
    return {
      device: this.#view.getBigUint64(STAT_PTR, true),
      inode: this.#view.getBigUint64(STAT_PTR + 8, true),
      fileType: this.#view.getUint8(STAT_PTR + 16),
      size: safeNumber(this.#view.getBigUint64(STAT_PTR + 32, true), "byte count"),
      modifiedNs: this.#view.getBigUint64(STAT_PTR + 48, true),
      changedNs: this.#view.getBigUint64(STAT_PTR + 56, true),
    };
  }
}
