import * as path from 'path';
import { getOriginUrl, getRepoCommonRoot, getRepoName } from './config';
import { repoIdFromUrl } from './container/names';
import { stripUserinfo } from './container/seed';

export interface RepoIdentity {
  root: string;
  name: string;
  id: string;
  originUrl: string;
}

// Who this repository is, for names derived from it (containers, agent sessions)
export function repoIdentity(): RepoIdentity {
  const root = getRepoCommonRoot();
  if (!root) throw new Error('Not in a git repository');
  // Credentials in the remote URL stay on the host (seed.ts strips them too)
  const originUrl = stripUserinfo(getOriginUrl() || '');
  return { root, name: getRepoName() || path.basename(root), id: repoIdFromUrl(originUrl || root), originUrl };
}
