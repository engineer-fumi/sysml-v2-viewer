import { useState } from "react";
import { SshSession, sshConnect, sshRead, sshScan } from "../remote/sshClient";

export interface RemoteFile {
  /** absolute path on the remote host */
  path: string;
  /** display name relative to the scanned root */
  name: string;
  source: string;
}

interface Props {
  onClose: () => void;
  onLoaded: (session: SshSession, files: RemoteFile[]) => void;
}

export function SshDialog({ onClose, onLoaded }: Props) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [auth, setAuth] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const connect = async () => {
    setError("");
    setBusy(true);
    try {
      setStatus("接続中…");
      const session = await sshConnect({
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        password: auth === "password" ? password : undefined,
        privateKey: auth === "key" ? privateKey : undefined,
        passphrase: auth === "key" && passphrase ? passphrase : undefined,
      });
      const root = remotePath.trim() || session.home;
      setStatus(`${root} を走査中…`);
      const paths = await sshScan(session.sessionId, root);
      if (!paths.length) {
        setError(`${root} 以下に .sysml ファイルが見つかりませんでした`);
        setBusy(false);
        return;
      }
      const files: RemoteFile[] = [];
      const prefix = root.replace(/\/$/, "") + "/";
      for (let i = 0; i < paths.length; i++) {
        setStatus(`読み込み中 (${i + 1}/${paths.length}) ${paths[i]}`);
        const source = await sshRead(session.sessionId, paths[i]);
        files.push({
          path: paths[i],
          name: paths[i].startsWith(prefix) ? paths[i].slice(prefix.length) : paths[i],
          source,
        });
      }
      onLoaded(session, files);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setStatus("");
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">リモート接続 (SSH/SFTP)</div>

        <div className="form-row">
          <label>ホスト</label>
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com" autoFocus />
          <label className="short">ポート</label>
          <input className="port" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>

        <div className="form-row">
          <label>ユーザー名</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="user" />
        </div>

        <div className="form-row">
          <label>認証方式</label>
          <select value={auth} onChange={(e) => setAuth(e.target.value as "password" | "key")}>
            <option value="password">パスワード</option>
            <option value="key">秘密鍵</option>
          </select>
        </div>

        {auth === "password" ? (
          <div className="form-row">
            <label>パスワード</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && connect()}
            />
          </div>
        ) : (
          <>
            <div className="form-row">
              <label>秘密鍵</label>
              <textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;…"
                rows={5}
              />
            </div>
            <div className="form-row">
              <label>パスフレーズ</label>
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </div>
          </>
        )}

        <div className="form-row">
          <label>リモートパス</label>
          <input
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            placeholder="(空欄 = ホーム) 例: /home/user/project"
            onKeyDown={(e) => e.key === "Enter" && !busy && connect()}
          />
        </div>

        <div className="modal-note">
          指定パス以下の <code>.sysml</code> / <code>.kerml</code> を再帰的に読み込みます。
          認証情報は同梱サーバーが SSH 接続を開くためにのみ使用され、保存されません。
        </div>

        {status && !error && <div className="modal-status">{status}</div>}
        {error && <div className="modal-error">{error}</div>}

        <div className="modal-buttons">
          <button onClick={onClose} disabled={busy}>キャンセル</button>
          <button className="primary" onClick={connect} disabled={busy || !host.trim() || !username.trim()}>
            {busy ? "接続中…" : "接続して読み込み"}
          </button>
        </div>
      </div>
    </div>
  );
}
