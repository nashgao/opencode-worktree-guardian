import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { errorCode } from "./types.ts";

export async function assertNotSymlink(filePath: string, label: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error(`Refusing guardian ${label} symlink: ${filePath}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensureDurableDirectory(directory: string): Promise<void> {
  await assertNotSymlink(directory, "metadata directory");
  const created = await fs.mkdir(directory, { recursive: true });
  await assertNotSymlink(directory, "metadata directory");
  if (created !== undefined) await syncDirectory(path.dirname(created));
}

export async function removeDurable(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export async function writeDurableTemp(directory: string, name: string, content: string): Promise<string> {
  await ensureDurableDirectory(directory);
  const filePath = path.join(directory, name);
  await assertNotSymlink(filePath, "temporary metadata");
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
  return filePath;
}

export async function writeDurableAtomic(targetPath: string, temporaryDirectory: string, content: string): Promise<void> {
  await ensureDurableDirectory(path.dirname(targetPath));
  await assertNotSymlink(targetPath, "metadata");
  const temporaryPath = await writeDurableTemp(temporaryDirectory, `artifact-${process.pid}-${crypto.randomUUID()}.tmp`, content);
  try {
    await fs.rename(temporaryPath, targetPath);
    await syncDirectory(path.dirname(targetPath));
    if (path.dirname(temporaryPath) !== path.dirname(targetPath)) await syncDirectory(path.dirname(temporaryPath));
  } catch (error) {
    await removeDurable(temporaryPath);
    throw error;
  }
}

export async function writeDurableCreate(targetPath: string, temporaryDirectory: string, content: string): Promise<void> {
  await ensureDurableDirectory(path.dirname(targetPath));
  await assertNotSymlink(targetPath, "metadata");
  const temporaryPath = await writeDurableTemp(temporaryDirectory, `artifact-${process.pid}-${crypto.randomUUID()}.tmp`, content);
  try {
    await fs.link(temporaryPath, targetPath);
    await syncDirectory(path.dirname(targetPath));
    await removeDurable(temporaryPath);
  } catch (error) {
    await removeDurable(temporaryPath);
    throw error;
  }
}

export async function appendDurable(filePath: string, content: string): Promise<void> {
  await ensureDurableDirectory(path.dirname(filePath));
  await assertNotSymlink(filePath, "metadata");
  const handle = await fs.open(filePath, "a", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}
