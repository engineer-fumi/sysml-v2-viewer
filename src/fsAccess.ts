/**
 * Local file loading/saving helpers.
 *
 * Uses the File System Access API (Chrome/Edge) when available so files can
 * be written back in place; falls back to <input type="file"> + download
 * elsewhere.
 */

export const SYSML_EXT = /\.(sysml|kerml)$/i;

export interface LoadedFile {
  /** display name – relative path within the picked folder when available */
  name: string;
  source: string;
  /** present when the browser gave us a writable handle */
  handle?: FileSystemFileHandle;
}

export const supportsFSAccess =
  typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);

async function scanDirectory(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: LoadedFile[],
  depth: number
): Promise<void> {
  if (depth > 8 || out.length > 300) return;
  for await (const entry of dir.values()) {
    if (entry.kind === "file") {
      if (SYSML_EXT.test(entry.name)) {
        const fh = entry as FileSystemFileHandle;
        const file = await fh.getFile();
        out.push({ name: prefix + entry.name, source: await file.text(), handle: fh });
      }
    } else if (entry.kind === "directory") {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      await scanDirectory(entry as FileSystemDirectoryHandle, prefix + entry.name + "/", out, depth + 1);
    }
  }
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/** Pick individual files. Returns [] if the user cancels. */
export async function pickFiles(): Promise<LoadedFile[] | null> {
  if (!window.showOpenFilePicker) return null; // caller should fall back
  try {
    const handles = await window.showOpenFilePicker({
      multiple: true,
      types: [
        { description: "SysML v2", accept: { "text/plain": [".sysml", ".kerml"] } },
      ],
    });
    const out: LoadedFile[] = [];
    for (const h of handles) {
      const f = await h.getFile();
      out.push({ name: h.name, source: await f.text(), handle: h });
    }
    return out;
  } catch (e) {
    if (isAbort(e)) return [];
    throw e;
  }
}

/** Pick a folder and recursively collect .sysml files (with handles). */
export async function pickDirectory(): Promise<LoadedFile[] | null> {
  if (!window.showDirectoryPicker) return null; // caller should fall back
  try {
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    const out: LoadedFile[] = [];
    await scanDirectory(dir, "", out, 0);
    return out;
  } catch (e) {
    if (isAbort(e)) return [];
    throw e;
  }
}

/** Resolve dropped items to handles when the browser supports it. */
export async function filesFromDrop(dt: DataTransfer): Promise<LoadedFile[]> {
  const out: LoadedFile[] = [];

  // collect handle promises synchronously (required by the API)
  const handlePromises: Promise<FileSystemHandle | null>[] = [];
  let useHandles = false;
  for (const item of [...dt.items]) {
    if (typeof item.getAsFileSystemHandle === "function") {
      useHandles = true;
      handlePromises.push(item.getAsFileSystemHandle());
    }
  }

  if (useHandles) {
    for (const p of handlePromises) {
      const h = await p.catch(() => null);
      if (!h) continue;
      if (h.kind === "file") {
        if (SYSML_EXT.test(h.name)) {
          const fh = h as FileSystemFileHandle;
          const f = await fh.getFile();
          out.push({ name: fh.name, source: await f.text(), handle: fh });
        }
      } else {
        await scanDirectory(h as FileSystemDirectoryHandle, h.name + "/", out, 0);
      }
    }
    return out;
  }

  // fallback: webkitGetAsEntry traversal (no writable handles)
  const readEntries = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
    new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
  const fileOf = (entry: FileSystemFileEntry): Promise<File | null> =>
    new Promise((resolve) => entry.file(resolve, () => resolve(null)));

  const visit = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      if (SYSML_EXT.test(entry.name)) {
        const f = await fileOf(entry as FileSystemFileEntry);
        if (f) out.push({ name: prefix + entry.name, source: await f.text() });
      }
    } else if (entry.isDirectory) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) return;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await readEntries(reader);
        if (!batch.length) break;
        for (const e of batch) await visit(e, prefix + entry.name + "/");
      }
    }
  };

  const entries = [...dt.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length) {
    for (const e of entries) {
      if (e.isFile) await visit(e, "");
      else await visit(e, "");
    }
  } else {
    for (const f of [...dt.files]) {
      if (SYSML_EXT.test(f.name)) out.push({ name: f.name, source: await f.text() });
    }
  }
  return out;
}

/** Write content back through a handle (asking for permission if needed). */
export async function writeToHandle(handle: FileSystemFileHandle, content: string): Promise<void> {
  if (handle.requestPermission) {
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") throw new Error("書き込み許可が得られませんでした");
  }
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

/** Download fallback. */
export function downloadFile(name: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name.split("/").pop() ?? name;
  a.click();
  URL.revokeObjectURL(a.href);
}
