// Branch metadata management for Kunj CLI

import * as fs from 'fs';
import * as path from 'path';
import { BranchesMetadata, BranchMetadata } from '../types';
import { getKunjDir, initKunjDirectory } from './config';
import { BRANCHES_FILE } from '../constants';

// Helper function to get branches metadata file path
export function getBranchesPath(): string {
  return path.join(getKunjDir(), BRANCHES_FILE);
}

// Load branch metadata
export function loadBranchMetadata(): BranchesMetadata {
  try {
    initKunjDirectory();
    const branchesPath = getBranchesPath();
    if (fs.existsSync(branchesPath)) {
      const data = fs.readFileSync(branchesPath, 'utf8');
      return JSON.parse(data);
    }
    return { branches: {} };
  } catch {
    return { branches: {} };
  }
}

// Save branch metadata
export function saveBranchMetadata(metadata: BranchesMetadata): void {
  try {
    initKunjDirectory();
    const branchesPath = getBranchesPath();
    fs.writeFileSync(branchesPath, JSON.stringify(metadata, null, 2));
  } catch (error) {
    console.error('Failed to save branch metadata:', error);
  }
}

// Get metadata for a specific branch
export function getBranchMetadataItem(branch: string): BranchMetadata {
  const metadata = loadBranchMetadata();
  return metadata.branches[branch] || {};
}

// Update metadata for a specific branch
export function updateBranchMetadata(branch: string, updates: Partial<BranchMetadata>): void {
  const metadata = loadBranchMetadata();
  if (!metadata.branches[branch]) {
    metadata.branches[branch] = {};
  }
  metadata.branches[branch] = { ...metadata.branches[branch], ...updates };
  saveBranchMetadata(metadata);
}