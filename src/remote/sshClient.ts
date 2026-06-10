/** Thin client for the companion server's SSH API (see server/index.mjs). */

export interface SshConnectParams {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshSession {
  sessionId: string;
  label: string;
  home: string;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error(
      "サーバーに接続できません。`npm run server` で同梱サーバーを起動してください。"
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export function sshConnect(params: SshConnectParams): Promise<SshSession> {
  return call<SshSession>("/api/ssh/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

export function sshDisconnect(sessionId: string): Promise<void> {
  return call("/api/ssh/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

export async function sshScan(sessionId: string, path: string): Promise<string[]> {
  const r = await call<{ files: string[] }>(
    `/api/ssh/scan?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
  );
  return r.files;
}

export async function sshRead(sessionId: string, path: string): Promise<string> {
  const r = await call<{ content: string }>(
    `/api/ssh/read?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
  );
  return r.content;
}

export function sshWrite(sessionId: string, path: string, content: string): Promise<void> {
  return call("/api/ssh/write", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, path, content }),
  });
}
