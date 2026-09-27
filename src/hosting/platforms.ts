/**
 * Reconhecimento de remotos do Bitbucket (Cloud e Server/Data Center) e do Azure DevOps (Services e
 * Server). Só tipos vêm de core.ts, para não criar dependência circular em tempo de execução.
 */
import type { HostKind, RemoteInfo } from './core';

export const HOST_LABEL: Record<HostKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azure: 'Azure DevOps',
};

export function hostLabel(kind: HostKind): string {
  return HOST_LABEL[kind] ?? kind;
}

/** Entrada da configuração ("git.empresa.com" ou "https://git.empresa.com:8443/bitbucket") → nome e endereço web. */
function entry(e: string): { host: string; webBase: string } | undefined {
  const s = e.trim();
  if (!s) return undefined;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    return { host: u.hostname.toLowerCase(), webBase: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
  } catch {
    return undefined;
  }
}

interface Parsed {
  scheme: string;
  host: string;
  /** Origem web (esquema + host + porta) quando o remoto é http(s). */
  origin?: string;
  path: string;
}

function split(url: string): Parsed | undefined {
  const t = url.trim();
  const scp = /^(?:[^@\s]+@)?([^:\s/]+):(?!\/)(.+)$/.exec(t);
  if (scp && !/^[a-z]+:\/\//i.test(t)) return { scheme: 'ssh', host: scp[1].toLowerCase(), path: scp[2] };
  try {
    const u = new URL(t);
    const web = u.protocol === 'http:' || u.protocol === 'https:';
    return { scheme: u.protocol.replace(/:$/, ''), host: u.hostname.toLowerCase(), origin: web ? `${u.protocol}//${u.host}` : undefined, path: decodeURIComponent(u.pathname) };
  } catch {
    return undefined;
  }
}

const clean = (p: string) => p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');

/**
 * Azure DevOps:
 *  - https://[user@]dev.azure.com/{org}/{project}/_git/{repo}
 *  - https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
 *  - git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 *  - {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 *  - Server: https://tfs.empresa.com/tfs/{collection}/{project}/_git/{repo} (host em azureDevOps.hosts)
 */
function parseAzure(p: Parsed, hosts: { host: string; webBase: string }[]): RemoteInfo | undefined {
  const path = clean(p.path);
  const segs = path.split('/').filter(Boolean);
  const configured = hosts.find(h => h.host === p.host);
  if (p.scheme === 'ssh' && (p.host === 'ssh.dev.azure.com' || p.host.endsWith('vs-ssh.visualstudio.com'))) {
    // v3/{org}/{project}/{repo}
    if (segs[0] !== 'v3' || segs.length < 4) return undefined;
    const [, org, project, repo] = segs;
    const collection = p.host === 'ssh.dev.azure.com' ? `https://dev.azure.com/${org}` : `https://${org}.visualstudio.com`;
    return azureInfo(collection, org, project, repo);
  }
  const git = segs.indexOf('_git');
  if (git < 1 || git + 1 >= segs.length) return undefined;
  const project = segs[git - 1];
  const repo = segs[git + 1];
  const before = segs.slice(0, git - 1);
  if (p.host === 'dev.azure.com') {
    if (!before[0]) return undefined;
    return azureInfo(`https://dev.azure.com/${before[0]}`, before[0], project, repo);
  }
  if (p.host.endsWith('.visualstudio.com')) {
    const org = p.host.split('.')[0];
    // DefaultCollection (e similares) no caminho é opcional
    const coll = before.length ? `https://${p.host}/${before.join('/')}` : `https://${p.host}`;
    return azureInfo(coll, org, project, repo);
  }
  if (configured || p.origin) {
    // Server: tudo antes de {project}/_git é a coleção (ex.: /tfs/DefaultCollection)
    const origin = configured ? new URL(configured.webBase).origin : p.origin!;
    const collection = `${origin}/${before.join('/')}`.replace(/\/+$/, '');
    return azureInfo(collection, before[before.length - 1] ?? p.host, project, repo, 'server', p.host);
  }
  return undefined;
}

function azureInfo(collection: string, org: string, project: string, repo: string, flavor: 'cloud' | 'server' = 'cloud', host?: string): RemoteInfo {
  const h = host ?? new URL(collection).hostname.toLowerCase();
  return {
    kind: 'azure',
    host: h,
    webBase: collection,
    projectPath: `${org}/${project}/${repo}`,
    flavor,
    apiRoot: collection,
    azure: { collection, organization: org, project, repo },
  };
}

/**
 * Bitbucket:
 *  - Cloud: https://[user@]bitbucket.org/{workspace}/{repo}.git, git@bitbucket.org:{workspace}/{repo}.git
 *  - Server/Data Center: https://host[/contexto]/scm/{PROJ}/{repo}.git, ssh://git@host:7999/{proj}/{repo}.git
 */
function parseBitbucket(p: Parsed, hosts: { host: string; webBase: string }[]): RemoteInfo | undefined {
  const path = clean(p.path);
  if (p.host === 'bitbucket.org') {
    const [ws, repo] = path.split('/');
    if (!ws || !repo) return undefined;
    return { kind: 'bitbucket', host: p.host, webBase: 'https://bitbucket.org', projectPath: `${ws}/${repo}`, flavor: 'cloud', apiRoot: 'https://api.bitbucket.org/2.0' };
  }
  const configured = hosts.find(h => h.host === p.host);
  if (!configured && !/(^|[.-])bitbucket([.-]|$)/.test(p.host)) return undefined;
  const segs = path.split('/').filter(Boolean);
  const scm = segs.indexOf('scm');
  let project: string | undefined;
  let repo: string | undefined;
  let webBase: string;
  if (scm >= 0) {
    [project, repo] = [segs[scm + 1], segs[scm + 2]];
    webBase = configured?.webBase ?? `${p.origin ?? `https://${p.host}`}${segs.length > 0 && scm > 0 ? '/' + segs.slice(0, scm).join('/') : ''}`;
  } else {
    [project, repo] = segs.slice(-2);
    webBase = configured?.webBase ?? p.origin ?? `https://${p.host}`;
  }
  if (!project || !repo) return undefined;
  return {
    kind: 'bitbucket',
    host: p.host,
    webBase,
    projectPath: `${project.toUpperCase()}/${repo}`,
    flavor: 'server',
    apiRoot: `${webBase}/rest/api/1.0`,
  };
}

/** Remoto do Bitbucket ou do Azure DevOps; undefined para qualquer outro (GitHub/GitLab ficam no core). */
export function parsePlatformRemote(url: string, bitbucketHosts: string[] = [], azureHosts: string[] = []): RemoteInfo | undefined {
  const p = split(url);
  if (!p) return undefined;
  const az = azureHosts.map(entry).filter(Boolean) as { host: string; webBase: string }[];
  const bb = bitbucketHosts.map(entry).filter(Boolean) as { host: string; webBase: string }[];
  const isAzure =
    p.host === 'dev.azure.com' ||
    p.host === 'ssh.dev.azure.com' ||
    p.host.endsWith('.visualstudio.com') ||
    az.some(h => h.host === p.host) ||
    /\/_git\//.test(p.path);
  if (isAzure) return parseAzure(p, az);
  return parseBitbucket(p, bb);
}
