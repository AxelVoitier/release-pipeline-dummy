// PROBE ONLY. Talks to the artifact service with the runtime token, the way @actions/artifact does:
//   CreateArtifact -> PUT the zip to the signed blob URL -> FinalizeArtifact(size, hash); DeleteArtifact.
// Written from @actions/artifact's client (packages/artifact/src/internal). If the service rejects a call because
// the protocol changed, read the current client source, adapt, and record the change in RESULTS.md.
// Never prints the token or the signed URL.
'use strict';
const fs = require('fs');

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] || '').trim();
const output = (key, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);

async function main() {
  const mode = input('mode');
  const tokenFile = input('token-file');
  const token = tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : process.env.ACTIONS_RUNTIME_TOKEN;
  const base = process.env.ACTIONS_RESULTS_URL;
  if (!token) throw new Error('no runtime token (ACTIONS_RUNTIME_TOKEN unset and no token-file)');
  if (!base) throw new Error('ACTIONS_RESULTS_URL unset');

  if (mode === 'save-token') {
    fs.writeFileSync(input('file'), token, { mode: 0o600 });
    console.log('runtime token written to the file (not printed)');
    return;
  }

  // The run/job backend IDs the service expects are in the token's scp claim: "Actions.Results:<run>:<job>".
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const scope = String(claims.scp || '').split(' ').find((s) => s.startsWith('Actions.Results:'));
  if (!scope) throw new Error('no Actions.Results scope in the runtime token');
  const [, runBackendId, jobBackendId] = scope.split(':');
  const exp = new Date(claims.exp * 1000).toISOString();
  console.log(`token: issued ${new Date(claims.iat * 1000).toISOString()}, expires ${exp}, job backend ${jobBackendId}`);
  output('token-exp', exp);
  if (mode === 'token-info') return;

  const ids = { workflowRunBackendId: runBackendId, workflowJobRunBackendId: jobBackendId };
  const call = async (method, body) => {
    const url = new URL(`twirp/github.actions.results.api.v1.ArtifactService/${method}`, base);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(`${method} returned invalid JSON with HTTP ${res.status}`);
    }
    // Raw Twirp JSON uses snake_case; redact signed URLs before logging either form.
    const safe = JSON.stringify(result, (key, value) => /signed.*url/i.test(key) ? '<redacted>' : value);
    console.log(`${method}: HTTP ${res.status} ${safe}`);
    if (!res.ok) throw new Error(`${method} failed with HTTP ${res.status}`);
    return result;
  };

  const name = input('name');
  if (mode === 'upload') {
    const data = fs.readFileSync(input('file'));
    const created = await call('CreateArtifact', { ...ids, name, version: 4 });
    const uploadUrl = created.signed_upload_url ?? created.signedUploadUrl;
    if (typeof uploadUrl !== 'string' || !uploadUrl) throw new Error('CreateArtifact returned no signed upload URL');
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob' },
      body: data,
    });
    console.log(`blob PUT: HTTP ${put.status}`);
    if (!put.ok) throw new Error(`blob upload failed with HTTP ${put.status}`);
    const finalized = await call('FinalizeArtifact', {
      ...ids, name, size: String(data.length), hash: `sha256:${input('sha256')}`,
    });
    output('artifact-id', finalized.artifact_id ?? finalized.artifactId);
  } else if (mode === 'delete') {
    await call('DeleteArtifact', { ...ids, name });
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
}

main().catch((e) => {
  console.log(`::error::${e.message}`);
  process.exit(1);
});
